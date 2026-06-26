import { config } from "../config/index.js";
import { createContest, joinContest, settleContest, CONTEST_FORMAT } from "../chain/sui.js";
import { playMatch } from "./table.js";
import { loadRoster, type RosterEntry } from "./roster.js";
import type { Seat } from "../poker/types.js";

// The autopilot keeps the arena busy on its own: on a schedule it opens a contest, seats
// the agents as real entrants, runs the match over the coordinator, and settles the tUSDC
// pool to the winner. It cycles through a rotation of events so each run is a fresh contest.
// House-agent filling lives in the contract (join_as_house) and kicks in once contests have
// more seats than real entrants; the two-agent demo runs real-vs-real duels.

interface AutopilotEvent {
  name: string;
  game: number; // 0 = poker, the only game today
  format: number;
  levelMin: number;
  levelMax: number;
  entryUsdc: bigint;
}

const ROTATION: AutopilotEvent[] = [
  { name: "Open duel", game: 0, format: CONTEST_FORMAT.duel, levelMin: 0, levelMax: 4, entryUsdc: 10_000_000n },
  { name: "High-stakes duel", game: 0, format: CONTEST_FORMAT.duel, levelMin: 0, levelMax: 4, entryUsdc: 25_000_000n },
];

let cycle = 0;
let busy = false;
let running = false;

export interface CycleResult {
  event: string;
  contestId: string;
  winner: string;
  prizeUsdc: number;
}

// One full event: create a contest, both agents enter, play, settle the pool to the winner.
export async function runAutopilotCycle(): Promise<CycleResult> {
  if (busy) throw new Error("an autopilot cycle is already running");
  busy = true;
  try {
    const ev = ROTATION[cycle % ROTATION.length]!;
    cycle += 1;

    const roster = loadRoster();
    const bySeat = {} as Record<Seat, RosterEntry>;
    for (const a of roster.agents) bySeat[a.key] = a;
    const A = bySeat.A;
    const B = bySeat.B;
    if (!A || !B) throw new Error("need two agents (run setup:agents)");

    console.log(`[autopilot] event "${ev.name}", entry ${Number(ev.entryUsdc) / 1e6} tUSDC`);
    const { contestId } = await createContest({
      game: ev.game,
      format: ev.format,
      levelMin: ev.levelMin,
      levelMax: ev.levelMax,
      entryFeeUsdc: ev.entryUsdc,
      maxEntries: 2,
    });
    await joinContest(contestId, A.agentId, ev.entryUsdc);
    await joinContest(contestId, B.agentId, ev.entryUsdc);
    console.log(`[autopilot] contest ${contestId.slice(0, 10)} open, ${A.name} and ${B.name} entered`);

    const { winner } = await playMatch({ intel: { buyerSeat: "A", beforeHand: 1 } });
    const winnerAgent = winner === "A" ? A : B;
    await settleContest(contestId, winnerAgent.agentId);

    const prizeUsdc = (Number(ev.entryUsdc) * 2) / 1e6;
    console.log(`[autopilot] ${winnerAgent.name} won ${prizeUsdc} tUSDC (contest ${contestId.slice(0, 10)})`);
    return { event: ev.name, contestId, winner: winnerAgent.name, prizeUsdc };
  } finally {
    busy = false;
  }
}

// Start the loop: a cycle, then wait, repeat. Survives a failed cycle.
export function startAutopilot(intervalMs: number): void {
  if (running) return;
  running = true;
  const tick = async () => {
    try {
      await runAutopilotCycle();
    } catch (e) {
      console.error("[autopilot] cycle failed:", (e as Error).message);
    }
    setTimeout(tick, intervalMs);
  };
  console.log(`[autopilot] on, every ${Math.round(intervalMs / 1000)}s`);
  setTimeout(tick, 2000);
}

export function autopilotEnabled(): boolean {
  return config.autopilot.enabled;
}
