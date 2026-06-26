import { simulateMatch } from "../poker/simulate.js";
import { pokerTierName } from "../skills/poker.js";

// Pit tiers against each other off chain and report who wins, to check that a higher
// tier actually beats a lower one (strength differs, not just labels). Poker has high
// variance, so more hands and reps give a cleaner signal; this is a real head-to-head,
// not a proof. Run: npm run tiertest -- --hands 16 --reps 2 --matchups 0v4,2v4,1v3
//
// Each decision is real Haiku calls (more for higher tiers), so keep the sample bounded.

function num(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main() {
  const maxHands = num("--hands", 12);
  const reps = num("--reps", 1);
  const matchups = arg("--matchups", "0v4,2v4,0v2")
    .split(",")
    .map((m) => m.split("v").map(Number) as [number, number]);

  console.log(`tier test: maxHands=${maxHands}, reps=${reps}\n`);
  for (const [la, lb] of matchups) {
    let aWins = 0;
    let bWins = 0;
    for (let r = 0; r < reps; r++) {
      const res = await simulateMatch(la, lb, { maxHands, seedBase: r + 1 });
      if (res.winner === "A") aWins += 1;
      else bWins += 1;
      console.log(
        `  ${pokerTierName(la)} (L${la}) vs ${pokerTierName(lb)} (L${lb})  rep ${r + 1}: ` +
          `winner L${res.winner === "A" ? la : lb}, chips ${res.chips.A}/${res.chips.B}, ${res.hands} hands${res.busted ? " (bust)" : " (cap)"}`,
      );
    }
    const higher = la >= lb ? "L" + la : "L" + lb;
    const higherWins = la >= lb ? aWins : bWins;
    console.log(`  => ${pokerTierName(la)} ${aWins} : ${bWins} ${pokerTierName(lb)}  (higher tier ${higher} took ${higherWins}/${reps})\n`);
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
