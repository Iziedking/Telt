import { config } from "../config/index.js";

// Off-chain markers for contest behaviour the contract does not record. In-memory for the
// demo: after a restart a contest defaults to general behaviour with no window, which is the
// safe case.
//
// - customContests: multi-entry contests with no platform agents (a creator's own event).
// - challengeContests: a duel where a random platform agent is seated as the opponent.
// - contestEnds: the join-window deadline (epoch ms) for each contest.
export const customContests = new Set<string>();
export const challengeContests = new Set<string>();
const contestEnds = new Map<string, number>();

// Open a join window for a contest: a random length between the configured min and max
// minutes, so contests do not all close at once. Returns the deadline (epoch ms).
export function openContestWindow(contestId: string): number {
  const min = config.contest.joinMinMs;
  const max = Math.max(min, config.contest.joinMaxMs);
  const span = max - min;
  const length = min + Math.floor(Math.random() * (span + 1));
  const endsAt = Date.now() + length;
  contestEnds.set(contestId, endsAt);
  return endsAt;
}

// The join-window deadline (epoch ms) for a contest, or null if it has no recorded window
// (e.g. one created before a restart), in which case it is treated as always joinable.
export function contestEndsAt(contestId: string): number | null {
  return contestEnds.get(contestId) ?? null;
}

// "joining" while the window is open, "running" once it has closed. (Settled contests are
// filtered out before this is asked.)
export function contestPhase(contestId: string, now: number = Date.now()): "joining" | "running" {
  const endsAt = contestEndsAt(contestId);
  if (endsAt === null) return "joining";
  return now < endsAt ? "joining" : "running";
}
