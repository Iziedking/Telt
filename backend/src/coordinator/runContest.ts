import { readContest, joinContest, joinContestAsHouse, settleContest } from "../chain/sui.js";
import { loadRoster } from "./roster.js";
import { provisionAgentEntry, type Participant } from "./provision.js";
import { playSolverMatch } from "./solverMatch.js";
import { playMatch } from "./table.js";
import { runPokerTournament } from "./runPokerTournament.js";
import { customContests, challengeContests } from "./contestKinds.js";
import type { Seat } from "../poker/types.js";

// Run a contest with its entrants, by kind:
//   - duel (real): two real agents, no platform fillers.
//   - duel (challenge): the entrant against a random platform agent seated as the opponent.
//   - general (multi): platform agents fill the empty seats as house. They play but cannot
//     win and never take a payout, so a general contest needs at least one real entrant.
//   - custom (multi): a creator's event, no platform agents at all.
// Poker with three or more entrants runs as a single-elimination CHAMPIONSHIP
// (runPokerTournament); two is an ordinary heads-up match.
const GAME_SOLVER = 1;
const FORMAT_DUEL = 0;

// The bracket tops out at eight seats, matching the on-chain cap in contest::create.
const TOURNEY_MAX_SEATS = 8;

// A contest can be triggered from two places at once (the sweeper at the deadline and a manual
// Run now), so guard against running the same one twice in parallel.
const inFlight = new Set<string>();

export async function runContest(contestId: string, opts: { puzzles?: number } = {}): Promise<void> {
  if (inFlight.has(contestId)) return;
  inFlight.add(contestId);
  try {
    await runContestInner(contestId, opts);
  } finally {
    inFlight.delete(contestId);
  }
}

async function runContestInner(contestId: string, opts: { puzzles?: number }): Promise<void> {
  const c = await readContest(contestId);
  if (!c) throw new Error("contest not found");
  if (c.status !== 0) throw new Error("contest is not open");

  const entrants = [...c.entrants];
  const roster = loadRoster().agents;

  if (c.format === FORMAT_DUEL) {
    // A challenge duel seats one random platform agent as the opponent.
    if (challengeContests.has(contestId) && entrants.length === 1) {
      const pick = roster[Math.floor((Date.now() / 1000) % roster.length)] ?? roster[0];
      if (pick && !entrants.some((e) => e.agentId === pick.agentId)) {
        await joinContest(contestId, pick.agentId, c.entryFee);
        entrants.push({ agentId: pick.agentId, owner: "", isHouse: false });
      }
    }
  } else if (!customContests.has(contestId)) {
    // General: fill the empty seats with platform agents as house. They play but cannot win,
    // so the pool falls to the real entrant. A general with no real entrant is not run (the
    // sweeper expires it), so there is always at least one real agent here.
    //
    // Fill to the contest's OWN seat cap, not to two. A championship opened with eight seats
    // fills all eight, so a single real entrant still gets a full bracket to win rather than a
    // duel wearing a tournament's name. Bounded by the roster: with two house agents a 4-seat
    // room fills to three and the bracket byes the odd seat, which is correct.
    const cap = Math.max(2, Math.min(TOURNEY_MAX_SEATS, c.maxEntries));
    for (const r of roster) {
      if (entrants.length >= cap) break;
      if (entrants.some((e) => e.agentId === r.agentId)) continue;
      await joinContestAsHouse(contestId, r.agentId);
      entrants.push({ agentId: r.agentId, owner: "", isHouse: true });
    }
  }

  const realCount = entrants.filter((e) => !e.isHouse).length;
  if (entrants.length < 2) {
    throw new Error(
      c.format === FORMAT_DUEL ? "a duel needs two agents before it can run" : "open the contest to entrants first",
    );
  }
  if (realCount < 1) throw new Error("join with your agent before running this contest");

  // Three or more poker entrants is a CHAMPIONSHIP, not a duel: hand off to the bracket, which
  // maps the field onto heads-up matches and settles the pool to the best real finisher. Solver
  // stays a single field, and two players is just a match.
  if (c.game !== GAME_SOLVER && entrants.length > 2) {
    await runPokerTournament(
      contestId,
      entrants.map((e) => ({ agentId: e.agentId, isHouse: e.isHouse })),
    );
    return;
  }

  const seats: Seat[] = ["A", "B"];
  const participants: Participant[] = [];
  for (let i = 0; i < 2; i++) {
    const e = entrants[i]!;
    participants.push(await provisionAgentEntry(e.agentId, seats[i]!, e.isHouse));
  }

  if (c.game === GAME_SOLVER) {
    await playSolverMatch({ puzzles: opts.puzzles ?? 10, participants, contestId });
    return;
  }

  // Poker: play the hands and settle the tUSDC pool to the winner. The on-chain SUI table is
  // skipped (sponsorTable: false) because the coordinator does not own the players' agents, so
  // join_table would abort; the contest pool is the escrow. House agents cannot win, so the
  // pool falls to the best real entrant.
  // intelRef = the contest id, so agents can buy x402 intel during a contest too (buy_intel only
  // references the id; there is no SUI table to point at in a contest).
  const { winnerAgentId } = await playMatch({ participants, sponsorTable: false, intelRef: contestId });
  const champ = participants.find((p) => p.agentId === winnerAgentId && !p.isHouse);
  const winner = champ ?? participants.find((p) => !p.isHouse);
  if (!winner) throw new Error("no eligible winner");
  console.log(`[runContest ${contestId.slice(0, 10)}] match done, settling pool to ${winner.agentId.slice(0, 10)}`);
  await settleContest(contestId, winner.agentId);
  console.log(`[runContest ${contestId.slice(0, 10)}] pool settled`);
}
