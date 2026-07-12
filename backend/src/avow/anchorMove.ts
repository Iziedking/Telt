import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { WalrusClient } from "@mysten/walrus";
import {
  anchor,
  verify,
  listRecords,
  createSession,
  getSealClient,
  Reasoning,
  EVIDENCE_VERSION,
  type AnchorResult,
  type VerifyResult,
} from "avow-sdk";
import { sui, coordinator, serialize } from "../chain/sui.js";
import { anchorAllowed, recordAnchor } from "./anchorGuard.js";
import type { Seat, Street, Card } from "../poker/types.js";

// Wrap the Avow SDK to anchor one poker move: build a Reasoning trace, seal it on
// Walrus, hash and stamp it on Sui. The proof of a move lives here, not in the model
// layer. Verification is exposed too, so the coordinator can confirm a move is real
// (hash matches, within mandate) the way the dashboard would.

// One Seal client and one Walrus client for the process, both built on the shared
// Sui client so Seal can cache keys across decryptions. Exported so the dossier path
// reuses the same clients rather than spinning up a second pair.
export const seal = getSealClient(sui);

// Storing the sealed bundle is the slow half of an anchor, and avow-sdk's getWalrusClient()
// pins the one route that is currently broken. Measured on 2026-07-12:
//
//   upload relay  (avow default) : POST /v1/blob-upload-relay stalls 33s, answers 500. Dead.
//   direct to nodes              : works, but it is ~2000 sliver PUTs over ~100 storage nodes,
//                                  many of which have expired certs or no DNS. ~90s per blob.
//   publisher                    : one PUT, ~15s, returns the blob id. Healthy.
//
// Every Sui RPC call in the same traces came back 200 in under two seconds, so the RPC layer
// was never the problem. Write through the publisher and keep the direct path as the fallback,
// so a publisher outage degrades anchoring to slow instead of broken.
const PUBLISHER = process.env.WALRUS_PUBLISHER ?? "https://publisher.walrus-testnet.walrus.space";
const AGGREGATOR = process.env.WALRUS_AGGREGATOR ?? "https://aggregator.walrus-testnet.walrus.space";
const GATEWAY_TIMEOUT_MS = Number(process.env.WALRUS_GATEWAY_TIMEOUT_MS) || 60_000;

// The publisher registers and certifies the blob with its own funds, so it owns the Blob object.
// That is fine here: an anchor records the blob id and the evidence hash on chain, and verify
// reads the bytes back by blob id, so nothing downstream needs us to hold the object.
//
// Reads have the same shape. verify() calls readBlob, which pulls slivers from that same
// half-dead fleet and took 77s. The aggregator serves the whole blob in one GET, so the verify
// reveal answers in seconds. Both overrides fall back to the SDK's direct path on failure.
type WriteBlob = WalrusClient["writeBlob"];

class GatewayWalrusClient extends WalrusClient {
  constructor(config: ConstructorParameters<typeof WalrusClient>[0]) {
    super(config);
    const readFromNodes = this.readBlob;
    this.readBlob = async (options) => {
      try {
        const res = await globalThis.fetch(`${AGGREGATOR}/v1/blobs/${options.blobId}`, {
          signal: options.signal ?? AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`aggregator returned ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        console.warn(`[walrus] aggregator read failed (${(e as Error).message}), reading from storage nodes`);
        return readFromNodes(options);
      }
    };
  }

  async writeBlob(...args: Parameters<WriteBlob>): ReturnType<WriteBlob> {
    const [options] = args;
    try {
      const res = await globalThis.fetch(`${PUBLISHER}/v1/blobs?epochs=${options.epochs}`, {
        method: "PUT",
        body: options.blob as unknown as RequestInit["body"],
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`publisher returned ${res.status}`);
      const body = (await res.json()) as {
        newlyCreated?: { blobObject?: { blobId?: string } };
        alreadyCertified?: { blobId?: string };
      };
      const blobObject = body.newlyCreated?.blobObject;
      const blobId = blobObject?.blobId ?? body.alreadyCertified?.blobId;
      if (!blobId) throw new Error("publisher returned no blob id");
      return { blobId, blobObject } as Awaited<ReturnType<WriteBlob>>;
    } catch (e) {
      console.warn(`[walrus] publisher write failed (${(e as Error).message}), writing to storage nodes`);
      return super.writeBlob(...args);
    }
  }
}

export const walrus = new GatewayWalrusClient({
  network: process.env.AVOW_NETWORK === "mainnet" ? "mainnet" : "testnet",
  suiClient: sui,
});

/** Everything a single agent needs to anchor under its own Avow mandate. */
export interface AgentAvow {
  /** The agent's Avow mandate object id. */
  mandateId: string;
  /** The evidence access (Seal namespace) registered for that mandate. */
  accessId: string;
  /** The mandate's agent address; this signer must equal it. */
  agentAddress: string;
  /** The operator identity the evidence is sealed to (per-agent, for per-user intel). */
  user: string;
  /** Signs the Walrus write and the anchor transaction. Must be the mandate's agent. */
  signer: Ed25519Keypair;
}

export interface MoveAnchorInput {
  seat: Seat;
  street: Street;
  board: Card[];
  holeCards: [Card, Card];
  pot: number;
  action: string;
  size: number;
  /** Chips this action committed (the on-chain amount). */
  amount: number;
  rationale: string;
  /** The opponent agent id, recorded as the action's target. */
  opponentAgentId: string;
  before: unknown;
  after: unknown;
  /** Digests of any real money moves this action references (settlement, etc.). */
  txDigests?: string[];
}

export async function anchorMove(ctx: AgentAvow, m: MoveAnchorInput): Promise<AnchorResult> {
  // Skip while the breaker is open, so a Walrus outage cannot clog the tx queue. The caller
  // treats a throw here as "move stays unproven", which is exactly the degraded behaviour.
  if (!anchorAllowed()) throw new Error("anchoring paused (Walrus degraded)");
  const boardStr = m.board.length ? m.board.join(" ") : "preflop";
  const r = new Reasoning(`Heads-up poker decision on the ${m.street}`);
  r.observe("Read the table", `Hole ${m.holeCards.join(" ")}, board ${boardStr}, pot ${m.pot}.`, {
    holeCards: m.holeCards,
    board: m.board,
    pot: m.pot,
  });
  r.decide(
    m.size > 0 ? `${m.action} to ${m.size}` : m.action,
    m.rationale,
    { action: m.action, size: m.size, amount: m.amount },
  );
  const reasoning = r.build(m.size > 0 ? `${m.action} ${m.size} (${m.amount} chips)` : `${m.action} (${m.amount} chips)`);

  // Serialize: the anchor's Walrus writes run their own on-chain transactions inside the SDK,
  // which would otherwise race the coordinator's gas coin with the match's transactions and
  // fail on a stale object version. Running it on the shared queue gives it a fresh version.
  // Retry once on a transient Walrus failure so a single blip does not leave the move unanchored.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
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
            actionType: "poker_move",
            target: m.opponentAgentId,
            amount: String(m.amount),
            rationale: m.rationale,
            observed: { holeCards: m.holeCards, board: m.board, pot: m.pot, action: m.action, size: m.size },
            before: m.before,
            after: m.after,
            txDigests: m.txDigests ?? [],
            timestampMs: Date.now(),
          },
        }),
      );
      recordAnchor(true);
      return result;
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 700));
    }
  }
  recordAnchor(false);
  throw lastErr;
}

// Confirm the most recent anchored record for a mandate is real: fetch it, decrypt
// through Seal, recompute the hash, and read the on-chain compliance verdict. The
// reader is the coordinator, which is the principal of every access it created.
export async function verifyLatestForMandate(mandateId: string): Promise<VerifyResult | null> {
  const records = await listRecords(sui, mandateId, 10);
  if (records.length === 0) return null;
  const session = await createSession(sui, coordinator(), 10);
  return verify({ suiClient: sui, sealClient: seal, walrusClient: walrus, sessionKey: session, record: records[0]! });
}

export interface MoveVerification {
  hashMatches: boolean;
  amountMatches: boolean;
  withinMandate: boolean;
  blobId: string;
  txDigest: string | null;
}

// Verify one specific anchored move by its Walrus blob id (or the latest if no blob is
// given). This backs the frontend verify reveal: it does the real check on demand, it
// does not trust a cached flag.
export async function verifyByBlob(mandateId: string, blobId?: string): Promise<MoveVerification | null> {
  const records = await listRecords(sui, mandateId, 50);
  const record = blobId ? records.find((r) => r.blobId === blobId) : records[0];
  if (!record) return null;

  // Seal key servers and the Walrus relay occasionally rate-limit or drop a request
  // under load (for example while a match's intel beat is decrypting many bundles).
  // Retry a couple of times with backoff so the verify reveal is robust.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const session = await createSession(sui, coordinator(), 10);
      const vr = await verify({ suiClient: sui, sealClient: seal, walrusClient: walrus, sessionKey: session, record });
      return {
        hashMatches: vr.hashMatches,
        amountMatches: vr.amountMatches,
        withinMandate: vr.withinMandate,
        blobId: record.blobId,
        txDigest: record.txDigest ?? null,
      };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  throw lastErr;
}
