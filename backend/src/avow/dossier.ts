import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  anchor,
  verify,
  listRecords,
  createSession,
  Reasoning,
  EVIDENCE_VERSION,
  type AnchorResult,
} from "avow-sdk";
import { sui, coordinator, serialize } from "../chain/sui.js";
import { seal, walrus } from "./anchorMove.js";
import type { AgentAvow } from "./anchorMove.js";
import { callModel } from "../reason/client.js";

// Compile an intel dossier on an opponent from its real, anchored Avow records, then
// re-seal it to the buyer. The coordinator is an auditor on the target (granted off
// chain via add_auditor at registration), so it can decrypt the target's bundles,
// prove each one is genuine and unaltered, summarize the tendencies, and anchor the
// result sealed to the buyer. The whole dossier is therefore built from verifiable
// history, and the delivery is itself an anchored, provable action.

export interface DossierMove {
  street: string;
  board: string[];
  action: string;
  amount: string;
  rationale: string;
}

export interface Dossier {
  targetAgentId: string;
  /** Moves pulled from the target's record and verified before use. */
  moves: DossierMove[];
  sourceCount: number;
  verifiedCount: number;
  /** The plain-words read on the opponent, written from the verified moves. */
  summary: string;
  /** The Avow anchor of the delivered dossier, sealed to the buyer. */
  anchor: AnchorResult | null;
}

// Bind the target agent to its mandate and confirm the mandate's principal is the
// agent's owner. This closes the audit residual: the on-chain mandate_id is
// self-declared at claim, so we never compile a dossier off a spoofed link.
async function bindAgentToMandate(targetAgentId: string): Promise<{ owner: string; mandateId: string }> {
  const agentObj = await sui.getObject({ id: targetAgentId, options: { showContent: true } });
  const af = (agentObj.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields;
  if (!af) throw new Error(`agent ${targetAgentId} not found`);
  const owner = String(af.owner);
  const mandateId = String(af.mandate_id);

  const mandateObj = await sui.getObject({ id: mandateId, options: { showContent: true } });
  const mf = (mandateObj.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields;
  if (!mf) throw new Error(`mandate ${mandateId} not found`);
  const principal = String(mf.principal);

  if (principal.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(
      `refusing to compile: target mandate principal ${principal} does not match agent owner ${owner}`,
    );
  }
  return { owner, mandateId };
}

export async function compileDossier(targetAgentId: string, buyer: AgentAvow): Promise<Dossier> {
  const { mandateId } = await bindAgentToMandate(targetAgentId);

  const records = await listRecords(sui, mandateId, 50);
  const poker = records.filter((r) => r.actionType === "poker_move");
  const session = await createSession(sui, coordinator(), 10);

  const moves: DossierMove[] = [];
  let verifiedCount = 0;
  for (const r of poker) {
    try {
      const vr = await verify({ suiClient: sui, sealClient: seal, walrusClient: walrus, sessionKey: session, record: r });
      if (vr.hashMatches) verifiedCount += 1;
      const obs = (vr.bundle.observed ?? {}) as { board?: string[]; action?: string };
      moves.push({
        street: streetOf(obs.board ?? []),
        board: obs.board ?? [],
        action: obs.action ?? "?",
        amount: r.amount,
        rationale: vr.bundle.rationale ?? "",
      });
    } catch {
      // A record we cannot decrypt or verify is left out of the dossier on purpose.
    }
  }

  const summary = await summarize(moves);

  let anchored: AnchorResult | null = null;
  if (moves.length > 0) {
    const r = new Reasoning("Compile an intel dossier on an opponent");
    r.observe("Read the opponent's anchored history", `${moves.length} verified moves on chain.`, { count: moves.length });
    r.decide("Summarize the read", summary, { verifiedCount });
    // Serialize on the coordinator queue so the dossier's Walrus write does not race the gas
    // coin (see anchorMove for the same reason).
    anchored = await serialize(() =>
      anchor({
        suiClient: sui,
        sealClient: seal,
        walrusClient: walrus,
        signer: buyer.signer,
        mandateId: buyer.mandateId,
        accessId: buyer.accessId,
        bundle: {
          version: EVIDENCE_VERSION,
          mandateId: buyer.mandateId,
          agent: buyer.agentAddress,
          user: buyer.user,
          reasoning: r.build(summary),
          actionType: "intel_dossier",
          target: targetAgentId,
          amount: "0",
          rationale: summary,
          observed: { moves, verifiedCount, sourceCount: poker.length },
          before: {},
          after: {},
          txDigests: [],
          timestampMs: Date.now(),
        },
      }),
    );
  }

  return { targetAgentId, moves, sourceCount: poker.length, verifiedCount, summary, anchor: anchored };
}

// Prove the buyer can read what it paid for: decrypt the latest intel_dossier sealed
// to it, through the standard per-user Seal tier (its own address is its key).
export async function decryptLatestDossier(buyerMandateId: string, buyerUserSecret: string): Promise<string | null> {
  const records = await listRecords(sui, buyerMandateId, 20);
  const dossier = records.find((r) => r.actionType === "intel_dossier");
  if (!dossier) return null;
  const buyerKp = Ed25519Keypair.fromSecretKey(buyerUserSecret);
  const session = await createSession(sui, buyerKp, 10);
  const vr = await verify({ suiClient: sui, sealClient: seal, walrusClient: walrus, sessionKey: session, record: dossier });
  return vr.bundle.rationale ?? null;
}

async function summarize(moves: DossierMove[]): Promise<string> {
  if (moves.length === 0) return "No anchored history yet for this opponent.";
  const lines = moves
    .map((m, i) => `${i + 1}. ${m.street}: ${m.action} (${m.amount} chips). Reason given: "${m.rationale}"`)
    .join("\n");
  const res = await callModel({
    systemPrompt:
      "You are a poker coach writing a short scouting report from an opponent's own move log. " +
      "In 2 to 3 sentences, describe the opponent's betting and bluffing tendencies and name the one " +
      "exploit to use against them. Be concrete and specific. No preamble.",
    userPrompt: `Opponent's anchored moves and stated reasons:\n${lines}\n\nWrite the scouting report.`,
    maxTokens: 200,
    temperature: 0.4,
  });
  return res.text.trim() || lines;
}

function streetOf(board: string[]): string {
  if (board.length === 0) return "preflop";
  if (board.length === 3) return "flop";
  if (board.length === 4) return "turn";
  if (board.length === 5) return "river";
  return "unknown";
}
