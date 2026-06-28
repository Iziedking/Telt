import { readContest, joinContest, joinContestAsHouse, settleContest } from "../chain/sui.js";
import { loadRoster } from "./roster.js";
import { provisionAgentEntry, type Participant } from "./provision.js";
import { playSolverMatch } from "./solverMatch.js";
import { playMatch } from "./table.js";
import { customContests, challengeContests } from "./contestKinds.js";
import type { Seat } from "../poker/types.js";

// Run a contest with its entrants, by kind:
//   - duel (real): two real agents, no platform fillers.
//   - duel (challenge): the entrant against a random platform agent seated as the opponent.
//   - general (multi): platform agents fill the empty seats as house. They play but cannot
//     win and never take a payout, so a general contest needs at least one real entrant.
//   - custom (multi): a creator's event, no platform agents at all.
const GAME_SOLVER = 1;
const FORMAT_DUEL = 0;

export async function runContest(contestId: string, opts: { puzzles?: number } = {}): Promise<void> {
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
    // General: fill the empty seats with platform agents as house (never win).
    for (const r of roster) {
      if (entrants.length >= 2) break;
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

  const seats: Seat[] = ["A", "B"];
  const participants: Participant[] = [];
  for (let i = 0; i < 2; i++) {
    const e = entrants[i]!;
    participants.push(await provisionAgentEntry(e.agentId, seats[i]!, e.isHouse));
  }

  if (c.game === GAME_SOLVER) {
    await playSolverMatch({ puzzles: opts.puzzles ?? 6, participants, contestId });
    return;
  }

  // Poker: no SUI escrow for a contest (the tUSDC pool is the stake). Play, then settle the
  // pool to the winner. House agents cannot win, so the pool falls to the best real entrant.
  const { winnerAgentId } = await playMatch({ participants, buyinMist: 0n });
  const champ = participants.find((p) => p.agentId === winnerAgentId && !p.isHouse);
  const winner = champ ?? participants.find((p) => !p.isHouse);
  if (!winner) throw new Error("no eligible winner");
  await settleContest(contestId, winner.agentId);
}
