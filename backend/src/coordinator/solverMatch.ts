import { generatePuzzles, generatePuzzle } from "../solver/generator.js";
import type { Puzzle } from "../solver/types.js";
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
const SECONDS_PER_QUESTION = 20;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("time")), ms))]);
}

export async function playSolverMatch(opts: SolverMatchOptions = {}): Promise<SolverMatchResult> {
  // Fixed at 10: a large enough sample that the stronger tier wins reliably instead of a small
  // quiz being decided by variance, and a clean two-page grid in the UI.
  const count = opts.puzzles ?? 10;
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

  // Ask one question: broadcast it, let the given players answer (each solve scored, timed, and
  // anchored in the background), then reveal the result. Used for the main round and sudden death.
  const askQuestion = async (idx: number, pz: Puzzle, total: number, who: typeof players): Promise<void> => {
    broadcast({
      type: "puzzle",
      payload: { matchId, index: idx, total, topic: pz.topic, question: pz.question, options: pz.options, grounded: pz.grounded },
    });
    for (const p of who) {
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

      // Anchor in the background so a Walrus write never stalls the quiz: the answer streams now
      // and its proof (serialized, so it cannot race the gas coin) lands later as "answerProven".
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
              payload: { matchId, index: idx, seat: p.key, blobId: proof.blobId, anchorDigest: proof.anchorDigest },
            });
          })
          .catch((e) => console.warn("answer anchor failed:", (e as Error).message));
      }

      broadcast({
        type: "answer",
        payload: {
          matchId,
          index: idx,
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
      payload: { matchId, index: idx, answer: pz.answer, explanation: pz.explanation, sources: pz.sources, scores: { ...scores } },
    });
  };

  for (const [i, pz] of puzzles.entries()) {
    await askQuestion(i, pz, count, players);
  }

  // Sudden death breaks a tie on skill, not speed: higher tiers run more reasoning passes and
  // are inherently slower, so timing them would unfairly punish the stronger model. Instead, if
  // the top scorers are level, ask fresh questions that only the tied agents answer until the
  // score separates. Capped; a genuine dead heat then goes to the higher tier.
  const eligible = players.filter((p) => !p.isHouse);
  const pool = eligible.length ? eligible : players;
  const topScore = () => Math.max(...pool.map((p) => scores[p.key] ?? 0));
  const tiedAtTop = () => pool.filter((p) => (scores[p.key] ?? 0) === topScore());
  let tiebreak: string | null = null;
  const MAX_SUDDEN_DEATH = 6;
  for (let sd = 0; tiedAtTop().length > 1 && sd < MAX_SUDDEN_DEATH; sd++) {
    tiebreak = "sudden death";
    const idx = count + sd;
    const pz = await generatePuzzle(idx);
    await askQuestion(idx, pz, idx + 1, tiedAtTop());
  }
  // Winner: top score (now usually unique). A dead heat that survived sudden death goes to the
  // higher tier, the more capable model.
  const winner = pool.reduce((best, p) => {
    const sp = scores[p.key] ?? 0;
    const sb = scores[best.key] ?? 0;
    if (sp !== sb) return sp > sb ? p : best;
    return p.level > best.level ? p : best;
  }, pool[0]!);
  if (tiebreak === "sudden death" && tiedAtTop().length > 1) tiebreak = "tier";

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
