import { generatePuzzles } from "../solver/generator.js";
import { solve } from "../solver/solverRunner.js";
import { anchorAnswer } from "../solver/anchorAnswer.js";
import { planForLevel } from "../reason/levels.js";
import { solverSourcesConfigured } from "../solver/sources.js";
import { loadRoster, avowFor, isPlatformAgent } from "./roster.js";
import { type Participant } from "./provision.js";
import { broadcast } from "./ws.js";
import { recordResult, settleContest } from "../chain/sui.js";

// A solver match: generate live puzzles, have every seated agent answer each, anchor every
// answer on Walrus, score against the held-back answers, and settle. Seats whoever is
// passed in (a user's agent and/or platform agents); defaults to the two platform agents.
// House agents play but cannot win or take a payout. Progress streams over /ws.

async function bestEffort<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    console.error("[solver]", (e as Error).message);
    return null;
  }
}

export interface SolverMatchOptions {
  puzzles?: number;
  // Anchoring writes to Walrus and Sui; turn it off for a quick dry run.
  anchor?: boolean;
  // Who plays. Defaults to the first two platform agents.
  participants?: Participant[];
  // If set, the contest pool pays out to the winner instead of just recording a result.
  contestId?: string;
}

export interface SolverMatchResult {
  matchId: string;
  winner: string;
  winnerAgentId: string;
  scores: Record<string, number>;
}

// A round is a random 10, 15, 20, 25, or 30 questions. Each agent gets a fixed, fair window
// to answer a question (enough for the top tier's reasoning passes, tight enough to matter);
// exceed it and the answer does not count.
const QUESTION_COUNTS = [10, 15, 20, 25, 30];
const SECONDS_PER_QUESTION = 20;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("time")), ms))]);
}

export async function playSolverMatch(opts: SolverMatchOptions = {}): Promise<SolverMatchResult> {
  const count = opts.puzzles ?? QUESTION_COUNTS[Math.floor(Math.random() * QUESTION_COUNTS.length)]!;
  const doAnchor = opts.anchor ?? true;
  const players: Participant[] = opts.participants ?? loadRoster().agents.slice(0, 2).map((e) => ({ ...e }));
  if (players.length < 2) throw new Error("need at least two agents to play");
  const matchId = `solver-${Date.now()}`;

  broadcast({
    type: "solverMatch",
    payload: {
      matchId,
      puzzleCount: count,
      secondsPerQuestion: SECONDS_PER_QUESTION,
      webGrounded: solverSourcesConfigured(),
      agents: players.map((p) => ({
        seat: p.key,
        name: p.name,
        level: p.level,
        agentId: p.agentId,
        platform: isPlatformAgent(p.agentId),
      })),
    },
  });

  const scores: Record<string, number> = {};
  const agreementTotals: Record<string, number> = {};
  const timeTotals: Record<string, number> = {}; // cumulative answer time (ms), the tie-breaker
  for (const p of players) {
    scores[p.key] = 0;
    agreementTotals[p.key] = 0;
    timeTotals[p.key] = 0;
  }
  const puzzles = await generatePuzzles(count);

  // Send the whole question set up front (without answers) so the UI can lay them all out and
  // fill in agents' choices as they come.
  broadcast({
    type: "solverPuzzles",
    payload: {
      matchId,
      puzzles: puzzles.map((p, i) => ({
        index: i,
        topic: p.topic,
        question: p.question,
        options: p.options,
        grounded: p.grounded,
      })),
    },
  });

  for (const [i, pz] of puzzles.entries()) {
    broadcast({
      type: "puzzle",
      payload: { matchId, index: i, total: count, topic: pz.topic, question: pz.question, options: pz.options, grounded: pz.grounded },
    });

    for (const p of players) {
      const opponent = players.find((q) => q.agentId !== p.agentId) ?? p;
      const t0 = Date.now();
      const d = await withTimeout(solve(pz, planForLevel(p.level)), SECONDS_PER_QUESTION * 1000).catch(() => ({
        answer: -1,
        rationale: "ran out of time",
        confidence: 0,
        samples: 0,
        agreement: 0,
      }));
      timeTotals[p.key] = (timeTotals[p.key] ?? 0) + (Date.now() - t0);
      const correct = d.answer === pz.answer;
      if (correct) scores[p.key] = (scores[p.key] ?? 0) + 1;
      agreementTotals[p.key] = (agreementTotals[p.key] ?? 0) + d.agreement;

      // Anchor in the background so a Walrus write never stalls the quiz: the answer streams
      // now and its proof (serialized, so it cannot race the gas coin) lands a moment later
      // as an "answerProven" update.
      if (doAnchor) {
        void anchorAnswer(avowFor(p), {
          puzzle: pz,
          choice: d.answer,
          correct,
          rationale: d.rationale,
          opponentAgentId: opponent.agentId,
        })
          .then((proof) => {
            broadcast({
              type: "answerProven",
              payload: { matchId, index: i, seat: p.key, blobId: proof.blobId, anchorDigest: proof.anchorDigest },
            });
          })
          .catch((e) => console.warn("answer anchor failed:", (e as Error).message));
      }

      broadcast({
        type: "answer",
        payload: {
          matchId,
          index: i,
          seat: p.key,
          agentName: p.name,
          agentId: p.agentId,
          level: p.level,
          choice: d.answer,
          correct,
          rationale: d.rationale,
          samples: d.samples,
          agreement: d.agreement,
          blobId: null,
          evidenceHash: null,
          anchorDigest: null,
          withinMandate: null,
        },
      });
    }

    broadcast({
      type: "puzzleResult",
      payload: { matchId, index: i, answer: pz.answer, explanation: pz.explanation, sources: pz.sources, scores: { ...scores } },
    });
  }

  // Winner: most correct among non-house agents. A tie is broken on speed (lowest total answer
  // time), then on conviction (higher summed agreement), then in favour of the underdog (lower
  // level) so a weaker model that keeps pace is rewarded. Every step is deterministic.
  const eligible = players.filter((p) => !p.isHouse);
  const pool = eligible.length ? eligible : players;
  const ranked = [...pool].sort((a, b) => {
    const ds = (scores[b.key] ?? 0) - (scores[a.key] ?? 0);
    if (ds !== 0) return ds;
    const dt = (timeTotals[a.key] ?? 0) - (timeTotals[b.key] ?? 0); // faster first
    if (dt !== 0) return dt;
    const dg = (agreementTotals[b.key] ?? 0) - (agreementTotals[a.key] ?? 0);
    if (dg !== 0) return dg;
    return a.level - b.level; // underdog
  });
  const winner = ranked[0]!;
  const runnerUp = ranked[1];
  // Name how the win was decided so a tie is never just "2 to 2" with no reason.
  let tiebreak: string | null = null;
  if (runnerUp && (scores[winner.key] ?? 0) === (scores[runnerUp.key] ?? 0)) {
    tiebreak =
      (timeTotals[winner.key] ?? 0) !== (timeTotals[runnerUp.key] ?? 0)
        ? "speed"
        : (agreementTotals[winner.key] ?? 0) !== (agreementTotals[runnerUp.key] ?? 0)
          ? "conviction"
          : "tier";
  }

  // Record win/loss for real players only; platform agents are never graded. Pay out the
  // contest pool if this was one.
  for (const p of eligible) {
    if (isPlatformAgent(p.agentId)) continue;
    await bestEffort(() => recordResult(p.agentId, p.agentId === winner.agentId));
  }
  if (opts.contestId) await bestEffort(() => settleContest(opts.contestId!, winner.agentId));

  broadcast({
    type: "solverSettled",
    payload: { matchId, winnerSeat: winner.key, winnerName: winner.name, scores: { ...scores }, tiebreak },
  });
  return { matchId, winner: winner.name, winnerAgentId: winner.agentId, scores };
}
