import { config } from "../config/index.js";
import { createContest, fundContest, joinContest, settleContest, CONTEST_FORMAT } from "../chain/sui.js";
import { playMatch } from "./table.js";
import { loadRoster, type RosterEntry } from "./roster.js";
import type { Seat } from "../poker/types.js";

// The autopilot keeps the arena busy on its own: on a schedule it opens a contest, seats
// the agents as real entrants, runs the match over the coordinator, and settles the tUSDC
// pool to the winner. It cycles through a rotation of events so each run is a fresh contest.
// House-agent filling lives in the contract (join_as_house) and kicks in once contests have
// more seats than real entrants; the two-agent demo runs real-vs-real duels.

// A mission's reward is random, so no two are the same. The platform funds the reward and
// the agents compete for it. A bigger reward means a tougher, more sensitive mission.
function randomReward(): number {
  return 50 + Math.floor(Math.random() * 71); // 50..120 tUSDC
}

interface Difficulty {
  label: string;
  sensitivity: number; // 1..3
}
function difficultyFor(reward: number): Difficulty {
  if (reward >= 100) return { label: "Critical", sensitivity: 3 };
  if (reward >= 75) return { label: "Hard", sensitivity: 2 };
  return { label: "Standard", sensitivity: 1 };
}

// The difficulty tiers, for display: higher reward, tougher and more sensitive.
export function difficultyTiers() {
  return [
    { label: "Standard", range: "50-74 tUSDC", sensitivity: 1 },
    { label: "Hard", range: "75-99 tUSDC", sensitivity: 2 },
    { label: "Critical", range: "100-120 tUSDC", sensitivity: 3 },
  ];
}

let busy = false;
let running = false;

export interface CycleResult {
  event: string;
  difficulty: string;
  sensitivity: number;
  rewardUsdc: number;
  contestId: string;
  winner: string;
  at: number;
}

// Recent finished missions, newest first, for the Contests view.
const recent: CycleResult[] = [];
export function recentContests(): CycleResult[] {
  return recent.slice(0, 20);
}

// One full mission: the platform funds a random reward, both agents enter free, they play,
// and the winner takes the reward.
export async function runAutopilotCycle(): Promise<CycleResult> {
  if (busy) throw new Error("an autopilot cycle is already running");
  busy = true;
  try {
    const reward = randomReward();
    const diff = difficultyFor(reward);
    const rewardBase = BigInt(reward) * 1_000_000n;
    const name = `${diff.label} mission`;

    const roster = loadRoster();
    const bySeat = {} as Record<Seat, RosterEntry>;
    for (const a of roster.agents) bySeat[a.key] = a;
    const A = bySeat.A;
    const B = bySeat.B;
    if (!A || !B) throw new Error("need two agents (run setup:agents)");

    console.log(`[autopilot] ${name}, reward ${reward} tUSDC (sensitivity ${diff.sensitivity})`);
    const { contestId } = await createContest({
      game: 0,
      format: CONTEST_FORMAT.duel,
      levelMin: 0,
      levelMax: 4,
      entryFeeUsdc: 0n, // missions are platform-funded; agents enter free
      maxEntries: 2,
    });
    await fundContest(contestId, rewardBase); // the platform puts up the reward
    await joinContest(contestId, A.agentId, 0n);
    await joinContest(contestId, B.agentId, 0n);
    console.log(`[autopilot] contest ${contestId.slice(0, 10)} open, ${A.name} and ${B.name} entered`);

    const { winner } = await playMatch({ intel: { buyerSeat: "A", beforeHand: 1 } });
    const winnerAgent = winner === "A" ? A : B;
    await settleContest(contestId, winnerAgent.agentId);

    console.log(`[autopilot] ${winnerAgent.name} won the ${diff.label} mission, ${reward} tUSDC`);
    const result: CycleResult = {
      event: name,
      difficulty: diff.label,
      sensitivity: diff.sensitivity,
      rewardUsdc: reward,
      contestId,
      winner: winnerAgent.name,
      at: Date.now(),
    };
    recent.unshift(result);
    return result;
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
