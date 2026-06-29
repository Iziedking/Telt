// Off-chain markers for contest behaviour the contract does not record. In-memory for the
// demo: after a restart a contest defaults to general behaviour with no window, which is the
// safe case.
//
// - customContests: multi-entry contests with no platform agents (a creator's own event).
// - challengeContests: a duel where a random platform agent is seated as the opponent.
// - contestOpenedAt: when a contest opened, so we can derive its join-window deadline.
export const customContests = new Set<string>();
export const challengeContests = new Set<string>();
export const contestOpenedAt = new Map<string, number>();

// How long a contest stays open for entries before it runs. Short for a snappy demo.
export const JOIN_WINDOW_MS = 3 * 60 * 1000;

// The join-window deadline (epoch ms) for a contest, or null if it has no recorded window
// (e.g. one created before a restart), in which case it is treated as always joinable.
export function contestEndsAt(contestId: string): number | null {
  const opened = contestOpenedAt.get(contestId);
  return opened ? opened + JOIN_WINDOW_MS : null;
}

// "joining" while the window is open, "running" once it has closed. (Settled contests are
// filtered out before this is asked.)
export function contestPhase(contestId: string, now: number = Date.now()): "joining" | "running" {
  const endsAt = contestEndsAt(contestId);
  if (endsAt === null) return "joining";
  return now < endsAt ? "joining" : "running";
}
