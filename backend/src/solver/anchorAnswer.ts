import { anchor, Reasoning, EVIDENCE_VERSION, type AnchorResult } from "avow-sdk";
import { sui, serialize } from "../chain/sui.js";
import { seal, walrus, type AgentAvow } from "../avow/anchorMove.js";
import { anchorAllowed, recordAnchor } from "../avow/anchorGuard.js";
import type { Puzzle } from "./types.js";

// Anchor one solver answer the same way poker anchors a move: build a Reasoning trace,
// seal it on Walrus, hash and stamp it on Sui under the agent's mandate. The question, the
// agent's choice, and whether it was right are recorded as sealed evidence, so the result
// is provable, not just asserted.
export interface AnswerAnchorInput {
  puzzle: Puzzle;
  choice: number;
  correct: boolean;
  rationale: string;
  opponentAgentId: string;
}

export async function anchorAnswer(ctx: AgentAvow, a: AnswerAnchorInput): Promise<AnchorResult> {
  if (!anchorAllowed()) throw new Error("anchoring paused (Walrus degraded)");
  const p = a.puzzle;
  const r = new Reasoning(`Solver quiz on ${p.topic}`);
  r.observe("Read the question", `${p.question} Options: ${p.options.map((o, i) => `${i}) ${o}`).join("; ")}.`, {
    question: p.question,
    options: p.options,
  });
  r.decide(`Answer ${a.choice}) ${p.options[a.choice]}`, a.rationale, { choice: a.choice });
  const reasoning = r.build(`chose option ${a.choice}`);

  // Serialize on the coordinator queue so the anchor's on-chain writes do not race the gas
  // coin with the match's transactions (see anchorMove for the same reason).
  try {
    const result = await serialize(() =>
      anchor({
        suiClient: sui,
        sealClient: seal,
        walrusClient: walrus,
        signer: ctx.signer,
        mandateId: ctx.mandateId,
        accessId: ctx.accessId,
        bundle: {
          version: EVIDENCE_VERSION,
          mandateId: ctx.mandateId,
          agent: ctx.agentAddress,
          user: ctx.user,
          reasoning,
          actionType: "solver_answer",
          target: a.opponentAgentId,
          amount: "0",
          rationale: a.rationale,
          observed: { puzzleId: p.id, topic: p.topic, question: p.question, options: p.options, choice: a.choice },
          before: null,
          after: { choice: a.choice, correct: a.correct },
          txDigests: [],
          timestampMs: Date.now(),
        },
      }),
    );
    recordAnchor(true);
    return result;
  } catch (e) {
    recordAnchor(false);
    throw e;
  }
}

