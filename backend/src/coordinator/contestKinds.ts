import { config } from "../config/index.js";
import { query, persist, dbAvailable } from "../db/pool.js";

// Off-chain markers for contest behaviour the contract does not record. Held in memory for fast
// reads but backed by Postgres (contest_markers), so a restart does not orphan an in-flight
// contest: loadContestMarkers() rehydrates these on boot and the sweeper can still run a contest
// whose window closed while the process was down.
//
// - customContests: multi-entry contests with no platform agents (a creator's own event).
// - challengeContests: a duel where a random platform agent is seated as the opponent.
// - contestEnds: the join-window deadline (epoch ms) for each contest.
export const customContests = new Set<string>();
export const challengeContests = new Set<string>();
export const contestDifficulty = new Map<string, string>();
const contestEnds = new Map<string, number>();

// Upsert the full marker row for a contest from the current in-memory state. Fire-and-forget: the
// in-memory maps are authoritative at runtime, the DB is the restart mirror.
function persistMarker(contestId: string): void {
  const kind = customContests.has(contestId) ? "custom" : challengeContests.has(contestId) ? "challenge" : null;
  const difficulty = contestDifficulty.get(contestId) ?? null;
  const endsAt = contestEnds.get(contestId) ?? null;
  void persist(() =>
    query(
      `insert into contest_markers (contest_id, kind, difficulty, ends_at, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (contest_id) do update
         set kind = excluded.kind, difficulty = excluded.difficulty, ends_at = excluded.ends_at, updated_at = now()`,
      [contestId, kind, difficulty, endsAt],
    ),
  );
}

// Persisting setters: use these instead of mutating the sets/map directly so the DB stays in sync.
export function markCustom(contestId: string): void {
  customContests.add(contestId);
  persistMarker(contestId);
}
export function markChallenge(contestId: string): void {
  challengeContests.add(contestId);
  persistMarker(contestId);
}
export function markDifficulty(contestId: string, difficulty: string): void {
  contestDifficulty.set(contestId, difficulty);
  persistMarker(contestId);
}

// Rehydrate the markers from Postgres on boot, so a contest that was mid-flight before a restart is
// recognised again and the sweeper can run and settle it.
export async function loadContestMarkers(): Promise<void> {
  if (!dbAvailable()) return;
  try {
    const r = await query<{ contest_id: string; kind: string | null; difficulty: string | null; ends_at: string | null }>(
      "select contest_id, kind, difficulty, ends_at from contest_markers",
    );
    for (const row of r.rows) {
      if (row.kind === "custom") customContests.add(row.contest_id);
      if (row.kind === "challenge") challengeContests.add(row.contest_id);
      if (row.difficulty) contestDifficulty.set(row.contest_id, row.difficulty);
      if (row.ends_at !== null) contestEnds.set(row.contest_id, Number(row.ends_at));
    }
    console.log(`[contest-markers] reloaded ${r.rows.length} from db`);
  } catch (e) {
    console.warn("[contest-markers] reload failed:", (e as Error).message);
  }
}

// Difficulty gates the agent levels that may join. The hardest contests are for the top
// tiers only; the easiest are open to everyone.
export function levelBandFor(difficulty: string): [number, number] {
  if (difficulty === "Elite") return [3, 4];
  if (difficulty === "Hard") return [2, 4];
  return [0, 4];
}

// Open a join window for a contest: a random length between the configured min and max
// minutes, so contests do not all close at once. Returns the deadline (epoch ms).
export function openContestWindow(contestId: string): number {
  // Demo override wins when set: a fixed, short window so a contest fires quickly on stage.
  let length: number;
  if (config.contest.joinFixedMs > 0) {
    length = config.contest.joinFixedMs;
  } else {
    const min = config.contest.joinMinMs;
    const max = Math.max(min, config.contest.joinMaxMs);
    const span = max - min;
    length = min + Math.floor(Math.random() * (span + 1));
  }
  const endsAt = Date.now() + length;
  contestEnds.set(contestId, endsAt);
  persistMarker(contestId);
  return endsAt;
}

// The join-window deadline (epoch ms) for a contest, or null if it has no recorded window
// (e.g. one created before a restart), in which case it is treated as always joinable.
export function contestEndsAt(contestId: string): number | null {
  return contestEnds.get(contestId) ?? null;
}

// Close a contest's join window now (used by "Run now"), so the match only ever runs after the
// window is shut and no agent answers while the countdown is still ticking.
export function closeContestWindow(contestId: string): void {
  contestEnds.set(contestId, Date.now());
  persistMarker(contestId);
}

// "joining" while the window is open, "running" once it has closed. (Settled contests are
// filtered out before this is asked.)
export function contestPhase(contestId: string, now: number = Date.now()): "joining" | "running" {
  const endsAt = contestEndsAt(contestId);
  if (endsAt === null) return "joining";
  return now < endsAt ? "joining" : "running";
}
