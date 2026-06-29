import { sui, readContests } from "../chain/sui.js";
import { config } from "../config/index.js";
import { contestEndsAt } from "./contestKinds.js";
import { runContest } from "./runContest.js";

// The due-sweeper (Zerun's pattern): on a tick it finds open contests whose join window has
// closed and runs them, so a contest never looks stuck after its countdown hits zero. A
// contest with no real entrant is left alone; one with at least one real agent runs (general
// fills the rest with house, a challenge seats a platform opponent).
const SWEEP_MS = 15_000;
const inFlight = new Set<string>();

async function sweepOnce(): Promise<void> {
  if (!config.arena.packageId) return;
  const ev = await sui.queryEvents({
    query: { MoveEventType: `${config.arena.packageId}::contest::ContestCreated` },
    limit: 30,
    order: "descending",
  });
  const ids = [...new Set(ev.data.map((e) => String((e as any).parsedJson?.contest)).filter(Boolean))];
  const states = await readContests(ids);
  const now = Date.now();
  for (const s of states) {
    if (s.status !== 0 || inFlight.has(s.contestId)) continue;
    const endsAt = contestEndsAt(s.contestId);
    if (endsAt === null || now < endsAt) continue; // window still open, or no recorded window
    if (s.entrants.filter((e) => !e.isHouse).length < 1) continue; // nothing real to run yet
    inFlight.add(s.contestId);
    console.log(`[sweeper] window closed, running contest ${s.contestId.slice(0, 10)}`);
    runContest(s.contestId)
      .catch((e) => console.error("[sweeper]", (e as Error).message))
      .finally(() => inFlight.delete(s.contestId));
  }
}

export function startSweeper(): void {
  const tick = async () => {
    try {
      await sweepOnce();
    } catch (e) {
      console.error("[sweeper]", (e as Error).message);
    }
    setTimeout(tick, SWEEP_MS);
  };
  console.log(`[sweeper] on, every ${SWEEP_MS / 1000}s`);
  setTimeout(tick, SWEEP_MS);
}
