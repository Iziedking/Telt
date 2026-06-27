import { readContest, joinContestAsHouse, settleContest } from "../chain/sui.js";
import { loadRoster } from "./roster.js";
import { provisionAgentEntry, type Participant } from "./provision.js";
import { playSolverMatch } from "./solverMatch.js";
import { playMatch } from "./table.js";
import type { Seat } from "../poker/types.js";

// Run a contest with its real entrants. General contests get platform agents seated as house
// fillers to reach two players (they play but cannot win); duels stay platform-free, so a
// duel only runs once two real agents have joined. The pool settles to the winner.
const GAME_SOLVER = 1;
const FORMAT_DUEL = 0;

export async function runContest(contestId: string, opts: { puzzles?: number } = {}): Promise<void> {
  const c = await readContest(contestId);
  if (!c) throw new Error("contest not found");
  if (c.status !== 0) throw new Error("contest is not open");

  const entrants = [...c.entrants];
  if (c.format !== FORMAT_DUEL && entrants.length < 2) {
    for (const r of loadRoster().agents) {
      if (entrants.length >= 2) break;
      if (entrants.some((e) => e.agentId === r.agentId)) continue;
      await joinContestAsHouse(contestId, r.agentId);
      entrants.push({ agentId: r.agentId, owner: "", isHouse: true });
    }
  }
  if (entrants.length < 2) {
    throw new Error(c.format === FORMAT_DUEL ? "a duel needs two real agents before it can run" : "not enough entrants to run");
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

  // Poker: no SUI table escrow for a contest (the tUSDC pool is the stake). Play, then pay
  // the pool to the winner. House agents cannot win, so if a house seat takes the chips the
  // pool falls to the non-house entrant (with one real entrant, that entrant wins by rule).
  const { winnerAgentId } = await playMatch({ participants, buyinMist: 0n });
  const champ = participants.find((p) => p.agentId === winnerAgentId);
  const winner = champ && !champ.isHouse ? champ : participants.find((p) => !p.isHouse);
  if (!winner) throw new Error("no eligible (non-house) winner");
  await settleContest(contestId, winner.agentId);
}
