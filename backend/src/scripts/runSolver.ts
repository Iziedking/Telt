import { generatePuzzles } from "../solver/generator.js";
import { solve } from "../solver/solverRunner.js";
import { planForLevel } from "../reason/levels.js";
import { solverSourcesConfigured } from "../solver/sources.js";

// Prove the solver pipeline: generate live puzzles, have two tiers answer them, and score
// against the held-back answers. Run: npm run solver -- --puzzles 5 --levels 0,4

function num(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main() {
  const count = num("--puzzles", 5);
  const levels = arg("--levels", "0,4").split(",").map(Number);

  console.log(`solver: ${count} puzzles, web facts ${solverSourcesConfigured() ? "on" : "off (model knowledge)"}\n`);
  const puzzles = await generatePuzzles(count);

  const scores: Record<number, number> = {};
  for (const l of levels) scores[l] = 0;

  for (const [i, pz] of puzzles.entries()) {
    console.log(`Q${i + 1} [${pz.topic}]${pz.grounded ? " (web)" : ""}: ${pz.question}`);
    pz.options.forEach((o, j) => console.log(`   ${j}) ${o}${j === pz.answer ? "   <- answer" : ""}`));
    for (const lvl of levels) {
      const d = await solve(pz, planForLevel(lvl));
      const ok = d.answer === pz.answer;
      if (ok) scores[lvl]! += 1;
      console.log(`   L${lvl} chose ${d.answer} ${ok ? "correct" : "wrong"} (${d.agreement}/${d.samples} agreed)`);
    }
    console.log("");
  }

  console.log("scores: " + levels.map((l) => `L${l} ${scores[l]}/${count}`).join("   "));
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
