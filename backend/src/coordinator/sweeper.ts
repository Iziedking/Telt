import { sui, readContests } from "../chain/sui.js";
import { config } from "../config/index.js";
import { contestEndsAt, customContests, challengeContests, hasPlayed } from "./contestKinds.js";
import { runContest } from "./runContest.js";

const FORMAT_DUEL = 0;

// The due-sweeper (Zerun's pattern): on a tick it finds open contests whose join window has
// closed and runs them, so a contest never looks stuck after its countdown hits zero. A
// contest with no real entrant is left alone; one with at least one real agent runs (general
// fills the rest with house, a challenge seats a platform opponent).
const SWEEP_MS = 15_000;

// The last call before the house takes the table. When a general contest's window closes with no
// real entrant, this is how long a late operator still has to claim the seat; after it, the house
// fills the room and plays it as an exhibition rather than leaving the arena empty.
const HOUSE_FILL_GRACE_MS = Number(process.env.HOUSE_FILL_GRACE_SECONDS ?? "5") * 1000;

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
    // Run only a contest whose own window has just closed. A contest with no recorded window
    // (lost on a restart) is treated as expired by the API, so leave it be rather than run a
    // stale event.
    if (endsAt === null || now < endsAt) continue;

    // Decide whether the field is ready to run. General contests always run at the deadline
    // (a platform-vs-platform demo if no one joined). A challenge needs one real agent (a
    // platform opponent is seated for it); a plain duel and a custom event need two real
    // agents and otherwise wait.
    // A contest runs at the deadline if it has a real field: general and challenge need one real
    // agent (a platform opponent / house seats fill in around it), a plain duel and a custom event
    // need two.
    //
    // A GENERAL contest with nobody in it still runs, as a house exhibition, once a short grace has
    // passed. That grace is the point: it is the last few seconds for a late operator to claim the
    // seat, and only after it lapses does the house take the table. An empty arena teaches a
    // visitor nothing, and a bracket of house agents playing for nothing is still a bracket they
    // can watch, verify, and buy intel on. Nothing is paid out (the pool cannot settle to a house
    // agent), so the pot simply waits for a contest somebody enters.
    // Already run. A settled contest leaves status 0 behind only when it could not pay (an all-house
    // exhibition), and without this the sweeper would run it again every fifteen seconds for as long
    // as the process lived. It did.
    if (hasPlayed(s.contestId)) continue;

    const real = s.entrants.filter((e) => !e.isHouse).length;
    let ready: boolean;
    if (s.format === FORMAT_DUEL) {
      ready = challengeContests.has(s.contestId) ? real >= 1 : real >= 2;
    } else if (customContests.has(s.contestId)) {
      ready = real >= 2;
    } else {
      ready = real >= 1 || now >= endsAt + HOUSE_FILL_GRACE_MS;
    }
    if (!ready) continue;

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
