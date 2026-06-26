import { playMatch } from "../coordinator/table.js";

// Kick one match end to end. Flags:
//   --hands N      number of hands (default 2)
//   --no-anchor    skip Avow anchoring for a fast engine/LLM-only dry run
// Run: npm run match -- --hands 2

function flag(name: string): boolean {
  return process.argv.includes(name);
}
function num(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  return fallback;
}

async function main() {
  const res = await playMatch({
    hands: num("--hands", 2),
    anchor: !flag("--no-anchor"),
  });
  console.log(`\ndone: match ${res.matchId}, winner seat ${res.winner}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
