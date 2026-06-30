import type { Hono } from "hono";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { sui, coordinator, buyIntel } from "../chain/sui.js";
import { config } from "../config/index.js";
import { compileDossier, compileDossierFromMoves, type Dossier, type DossierMove } from "../avow/dossier.js";
import type { AgentAvow } from "../avow/anchorMove.js";

// The intel marketplace: x402 the pattern, on Sui, with our own thin facilitator. A
// buyer that wants a dossier pays `intel::buy_intel` on chain, the coordinator verifies
// the payment (right target, enough paid, digest not reused), then compiles and delivers
// the dossier. The official x402 SDK ships EVM, Solana, and Stellar only, so we settle
// on Sui ourselves rather than block on a package that does not cover this chain.

// Demo price for one dossier, in MIST. A tiny micropayment (a fraction of a cent) so x402 reads as
// cheap, frequent, machine-scale spending rather than a meaningful cost.
export const PRICE_MIST = 2_000_000n; // 0.002 SUI

// Digests already redeemed, so a single payment cannot be replayed for many dossiers.
// In-memory for the demo; a real facilitator would persist this.
const redeemed = new Set<string>();

export interface PaymentCheck {
  ok: boolean;
  buyer: string;
  amount: bigint;
  reason?: string;
}

// Verify an on-chain intel payment: the tx must have succeeded, emitted IntelPurchased
// for the expected target, paid at least the price, and not been redeemed before. The
// recipient is the treasury by construction (buy_intel routes the fee there), so the
// event is enough.
export async function verifyPayment(txDigest: string, expectedTargetAgentId: string): Promise<PaymentCheck> {
  if (redeemed.has(txDigest)) {
    return { ok: false, buyer: "", amount: 0n, reason: "payment already redeemed" };
  }
  const tx = await sui.getTransactionBlock({ digest: txDigest, options: { showEvents: true, showEffects: true } });
  if (tx.effects?.status?.status !== "success") {
    return { ok: false, buyer: "", amount: 0n, reason: "transaction did not succeed" };
  }
  const ev = (tx.events ?? []).find((e) => e.type.endsWith("::intel::IntelPurchased"));
  if (!ev) {
    return { ok: false, buyer: "", amount: 0n, reason: "no IntelPurchased event in transaction" };
  }
  const j = ev.parsedJson as { target_agent?: string; amount?: string; buyer?: string };
  if (String(j.target_agent) !== expectedTargetAgentId) {
    return { ok: false, buyer: "", amount: 0n, reason: "payment is for a different target" };
  }
  const amount = BigInt(j.amount ?? "0");
  if (amount < PRICE_MIST) {
    return { ok: false, buyer: String(j.buyer), amount, reason: `underpaid: ${amount} < ${PRICE_MIST}` };
  }
  redeemed.add(txDigest);
  return { ok: true, buyer: String(j.buyer), amount };
}

export interface DeliveredIntel {
  payDigest: string;
  receiptId: string;
  amount: bigint;
  dossier: Dossier;
}

// The full buy: pay on chain, verify the payment, compile and deliver the dossier
// re-sealed to the buyer. This is what an agent's operator runs to get an edge.
export async function buyAndDeliver(opts: {
  tableId: string;
  targetAgentId: string;
  buyer: AgentAvow;
  buyerSigner?: Ed25519Keypair;
  // Moves observed live this match. When given, the dossier is built from these in memory (fast) and
  // the delivery is anchored in the background, so the live match is not blocked on the Walrus round
  // trip. Without it, the full on-chain compile (fetch + Seal decrypt every record) is used.
  scoutMoves?: DossierMove[];
  onDossierAnchored?: (digest: string | null) => void;
}): Promise<DeliveredIntel> {
  const signer = opts.buyerSigner ?? coordinator();
  const { receiptId, digest } = await buyIntel(opts.tableId, opts.targetAgentId, PRICE_MIST, signer);
  const check = await verifyPayment(digest, opts.targetAgentId);
  if (!check.ok) throw new Error(`payment verify failed: ${check.reason}`);
  const dossier = opts.scoutMoves
    ? await compileDossierFromMoves(opts.targetAgentId, opts.buyer, opts.scoutMoves, opts.onDossierAnchored)
    : await compileDossier(opts.targetAgentId, opts.buyer);
  return { payDigest: digest, receiptId, amount: check.amount, dossier };
}

// The HTTP face of the pattern: a 402 quote. The actual settlement is on Sui via
// buy_intel, after which the coordinator delivers (see buyAndDeliver).
export function intelRoutes(app: Hono): void {
  app.get("/intel/:tableId/:targetAgent", (c) => {
    c.status(402);
    return c.json({
      error: "payment required",
      scheme: "x402-on-sui",
      asset: "SUI",
      price: PRICE_MIST.toString(),
      priceSui: Number(PRICE_MIST) / 1e9,
      payTo: config.arena.treasury,
      target: c.req.param("targetAgent"),
      table: c.req.param("tableId"),
      call: `${config.arena.packageId}::intel::buy_intel`,
      note: "Pay intel::buy_intel(table, target, fee, treasury) on Sui, then the coordinator verifies the digest and delivers the dossier re-sealed to you.",
    });
  });
}
