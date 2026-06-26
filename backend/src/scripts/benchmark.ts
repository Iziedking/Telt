import { scoreTier, SPOTS } from "../poker/benchmark.js";
import { pokerTierName } from "../skills/poker.js";

// Score every tier on the decision benchmark and print a table. Run:
//   npm run benchmark -- --reps 2 --levels 0,2,4
// A stronger tier should make the textbook play more often. Same scores across tiers
// means the skill prompt is not changing decisions.

function num(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main() {
  const reps = num("--reps", 2);
  const levels = arg("--levels", "0,1,2,3,4").split(",").map(Number);

  console.log(`decision benchmark: ${SPOTS.length} spots, ${reps} reps each\n`);
  const scores = [];
  for (const level of levels) {
    const s = await scoreTier(level, reps);
    scores.push(s);
    const pct = Math.round((100 * s.correct) / s.total);
    console.log(`${pokerTierName(level).padEnd(9)} L${level}:  ${s.correct}/${s.total}  (${pct}%)`);
  }

  // Per-spot matrix: which tiers got each spot right (correct rate as a fraction).
  console.log("\nper spot (correct / reps):");
  const header = "  " + levels.map((l) => `L${l}`.padStart(6)).join("");
  console.log(`${"".padEnd(46)}${header}`);
  for (let i = 0; i < SPOTS.length; i++) {
    const row = scores.map((s) => `${s.perSpot[i]!.correct}/${s.perSpot[i]!.total}`.padStart(6)).join("");
    console.log(`  [${SPOTS[i]!.category.padEnd(10)}] ${SPOTS[i]!.name.slice(0, 31).padEnd(31)}${row}`);
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
