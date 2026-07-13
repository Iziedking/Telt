import { simulateMatch } from "../poker/simulate.js";
import { pokerTierName } from "../skills/poker.js";

// Duplicate poker: the honest way to ask whether one tier is actually stronger than another.
//
// A straight head-to-head cannot answer it. Poker is mostly cards over any sample we can afford
// to run, and the plain tier test proved the point by returning 3-2 -- a number that means
// nothing. Running more matches is the expensive answer.
//
// The cheap answer is the one duplicate bridge has used for a century: deal the SAME cards to
// both sides. Every board here is played twice, once with tier X in seat A and once with tier Y
// in seat A. The deck is fixed by the seed, so whatever hand X was dealt in the first run, Y is
// dealt in the second. Card luck appears on both sides of the ledger and cancels; what is left
// is the decisions.
//
// Score is chips, not matches won, because chips are what the decisions actually move:
//
//   X's result  =  chips X made in seat A  +  chips X made in seat B (the return leg)
//
// A tier that is genuinely better takes chips off the same cards. A tier that only got lucky
// shows nothing, which is the point.
//
// Run: npm run duplicate -- --boards 6 --hands 12 --matchups 0v4,2v4,0v2

function num(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main() {
  const boards = num("--boards", 6);
  const maxHands = num("--hands", 12);
  const matchups = arg("--matchups", "0v4,2v4,0v2")
    .split(",")
    .map((m) => m.split("v").map(Number) as [number, number]);

  const START = 1500;
  console.log(`duplicate poker: ${boards} boards x 2 legs, ${maxHands} hands, ${START} chips\n`);

  for (const [lo, hi] of matchups) {
    const loName = pokerTierName(lo);
    const hiName = pokerTierName(hi);
    let loChips = 0;
    let hiChips = 0;
    let boardsHiAhead = 0;

    for (let b = 0; b < boards; b++) {
      const seedBase = 1000 + b; // the SAME decks in both legs

      // Leg 1: the low tier sits in seat A, the high tier in seat B.
      const leg1 = await simulateMatch(lo, hi, { seedBase, maxHands, startingChips: START });
      // Leg 2: same cards, seats swapped. Whatever seat A was dealt, the OTHER tier now holds.
      const leg2 = await simulateMatch(hi, lo, { seedBase, maxHands, startingChips: START });

      const loTotal = leg1.chips.A + leg2.chips.B;
      const hiTotal = leg1.chips.B + leg2.chips.A;
      loChips += loTotal;
      hiChips += hiTotal;
      if (hiTotal > loTotal) boardsHiAhead += 1;

      const edge = hiTotal - loTotal;
      console.log(
        `  board ${String(b + 1).padStart(2)}: ${loName} ${String(loTotal).padStart(5)}  ` +
          `${hiName} ${String(hiTotal).padStart(5)}   ${edge >= 0 ? "+" : ""}${edge} to ${edge >= 0 ? hiName : loName}`,
      );
    }

    // Both legs start each tier with START chips, so the break-even line is 2 x START per board.
    const par = 2 * START * boards;
    const edge = hiChips - par;
    const perBoard = edge / boards;
    console.log(
      `\n  => ${hiName} (L${hi}) vs ${loName} (L${lo}): ` +
        `${edge >= 0 ? "+" : ""}${edge} chips over ${boards} boards (${perBoard >= 0 ? "+" : ""}${perBoard.toFixed(0)}/board), ` +
        `ahead on ${boardsHiAhead}/${boards}\n`,
    );
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
