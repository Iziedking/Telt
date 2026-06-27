import { callModel } from "../reason/client.js";
import type { InferencePlan } from "../reason/levels.js";
import type { Puzzle } from "./types.js";

// An agent answering a quiz. Same tier dial as poker: a higher tier runs more
// self-consistency passes on a stronger model and votes on the answer.
export interface SolverDecision {
  answer: number; // chosen option index
  rationale: string;
  confidence: number;
  samples: number;
  agreement: number; // how many passes backed the chosen option
}

const SYSTEM =
  "You are answering a multiple-choice question. Reason it through, then choose the single best option by its " +
  'index. Reply with ONLY a JSON object: {"answer":<index>,"confidence":<0..1>,"rationale":"<one short sentence>"}.';

function stripFences(s: string): string {
  return s
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

export async function solve(puzzle: Puzzle, plan: InferencePlan): Promise<SolverDecision> {
  const userPrompt =
    `${puzzle.question}\n\n` + puzzle.options.map((o, i) => `${i}) ${o}`).join("\n") + "\n\nPick the best option.";

  const votes: number[] = [];
  let bestRationale = "";
  let bestConfidence = 0;

  for (let pass = 0; pass < plan.samples; pass++) {
    try {
      const res = await callModel({
        systemPrompt: SYSTEM,
        userPrompt,
        maxTokens: plan.maxTokens,
        temperature: plan.temperature,
        provider: plan.provider,
        model: plan.model,
      });
      const p = JSON.parse(stripFences(res.text)) as { answer?: number; confidence?: number; rationale?: string };
      const a = Number(p.answer);
      if (a >= 0 && a < puzzle.options.length) {
        votes.push(a);
        const conf = Number(p.confidence ?? 0);
        if (conf >= bestConfidence) {
          bestConfidence = conf;
          bestRationale = String(p.rationale ?? "");
        }
      }
    } catch {
      /* a bad pass just does not vote */
    }
  }

  if (votes.length === 0) {
    // A weak model that never produced a parseable choice guesses, rather than always
    // defaulting to the first option (which would bias every failed answer to A).
    return {
      answer: Math.floor(Math.random() * puzzle.options.length),
      rationale: "guessed (no clear answer)",
      confidence: 0,
      samples: plan.samples,
      agreement: 0,
    };
  }

  // Majority vote on the option index.
  const tally = new Map<number, number>();
  for (const v of votes) tally.set(v, (tally.get(v) ?? 0) + 1);
  let answer = votes[0]!;
  let agreement = 0;
  for (const [opt, n] of tally) {
    if (n > agreement) {
      agreement = n;
      answer = opt;
    }
  }
  return { answer, rationale: bestRationale, confidence: bestConfidence, samples: plan.samples, agreement };
}
