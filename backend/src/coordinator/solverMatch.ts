import { generatePuzzles } from "../solver/generator.js";
import { solve } from "../solver/solverRunner.js";
import { anchorAnswer } from "../solver/anchorAnswer.js";
import { planForLevel } from "../reason/levels.js";
import { solverSourcesConfigured } from "../solver/sources.js";
import { loadRoster, avowFor, type RosterEntry } from "./roster.js";
import { broadcast } from "./ws.js";
import { recordResult } from "../chain/sui.js";

// A solver match: generate live puzzles, have both agents answer each, anchor every answer
// on Walrus, score against the held-back answers, and record the result on chain. Progress
// streams over /ws so the Arena can show it live, the same way the poker table does.

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
}

export interface SolverMatchResult {
  matchId: string;
  winner: string;
  scores: Record<string, number>;
}

export async function playSolverMatch(opts: SolverMatchOptions = {}): Promise<SolverMatchResult> {
  const count = opts.puzzles ?? 10;
  const doAnchor = opts.anchor ?? true;
  const roster = loadRoster().agents;
  if (roster.length < 2) throw new Error("need at least two agents in the roster");
  const a = roster[0]!;
  const b = roster[1]!;
  const players = [a, b];
  const matchId = `solver-${Date.now()}`;

  broadcast({
    type: "solverMatch",
    payload: {
      matchId,
      puzzleCount: count,
      webGrounded: solverSourcesConfigured(),
      agents: players.map((p) => ({ seat: p.key, name: p.name, level: p.level, agentId: p.agentId })),
    },
  });

  const scores: Record<string, number> = { [a.key]: 0, [b.key]: 0 };
  const agreementTotals: Record<string, number> = { [a.key]: 0, [b.key]: 0 };
  const puzzles = await generatePuzzles(count);

  for (const [i, pz] of puzzles.entries()) {
    broadcast({
      type: "puzzle",
      payload: { matchId, index: i, total: count, topic: pz.topic, question: pz.question, options: pz.options, grounded: pz.grounded },
    });

    for (const p of players) {
      const opponent = p === a ? b : a;
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

  // Winner: more correct answers. Ties go to the more decisive agent (higher summed
  // agreement), and if still even, to the underdog so a weaker model that keeps pace wins.
  const sa = scores[a.key] ?? 0;
  const sb = scores[b.key] ?? 0;
  const ga = agreementTotals[a.key] ?? 0;
  const gb = agreementTotals[b.key] ?? 0;
  let winner: RosterEntry;
  if (sa !== sb) winner = sa > sb ? a : b;
  else if (ga !== gb) winner = ga > gb ? a : b;
  else winner = a.level <= b.level ? a : b;
  const loser = winner === a ? b : a;

  await bestEffort(() => recordResult(winner.agentId, true));
  await bestEffort(() => recordResult(loser.agentId, false));

  broadcast({ type: "solverSettled", payload: { matchId, winnerSeat: winner.key, winnerName: winner.name, scores: { ...scores } } });
  return { matchId, winner: winner.name, scores };
}
