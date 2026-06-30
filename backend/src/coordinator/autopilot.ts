import { config } from "../config/index.js";
import { createContest, fundContest, joinContest, settleContest, CONTEST_FORMAT } from "../chain/sui.js";
import { playMatch } from "./table.js";
import { playSolverMatch } from "./solverMatch.js";
import { loadRoster, type RosterEntry } from "./roster.js";
import { markDifficulty, openContestWindow, levelBandFor } from "./contestKinds.js";
import type { Seat } from "../poker/types.js";

// Games the autopilot rotates through. 0 = poker, 1 = solver.
const GAME_POKER = 0;
const GAME_SOLVER = 1;

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
  if (reward >= 100) return { label: "Elite", sensitivity: 3 };
  if (reward >= 75) return { label: "Hard", sensitivity: 2 };
  return { label: "Standard", sensitivity: 1 };
}

// The difficulty tiers, for display: higher reward, tougher and more sensitive.
export function difficultyTiers() {
  return [
    { label: "Standard", range: "50-74 tUSDC", sensitivity: 1 },
    { label: "Hard", range: "75-99 tUSDC", sensitivity: 2 },
    { label: "Elite", range: "100-120 tUSDC", sensitivity: 3 },
  ];
}

let busy = false;
let running = false;

export interface CycleResult {
  event: string;
  game: string;
  difficulty: string;
  sensitivity: number;
  rewardUsdc: number;
  contestId: string;
  winner: string;
  at: number;
}

// Alternate poker and solver each cycle so both games stay live in the rotation.
let cycleCount = 0;

// Recent finished missions, newest first, for the Contests view.
const recent: CycleResult[] = [];
export function recentContests(): CycleResult[] {
  return recent.slice(0, 20);
}

// Open a platform-funded contest and leave it for the join window: a random difficulty sets
// the pool and the level band (the hardest are restricted to the top tiers). Real players can
// enter during the window; if nobody does, the due-sweeper runs it as a platform demo.
export async function openAutopilotContest(): Promise<void> {
  const reward = randomReward();
  const diff = difficultyFor(reward);
  const [levelMin, levelMax] = levelBandFor(diff.label);
  const game = cycleCount++ % 2 === 0 ? GAME_POKER : GAME_SOLVER;
  const gameName = game === GAME_SOLVER ? "solver" : "poker";
  const rewardBase = BigInt(reward) * 1_000_000n;

  const { contestId } = await createContest({
    game,
    format: CONTEST_FORMAT.multi,
    levelMin,
    levelMax,
    entryFeeUsdc: 0n, // platform-funded: players enter free
    maxEntries: 2,
  });
  await fundContest(contestId, rewardBase);
  markDifficulty(contestId, diff.label);
  openContestWindow(contestId);
  console.log(
    `[autopilot] opened a ${diff.label} ${gameName} contest ${contestId.slice(0, 10)}, pool ${reward} tUSDC, L${levelMin}-${levelMax}`,
  );
}

// One full mission run immediately, end to end (used by the manual "Run a mission now"): the
// platform funds a reward, both platform agents enter and play, and the winner takes it.
export async function runAutopilotCycle(): Promise<CycleResult> {
  if (busy) throw new Error("an autopilot cycle is already running");
  busy = true;
  try {
    const reward = randomReward();
    const diff = difficultyFor(reward);
    const [levelMin, levelMax] = levelBandFor(diff.label);
    const rewardBase = BigInt(reward) * 1_000_000n;
    const game = cycleCount++ % 2 === 0 ? GAME_POKER : GAME_SOLVER;
    const gameName = game === GAME_SOLVER ? "solver" : "poker";
    const name = `${diff.label} ${gameName} mission`;

    const roster = loadRoster();
    const bySeat = {} as Record<Seat, RosterEntry>;
    for (const a of roster.agents) bySeat[a.key] = a;
    const A = bySeat.A;
    const B = bySeat.B;
    if (!A || !B) throw new Error("need two agents (run setup:agents)");

    console.log(`[autopilot] ${name}, reward ${reward} tUSDC (sensitivity ${diff.sensitivity})`);
    // General (multi) contests, so platform agents are allowed to fill them; duels stay
    // platform-free for real agent-vs-agent challenges.
    const { contestId } = await createContest({
      game,
      format: CONTEST_FORMAT.multi,
      levelMin,
      levelMax,
      entryFeeUsdc: 0n, // missions are platform-funded; agents enter free
      maxEntries: 2,
    });
    markDifficulty(contestId, diff.label);
    await fundContest(contestId, rewardBase); // the platform puts up the reward
    await joinContest(contestId, A.agentId, 0n);
    await joinContest(contestId, B.agentId, 0n);
    console.log(`[autopilot] contest ${contestId.slice(0, 10)} open, ${A.name} and ${B.name} entered`);

    let winnerName: string;
    if (game === GAME_SOLVER) {
      // playSolverMatch settles the contest pool to the winner itself.
      const res = await playSolverMatch({
        puzzles: 6,
        participants: [
          { ...A, key: "A" },
          { ...B, key: "B" },
        ],
        contestId,
      });
      winnerName = res.winner;
    } else {
      const { winner } = await playMatch({ intel: { buyerSeat: "A", beforeHand: 1 } });
      const winnerAgent = winner === "A" ? A : B;
      await settleContest(contestId, winnerAgent.agentId);
      winnerName = winnerAgent.name;
    }

    console.log(`[autopilot] ${winnerName} won the ${diff.label} ${gameName} mission, ${reward} tUSDC`);
    const result: CycleResult = {
      event: name,
      game: gameName,
      difficulty: diff.label,
      sensitivity: diff.sensitivity,
      rewardUsdc: reward,
      contestId,
      winner: winnerName,
      at: Date.now(),
    };
    recent.unshift(result);
    return result;
  } finally {
    busy = false;
  }
}

// Open one demo contest at a random minute inside each configured daily window (morning,
// noon, evening by default), then replan just after midnight. Change AUTOPILOT_WINDOWS in
// the env to control how often and when it runs.
export function startAutopilot(): void {
  if (running) return;
  running = true;
  const windows = config.autopilot.windows;
  if (windows.length === 0) {
    console.log("[autopilot] enabled but no windows configured (set AUTOPILOT_WINDOWS)");
    return;
  }

  const planDay = () => {
    const now = new Date();
    for (const [startH, endH] of windows) {
      const startMin = startH * 60;
      const endMin = endH * 60;
      const randMin = startMin + Math.floor(Math.random() * (endMin - startMin));
      const fire = new Date(now);
      fire.setHours(Math.floor(randMin / 60), randMin % 60, 0, 0);
      const delay = fire.getTime() - now.getTime();
      if (delay > 0) {
        setTimeout(() => {
          openAutopilotContest().catch((e) => console.error("[autopilot] open failed:", (e as Error).message));
        }, delay);
        console.log(`[autopilot] ${startH}-${endH}h contest scheduled for ${fire.toTimeString().slice(0, 5)}`);
      }
    }
    // Replan tomorrow's windows just after midnight.
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(0, 1, 0, 0);
    setTimeout(planDay, tomorrow.getTime() - now.getTime());
  };

  console.log(`[autopilot] on, ${windows.length} contests a day at random times in the configured windows`);
  planDay();
}

export function autopilotEnabled(): boolean {
  return config.autopilot.enabled;
}
