import { anchorMove } from "../avow/anchorMove.js";
import { rosterBySeat, avowFor } from "./roster.js";
import { otherSeat } from "../poker/engine.js";
import type { Card, Seat } from "../poker/types.js";

// Pre-seed a detectable bluff pattern for one agent, so a bought dossier visibly pays
// off in the demo. Every move here is a real anchored Avow record (sealed on Walrus,
// stamped on Sui); only the content is chosen to carry a clear tell. This is the "real
// but staged" approach the plan calls for: the intel result is genuine, the scenario is
// arranged. Run: npm run seed -- --seat B

interface Bluff {
  board: Card[];
  hole: [Card, Card];
  pot: number;
  size: number;
  rationale: string;
}

// The tell: this agent overbets the river with air, again and again.
const BLUFFS: Bluff[] = [
  {
    board: ["Ah", "Kd", "7c", "2s", "9h"],
    hole: ["6c", "6d"],
    pot: 240,
    size: 220,
    rationale: "Bluff: a small pair that missed everything. I overbet the river to fold out any ace.",
  },
  {
    board: ["Qs", "Js", "4d", "8h", "3c"],
    hole: ["7d", "5c"],
    pot: 180,
    size: 200,
    rationale: "Bluff: total air. An oversized river shove to represent the flush and push them off top pair.",
  },
  {
    board: ["Tc", "9d", "5h", "2c", "Ks"],
    hole: ["4s", "3d"],
    pot: 300,
    size: 320,
    rationale: "Bluff: missed draw, no pair. I jam the river big because they always fold to pressure here.",
  },
  {
    board: ["8s", "8d", "Qh", "3c", "Jd"],
    hole: ["6h", "5s"],
    pot: 160,
    size: 180,
    rationale: "Bluff: I have nothing. A big river bet sells trips and folds out their middle pair.",
  },
  {
    board: ["Ad", "5c", "5d", "9s", "2h"],
    hole: ["7c", "6c"],
    pot: 260,
    size: 260,
    rationale: "Bluff: busted straight draw. I overbet the river one more time to take it down.",
  },
];

function seatArg(): Seat {
  const i = process.argv.indexOf("--seat");
  const v = i >= 0 ? process.argv[i + 1] : "B";
  return v === "A" ? "A" : "B";
}

async function main() {
  const seat = seatArg();
  const roster = rosterBySeat();
  const target = roster[seat];
  const opp = roster[otherSeat(seat)];
  if (!target || !opp) throw new Error("run setup:agents first");

  const ctx = avowFor(target);
  console.log(`seeding ${BLUFFS.length} bluff moves for ${target.name} (seat ${seat})...`);

  for (let i = 0; i < BLUFFS.length; i++) {
    const b = BLUFFS[i]!;
    const proof = await anchorMove(ctx, {
      seat,
      street: "river",
      board: b.board,
      holeCards: b.hole,
      pot: b.pot,
      action: "raise",
      size: b.size,
      amount: b.size,
      rationale: b.rationale,
      opponentAgentId: opp.agentId,
      before: { pot: b.pot },
      after: { pot: b.pot + b.size },
    });
    console.log(`  ${i + 1}/${BLUFFS.length} anchored: ${proof.anchorDigest}`);
  }
  console.log("done.");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
