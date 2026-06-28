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

export async function playSolverMatch(opts: SolverMatchOptions = {}): Promise<SolverMatchResult> {
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
  for (const p of players) {
    scores[p.key] = 0;
    agreementTotals[p.key] = 0;
  }
  const puzzles = await generatePuzzles(count);

  for (const [i, pz] of puzzles.entries()) {
    broadcast({
      type: "puzzle",
      payload: { matchId, index: i, total: count, topic: pz.topic, question: pz.question, options: pz.options, grounded: pz.grounded },
    });

    for (const p of players) {
      const opponent = players.find((q) => q.agentId !== p.agentId) ?? p;
      const d = await solve(pz, planForLevel(p.level));
      const correct = d.answer === pz.answer;
      if (correct) scores[p.key] = (scores[p.key] ?? 0) + 1;
      agreementTotals[p.key] = (agreementTotals[p.key] ?? 0) + d.agreement;

      const anchored = doAnchor
        ? await bestEffort(() =>
            anchorAnswer(avowFor(p), {
              puzzle: pz,
              choice: d.answer,
              correct,
              rationale: d.rationale,
              opponentAgentId: opponent.agentId,
            }),
          )
        : null;

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
          blobId: anchored?.blobId ?? null,
          evidenceHash: anchored?.evidenceHashHex ?? null,
          anchorDigest: anchored?.anchorDigest ?? null,
          withinMandate: anchored?.anchorDigest ? true : null,
        },
      });
    }

    broadcast({
      type: "puzzleResult",
      payload: { matchId, index: i, answer: pz.answer, explanation: pz.explanation, sources: pz.sources, scores: { ...scores } },
    });
  }

  // Winner: most correct among non-house agents. Ties go to the more decisive agent (higher
  // summed agreement), then to the underdog so a weaker model that keeps pace is rewarded.
  const eligible = players.filter((p) => !p.isHouse);
  const pool = eligible.length ? eligible : players;
  const winner = pool.reduce((best, p) => {
    const sp = scores[p.key] ?? 0;
    const sb = scores[best.key] ?? 0;
    if (sp !== sb) return sp > sb ? p : best;
    const gp = agreementTotals[p.key] ?? 0;
    const gb = agreementTotals[best.key] ?? 0;
    if (gp !== gb) return gp > gb ? p : best;
    return p.level <= best.level ? p : best;
  }, pool[0]!);

  // Record win/loss for real players only; platform agents are never graded. Pay out the
  // contest pool if this was one.
  for (const p of eligible) {
    if (isPlatformAgent(p.agentId)) continue;
    await bestEffort(() => recordResult(p.agentId, p.agentId === winner.agentId));
  }
  if (opts.contestId) await bestEffort(() => settleContest(opts.contestId!, winner.agentId));

  broadcast({ type: "solverSettled", payload: { matchId, winnerSeat: winner.key, winnerName: winner.name, scores: { ...scores } } });
  return { matchId, winner: winner.name, winnerAgentId: winner.agentId, scores };
}
