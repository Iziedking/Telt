import { readContest, joinContest, settleContest } from "../chain/sui.js";
import { loadRoster } from "./roster.js";
import { provisionAgentEntry, type Participant } from "./provision.js";
import { playSolverMatch } from "./solverMatch.js";
import { playMatch } from "./table.js";
import type { Seat } from "../poker/types.js";

// Run a contest with its entrants. General contests can be filled by platform agents seated
// as real competitors, so an unjoined contest still runs and pays out; duels stay
// platform-free, so a duel only runs once two real agents have joined. The pool settles to
// the match winner.
const GAME_SOLVER = 1;
const FORMAT_DUEL = 0;

export async function runContest(contestId: string, opts: { puzzles?: number } = {}): Promise<void> {
  const c = await readContest(contestId);
  if (!c) throw new Error("contest not found");
  if (c.status !== 0) throw new Error("contest is not open");

  const entrants = [...c.entrants];
  // Fill a general contest with platform agents (real entrants, eligible to win) up to two
  // seats. Duels are never filled.
  if (c.format !== FORMAT_DUEL && entrants.length < 2) {
    for (const r of loadRoster().agents) {
      if (entrants.length >= 2) break;
      if (entrants.some((e) => e.agentId === r.agentId)) continue;
      await joinContest(contestId, r.agentId, c.entryFee);
      entrants.push({ agentId: r.agentId, owner: "", isHouse: false });
    }
  }
  if (entrants.length < 2) {
    throw new Error(
      c.format === FORMAT_DUEL ? "a duel needs two real agents before it can run" : "not enough entrants to run",
    );
  }

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

  // Poker: no SUI table escrow for a contest (the tUSDC pool is the stake). Play, then pay
  // the pool to the match winner.
  const { winnerAgentId } = await playMatch({ participants, buyinMist: 0n });
  await settleContest(contestId, winnerAgentId);
}
