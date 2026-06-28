// Off-chain markers for contest behaviour the contract does not record. In-memory for the
// demo: after a restart a contest defaults to general behaviour, which is the safe case.
//
// - customContests: multi-entry contests with no platform agents (a creator's own event).
// - challengeContests: a duel where a random platform agent is seated as the opponent.
export const customContests = new Set<string>();
export const challengeContests = new Set<string>();
