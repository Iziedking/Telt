import { callModel, type CallResult } from "../reason/client.js";
import type { InferencePlan } from "../reason/levels.js";
import { pokerSkill } from "../skills/poker.js";
import type { ActionType, Card, Seat } from "../poker/types.js";

// One agent making one poker decision. The whole point of Telt lives in callModel:
// the action is produced by a Claude Haiku call, and the level's InferencePlan decides
// how hard the agent thinks. Higher levels run more self-consistency passes and vote,
// so a trained agent reliably out-decides the baseline. Everything else here is the
// thin shell around that one call, plus the parsing that turns the reply into a legal
// action and the proof-friendly rationale.

export interface DecisionContext {
  seat: Seat;
  agentName: string;
  level: number;
  hole: [Card, Card];
  street: string;
  board: Card[];
  pot: number;
  myStack: number;
  oppStack: number;
  myCommitted: number;
  currentBet: number;
  toCall: number;
  canCheck: boolean;
  canCall: boolean;
  canRaise: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
  oppLastAction?: string;
  history: string[];
  notes: string[];
}

export interface Decision {
  action: ActionType;
  size: number;
  rationale: string;
  confidence: number;
  /** How many self-consistency passes ran. */
  samples: number;
  /** How many passes backed the chosen action. */
  agreement: number;
  raw: string;
  source: string;
  latencyMs: number;
}

interface Proposal {
  action: ActionType;
  size: number;
  confidence: number;
  rationale: string;
  raw: string;
}

// Every tier is told to play well. The difference between tiers is the model executing
// this advice (cheap and weak at level 0, Haiku at level 4) plus the reasoning passes
// and the expert skill, not a prompt telling anyone to play badly.
const SYSTEM_PROMPT =
  "You are a sharp, disciplined heads-up No-Limit Texas Hold'em player. You are given the full " +
  "state and the exact legal actions. Reply with ONLY a JSON object, no prose, in this form: " +
  '{"action":"fold|check|call|raise","size":<integer>,"confidence":<0..1>,"rationale":"<one short sentence>"}. ' +
  "For a raise, `size` is the TOTAL amount to raise your street bet TO (between the stated min and max); " +
  "use 0 for any non-raise. Pick the highest-expected-value action. Fold weak hands, value-bet strong ones, " +
  "and bluff selectively when the story is credible.";

const ACTIONS: ActionType[] = ["fold", "check", "call", "raise"];
// Tie-break priority when votes and confidence are equal: prefer the cheaper, lower-variance line.
const PRIORITY: Record<ActionType, number> = { check: 0, call: 1, fold: 2, raise: 3 };

export async function decide(ctx: DecisionContext, plan: InferencePlan): Promise<Decision> {
  const userPrompt = buildPrompt(ctx);
  // Tier = reasoning (plan.samples passes) + training (the level's expert skill, injected
  // into the system prompt). A higher tier both thinks more and knows more.
  const systemPrompt = SYSTEM_PROMPT + pokerSkill(ctx.level).system + plan.hint;
  const proposals: Proposal[] = [];
  let latencyMs = 0;
  let lastRaw = "";
  let source = "offline-dev";

  for (let pass = 0; pass < plan.samples; pass++) {
    let res: CallResult;
    try {
      res = await callWithRetry(
        {
          systemPrompt,
          userPrompt,
          maxTokens: plan.maxTokens,
          temperature: plan.temperature,
          provider: plan.provider,
          model: plan.model,
        },
        plan.retries,
      );
    } catch {
      continue;
    }
    latencyMs += res.latencyMs;
    source = res.source;
    lastRaw = res.text;
    const p = extractProposal(res.text, ctx);
    if (p) proposals.push(p);
  }

  if (proposals.length === 0) {
    // The model never returned a parseable action. Fall back to the safest legal line.
    const safe = safeAction(ctx);
    return {
      ...safe,
      confidence: 0,
      samples: plan.samples,
      agreement: 0,
      raw: lastRaw,
      source,
      latencyMs,
    };
  }

  const chosen = aggregate(proposals);
  return { ...chosen, samples: plan.samples, raw: lastRaw, source, latencyMs };
}

// Majority vote over the proposed actions; ties go to summed confidence, then to the
// lower-variance line. For a raise, take the median proposed size; the rationale and
// confidence come from the most confident proposal of the winning action.
function aggregate(proposals: Proposal[]): {
  action: ActionType;
  size: number;
  rationale: string;
  confidence: number;
  agreement: number;
} {
  const buckets = new Map<ActionType, Proposal[]>();
  for (const p of proposals) {
    const arr = buckets.get(p.action) ?? [];
    arr.push(p);
    buckets.set(p.action, arr);
  }

  let best: ActionType = proposals[0]!.action;
  let bestScore = -Infinity;
  for (const a of ACTIONS) {
    const arr = buckets.get(a);
    if (!arr || arr.length === 0) continue;
    const count = arr.length;
    const conf = arr.reduce((s, p) => s + p.confidence, 0);
    // count dominates, then summed confidence, then priority (lower is better).
    const score = count * 1000 + conf * 10 - PRIORITY[a];
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }

  const arr = buckets.get(best)!;
  const top = arr.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  const size = best === "raise" ? median(arr.map((p) => p.size)) : 0;
  return { action: best, size, rationale: top.rationale, confidence: top.confidence, agreement: arr.length };
}

function buildPrompt(ctx: DecisionContext): string {
  const lines: string[] = [];
  lines.push(`You are ${ctx.agentName} (seat ${ctx.seat}), a level ${ctx.level} agent.`);
  lines.push(`Your hole cards: ${ctx.hole.join(" ")}.`);
  lines.push(`Street: ${ctx.street}. Board: ${ctx.board.length ? ctx.board.join(" ") : "(none yet)"}.`);
  lines.push(`Pot: ${ctx.pot}. Your stack: ${ctx.myStack}. Opponent stack: ${ctx.oppStack}.`);
  lines.push(`You have put ${ctx.myCommitted} in this street; the current bet is ${ctx.currentBet}.`);

  const opts: string[] = ["fold"];
  if (ctx.canCheck) opts.push("check");
  if (ctx.canCall) opts.push(`call ${ctx.toCall}`);
  if (ctx.canRaise) opts.push(`raise to between ${ctx.minRaiseTo} and ${ctx.maxRaiseTo}`);
  lines.push(`Legal actions: ${opts.join(", ")}.`);

  if (ctx.oppLastAction) lines.push(`Opponent's last action: ${ctx.oppLastAction}.`);
  if (ctx.history.length) lines.push(`Recent action: ${ctx.history.slice(-6).join("; ")}.`);
  if (ctx.notes.length) {
    lines.push("");
    lines.push("What you know about this opponent (use it):");
    for (const n of ctx.notes.slice(0, 6)) lines.push(`- ${n}`);
  }
  lines.push("");
  lines.push("Decide your action now.");
  return lines.join("\n");
}

// Strip optional code fences, find the first JSON object, and normalize it into a legal
// proposal. Tolerant by design: the model often wraps JSON in ```json fences.
function extractProposal(text: string, ctx: DecisionContext): Proposal | null {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) t = fence[1].trim();
  const obj = t.match(/\{[\s\S]*\}/);
  if (!obj) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(obj[0]) as Record<string, unknown>;
  } catch {
    return null;
  }

  let action = String(parsed.action ?? "").toLowerCase().trim();
  if (action === "bet") action = "raise";
  if (!ACTIONS.includes(action as ActionType)) return null;

  let a = action as ActionType;
  // Map to a legal action so a stray choice never desyncs from the engine.
  if (a === "check" && !ctx.canCheck) a = ctx.canCall ? "call" : "fold";
  if (a === "call" && !ctx.canCall) a = ctx.canCheck ? "check" : "fold";
  if (a === "raise" && !ctx.canRaise) a = ctx.canCall ? "call" : "check";

  let size = Number(parsed.size ?? 0);
  if (!Number.isFinite(size)) size = 0;
  if (a === "raise") {
    size = Math.round(Math.max(ctx.minRaiseTo, Math.min(size || ctx.minRaiseTo, ctx.maxRaiseTo)));
  } else {
    size = 0;
  }

  let confidence = Number(parsed.confidence ?? 0.5);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.max(0, Math.min(1, confidence));

  const rationale = String(parsed.rationale ?? "").slice(0, 240) || "(no rationale given)";
  return { action: a, size, confidence, rationale, raw: text };
}

function safeAction(ctx: DecisionContext): { action: ActionType; size: number; rationale: string } {
  if (ctx.canCheck) return { action: "check", size: 0, rationale: "Fallback: check, no parseable decision." };
  if (ctx.canCall && ctx.toCall <= ctx.pot) return { action: "call", size: 0, rationale: "Fallback: call a small bet." };
  return { action: "fold", size: 0, rationale: "Fallback: fold to pressure." };
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

async function callWithRetry(opts: Parameters<typeof callModel>[0], retries: number): Promise<CallResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await callModel(opts);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
    }
  }
  throw lastErr;
}
