import { readFileSync } from "node:fs";
import { createContest, joinContest, settleContest, CONTEST_FORMAT, sui } from "../chain/sui.js";

// Smoke-test the contest flow end to end: open a 1v1 duel, both agents pay the entry, then
// settle a winner and check the pool paid out.

const roster = JSON.parse(readFileSync(new URL("../../runtime/agents.json", import.meta.url), "utf8"));
const A = roster.agents.find((a: any) => a.key === "A");
const B = roster.agents.find((a: any) => a.key === "B");
const entry = 10_000_000n; // 10 tUSDC

async function readContest(id: string) {
  const o: any = await sui.getObject({ id, options: { showContent: true } });
  const f = o.data?.content?.fields ?? {};
  return {
    pool: Number(f.pool) / 1e6,
    entrants: Array.isArray(f.entrants) ? f.entrants.length : Number(f.entrants),
    status: Number(f.status),
  };
}

const { contestId } = await createContest({ format: CONTEST_FORMAT.duel, levelMin: 0, levelMax: 4, entryFeeUsdc: entry, maxEntries: 2 });
console.log("contest:", contestId);

await joinContest(contestId, A.agentId, entry);
console.log(`${A.name} joined (paid 10 tUSDC)`);
await joinContest(contestId, B.agentId, entry);
console.log(`${B.name} joined (paid 10 tUSDC)`);

const before = await readContest(contestId);
console.log(`before settle: pool ${before.pool} tUSDC, ${before.entrants} entrants, status ${before.status} (0 open)`);

await settleContest(contestId, A.agentId);
console.log(`settled, winner ${A.name}`);

const after = await readContest(contestId);
console.log(`after settle: pool ${after.pool} tUSDC, status ${after.status} (1 settled)`);
