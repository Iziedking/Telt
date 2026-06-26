import { rosterBySeat, avowFor } from "../coordinator/roster.js";
import { openTable } from "../chain/sui.js";
import { buyAndDeliver, PRICE_MIST } from "../intel/market.js";
import { decryptLatestDossier } from "../avow/dossier.js";
import type { Seat } from "../poker/types.js";

// Demo the money shot end to end, standalone: a buyer pays for a dossier on a target
// through the on-chain x402 flow, the coordinator verifies the payment and compiles the
// dossier from the target's real anchored records, re-seals it to the buyer, and the
// buyer decrypts what it paid for through its own per-user Seal tier.
//
// Run: npm run intel -- --buyer A --target B   (seed the target's history first)

function seatFlag(name: string, fallback: Seat): Seat {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  return v === "A" ? "A" : "B";
}

async function main() {
  const buyerSeat = seatFlag("--buyer", "A");
  const targetSeat = seatFlag("--target", "B");
  const roster = rosterBySeat();
  const buyer = roster[buyerSeat];
  const target = roster[targetSeat];
  if (!buyer || !target) throw new Error("run setup:agents first");

  console.log(`${buyer.name} buys intel on ${target.name} (price ${Number(PRICE_MIST) / 1e9} SUI)\n`);

  // A real table for the purchase context.
  const { tableId } = await openTable(10_000_000n);

  const delivered = await buyAndDeliver({
    tableId,
    targetAgentId: target.agentId,
    buyer: avowFor(buyer),
  });

  console.log("payment settled on Sui:");
  console.log(`  pay digest:   ${delivered.payDigest}`);
  console.log(`  receipt:      ${delivered.receiptId}`);
  console.log(`  amount:       ${Number(delivered.amount) / 1e9} SUI`);
  console.log("\ndossier compiled from the target's real anchored records:");
  console.log(`  moves used:   ${delivered.dossier.verifiedCount}/${delivered.dossier.sourceCount} verified`);
  console.log(`  dossier tx:   ${delivered.dossier.anchor?.anchorDigest ?? "(none)"}`);
  console.log(`\n  scouting report:\n  ${delivered.dossier.summary}\n`);

  // Prove the buyer can read what it paid for, through the per-user Seal tier.
  if (buyer.userSecret) {
    const decrypted = await decryptLatestDossier(buyer.mandateId, buyer.userSecret).catch((e) => {
      console.warn("  (per-user decrypt skipped:", (e as Error).message + ")");
      return null;
    });
    if (decrypted) {
      console.log("buyer decrypted the dossier through its own Seal tier:");
      console.log(`  ${decrypted}`);
    }
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
