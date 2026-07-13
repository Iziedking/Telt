import { callModel, type CallResult } from "../reason/client.js";
import type { InferencePlan } from "../reason/levels.js";
import { pokerSkill } from "../skills/poker.js";
import { candidates, solverTier, type ActionCandidate } from "../poker/solver.js";
import type { ActionType, Card, Seat } from "../poker/types.js";

// One agent making one poker decision, as a two-part brain: the engine prices the legal
// actions (poker/solver.ts) and the model chooses among the ones this level is allowed to
// see. The model supplies judgment and the rationale that gets anchored; the engine supplies
// the arithmetic and the guarantee that a high level cannot be handed a losing action.

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
  oppCommitted: number;
  currentBet: number;
  bigBlind: number;
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
  /** The engine's win probability against the opponent's whole range, 0..1. */
  equity: number;
  /** The priced shortlist this level was allowed to choose from. */
  candidates: ActionCandidate[];
  raw: string;
  source: string;
  latencyMs: number;
}

interface Proposal {
  /** Index into the shortlist. The model picks a number, not a move. */
  index: number;
  action: ActionType;
  size: number;
  confidence: number;
  rationale: string;
  raw: string;
}

// The agent is the DECISION HEAD, not the calculator.
//
// It used to be both, and it was bad at the second job in a way no prompt could repair.
// A model cannot price a call, so it called when the odds forbade it; it could not tell a
// made hand from a dead one, so it fired busted draws on the river. That last blunder was
// patched with an explicit "never bet a busted draw" sentence in this very prompt, and the
// level 4 agent went and did it again the same evening.
//
// So the arithmetic moved to the engine (poker/solver.ts). It enumerates the legal actions,
// prices each against a Monte Carlo equity read, and passes a SHORTLIST. Every option on
// that shortlist is already sane; the agent's job is the part a model is genuinely good at,
// which is judgment — which of these good lines fits this opponent, this history, this read
// I paid for. It cannot pick a move that is not on the list, so it cannot punt.
// The EV numbers are DELIBERATELY not in the prompt, and that is the whole lesson of this file.
//
// They were, at first: the shortlist arrived ranked, each line labelled with its expected chips.
// The result was measured and it was humiliating. The model stopped reasoning and started doing
// argmax -- it read the biggest number and returned it. Level 4 took the engine's top line in 100%
// of 72 decisions, never once deviating, so the "agent" was a deterministic heuristic with a
// language model bolted on for decoration. Worse, the tier ladder INVERTED: level 4's five
// self-consistency passes vote, voting converges hard on the biggest number, and so the stronger
// the tier the more perfectly it collapsed onto the engine and inherited every bias in it. Level 0,
// with one noisy pass, deviated 13% of the time, escaped the bias, and beat it by 719 chips a board
// over twenty duplicate boards.
//
// So the engine still decides what is SANE -- every option on the list is a real poker play, and
// the stack-punt is not on it -- but it no longer decides what is BEST. That is the agent's job,
// and it can only be the agent's job if the agent is not handed the answer.
const SYSTEM_PROMPT =
  "You are the decision head of a strong heads-up No-Limit Texas Hold'em agent. The engine has read the board and " +
  "given you your equity and a short list of options. Every option on it is a sound poker play, so there is no " +
  "trap and no wrong answer to be caught out by: your job is to pick the one that beats THIS opponent, right now. " +
  "Use everything you have on them — how they have been betting, what they folded, what they showed down, and any " +
  "intel you bought. A player who folds too much should be bet into; one who never folds should be value-bet and " +
  "never bluffed. Do not invent a move that is not on the list. Reply with ONLY a JSON object, no prose, in this " +
  'form: {"pick":<the number of your chosen option>,"confidence":<0..1>,"rationale":"<one short sentence>"}. ' +
  "Always give the rationale. It is shown to spectators as your thinking and is anchored on chain as your reasoning.";

// The intel decision is the agent's own call: spend a small x402 fee on a dossier when a read is
// worth it, not a scripted one-time purchase. Kept cheap (one short call) so it does not stall play.
const INTEL_SYSTEM =
  "You are a heads-up poker player deciding whether to spend a tiny x402 fee — a fraction of one chip — on a scouting " +
  "dossier of your opponent: a report of their real tendencies, compiled from their anchored move history, that loads " +
  "into your next decisions. This is entirely your own call. Buy it only when a sharper read on your opponent is " +
  "genuinely worth it to you right now — to find an exploit or pressure a weak spot. If you do not need a read, or " +
  "already understand their game, keep your chips. You are free to do whatever is best for you. " +
  'Reply with ONLY JSON: {"buy": true|false, "reason": "<one short sentence>"}.';

export interface IntelChoiceContext {
  agentName: string;
  myChips: number;
  oppName: string;
  oppChips: number;
  handIndex: number;
  bought: number;
  budget: number;
}

export async function wantsIntel(c: IntelChoiceContext, plan: InferencePlan): Promise<{ buy: boolean; reason: string }> {
  const prompt =
    `You are ${c.agentName} with ${c.myChips} chips; your opponent ${c.oppName} has ${c.oppChips}. It is hand ` +
    `${c.handIndex + 1}. You have bought ${c.bought} of your ${c.budget} allowed dossiers this match. ` +
    `Do you want to buy a dossier on ${c.oppName} now?`;
  try {
    const res = await callModel({
      systemPrompt: INTEL_SYSTEM,
      userPrompt: prompt,
      maxTokens: 90,
      temperature: 0.5,
      provider: plan.provider,
      model: plan.model,
    });
    const m = res.text.match(/\{[\s\S]*\}/);
    if (!m) return { buy: false, reason: "" };
    const p = JSON.parse(m[0]) as { buy?: boolean; reason?: string };
    return { buy: Boolean(p.buy), reason: String(p.reason ?? "") };
  } catch {
    return { buy: false, reason: "" };
  }
}

const ACTIONS: ActionType[] = ["fold", "check", "call", "raise"];
// Tie-break priority when votes and confidence are equal: prefer the cheaper, lower-variance line.
const PRIORITY: Record<ActionType, number> = { check: 0, call: 1, fold: 2, raise: 3 };

export async function decide(ctx: DecisionContext, plan: InferencePlan): Promise<Decision> {
  // The engine speaks first. It prices every legal action and hands back only the ones this
  // level is allowed to see: a low level's shortlist still contains real mistakes, a high
  // level's does not. This is where a tier becomes a strength rather than a label.
  const tier = solverTier(ctx.level);
  const { actions: shortlist, equity } = candidates(
    {
      hole: ctx.hole,
      board: ctx.board,
      pot: ctx.pot,
      toCall: ctx.toCall,
      myCommitted: ctx.myCommitted,
      oppCommitted: ctx.oppCommitted,
      myStack: ctx.myStack,
      oppStack: ctx.oppStack,
      bigBlind: ctx.bigBlind,
      legal: {
        canFold: true,
        canCheck: ctx.canCheck,
        canCall: ctx.canCall,
        callAmount: ctx.toCall,
        canRaise: ctx.canRaise,
        minRaiseTo: ctx.minRaiseTo,
        maxRaiseTo: ctx.maxRaiseTo,
      },
    },
    tier,
  );
  const engineBest = shortlist[0]!;

  // A forced move is not a decision. When the tier's rope leaves exactly one sane action,
  // play it and skip the model entirely: it saves a call per decision across a bracket, and
  // there is nothing to judge.
  if (shortlist.length === 1) {
    return {
      action: engineBest.action,
      size: engineBest.size,
      rationale: `Only sane line here: ${engineBest.label}.`,
      confidence: 1,
      samples: 0,
      agreement: 0,
      equity,
      candidates: shortlist,
      raw: "",
      source: "engine",
      latencyMs: 0,
    };
  }

  const userPrompt = buildPrompt(ctx, shortlist);
  // Tier = the shortlist it is handed (above) + reasoning passes + the level's expert skill.
  const systemPrompt = SYSTEM_PROMPT + pokerSkill(ctx.level).system + plan.hint;
  let lastRaw = "";
  let source = "offline-dev";
  const t0 = Date.now();

  // Run the self-consistency passes in parallel: sequentially, a higher tier (more passes, plus
  // any provider fallback latency) takes several times as long, which stalls the table.
  const settled = await Promise.all(
    Array.from({ length: plan.samples }, () =>
      callWithRetry(
        {
          systemPrompt,
          userPrompt,
          maxTokens: plan.maxTokens,
          temperature: plan.temperature,
          provider: plan.provider,
          model: plan.model,
        },
        plan.retries,
      ).catch(() => null),
    ),
  );

  const proposals: Proposal[] = [];
  for (const res of settled) {
    if (!res) continue;
    source = res.source;
    lastRaw = res.text;
    const p = extractPick(res.text, shortlist);
    if (p) proposals.push(p);
  }
  const latencyMs = Date.now() - t0;

  if (proposals.length === 0) {
    // Every pass failed or returned nothing we could read. Play the engine's own best line.
    // This is a far better floor than the old hand-rolled heuristic: it is the same priced
    // action the model was choosing among, so a provider outage costs judgment, not the hand.
    return {
      action: engineBest.action,
      size: engineBest.size,
      rationale: `Engine line: ${engineBest.label}.`,
      confidence: 0,
      samples: plan.samples,
      agreement: 0,
      equity,
      candidates: shortlist,
      raw: lastRaw,
      source,
      latencyMs,
    };
  }

  const chosen = aggregate(proposals);
  return {
    ...chosen,
    samples: plan.samples,
    equity,
    candidates: shortlist,
    raw: lastRaw,
    source,
    latencyMs,
  };
}

// Majority vote over the picked candidates. Because every proposal is now an index into the
// same priced shortlist, the vote is over identical options rather than over free-form moves
// that had to be reconciled afterwards: no median sizing, no illegal-action remapping. Ties
// go to summed confidence, then to the engine's own ranking (the earlier candidate).
function aggregate(proposals: Proposal[]): {
  action: ActionType;
  size: number;
  rationale: string;
  confidence: number;
  agreement: number;
} {
  const buckets = new Map<number, Proposal[]>();
  for (const p of proposals) {
    const arr = buckets.get(p.index) ?? [];
    arr.push(p);
    buckets.set(p.index, arr);
  }

  let bestIndex = proposals[0]!.index;
  let bestScore = -Infinity;
  for (const [index, arr] of buckets) {
    const conf = arr.reduce((s, p) => s + p.confidence, 0);
    // Votes dominate, then summed confidence, then the engine's preference order.
    const score = arr.length * 1000 + conf * 10 - index;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  const arr = buckets.get(bestIndex)!;
  const top = arr.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  return {
    action: top.action,
    size: top.size,
    rationale: top.rationale,
    confidence: top.confidence,
    agreement: arr.length,
  };
}

function buildPrompt(ctx: DecisionContext, shortlist: ActionCandidate[]): string {
  const lines: string[] = [];
  lines.push(`You are ${ctx.agentName} (seat ${ctx.seat}), a level ${ctx.level} agent.`);
  lines.push(`Your hole cards: ${ctx.hole.join(" ")}.`);
  lines.push(`Street: ${ctx.street}. Board: ${ctx.board.length ? ctx.board.join(" ") : "(none yet)"}.`);
  lines.push(`Pot: ${ctx.pot}. Your stack: ${ctx.myStack}. Opponent stack: ${ctx.oppStack}.`);
  lines.push(`You have put ${ctx.myCommitted} in this street; the current bet is ${ctx.currentBet}.`);

  if (ctx.oppLastAction) lines.push(`Opponent's last action: ${ctx.oppLastAction}.`);
  if (ctx.history.length) lines.push(`Recent action: ${ctx.history.slice(-6).join("; ")}.`);
  if (ctx.notes.length) {
    lines.push("");
    lines.push("What you know about this opponent (use it):");
    for (const n of ctx.notes.slice(0, 6)) lines.push(`- ${n}`);
  }

  lines.push("");
  lines.push("Your options here, all of them sound. Choose the one that beats THIS opponent:");
  shortlist.forEach((c, i) => {
    lines.push(`${i + 1}. ${c.label}`);
  });
  lines.push("");
  lines.push(`Reply with the number of your pick (1 to ${shortlist.length}), your confidence, and why.`);
  return lines.join("\n");
}

// Read the model's pick out of its reply and resolve it to a candidate. The pick is an index,
// so there is nothing to sanitize: an out-of-range or unreadable answer is simply discarded
// and the remaining passes decide. If none survive, decide() plays the engine's own best line.
function extractPick(text: string, shortlist: ActionCandidate[]): Proposal | null {
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

  const pick = Number(parsed.pick);
  if (!Number.isFinite(pick)) return null;
  const index = Math.round(pick) - 1; // the prompt is 1-based
  const chosen = shortlist[index];
  if (!chosen) return null;

  let confidence = Number(parsed.confidence ?? 0.5);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.max(0, Math.min(1, confidence));

  const rationale = String(parsed.rationale ?? "").slice(0, 240) || "(no rationale given)";
  return {
    index,
    action: chosen.action,
    size: chosen.size,
    confidence,
    rationale,
    raw: text,
  };
}

// When the model produces nothing usable, fall back to a real hand-strength heuristic rather than
// always folding (which makes every hand look broken). Cards are two chars like "Ah" or "Td".
const RANK_ORDER = "23456789TJQKA";
const cardRank = (c: Card): number => RANK_ORDER.indexOf(c[0]!);

// A rough 0..1 strength: preflop from the hole cards, postflop boosted by how the hole connects
// with the board (pair, two pair, trips, quads). Library-grade accuracy is not needed here; this
// only runs when the model failed, to keep the fallback playing something sensible.
function handStrength(hole: [Card, Card], board: Card[]): number {
  const r1 = cardRank(hole[0]);
  const r2 = cardRank(hole[1]);
  const hi = Math.max(r1, r2);
  const lo = Math.min(r1, r2);
  const pair = r1 === r2;
  const suited = hole[0][1] === hole[1][1];
  let s = pair ? 0.55 + hi / 30 : (hi + lo) / 26 + (suited ? 0.06 : 0) + (hi - lo === 1 ? 0.05 : 0);
  if (board.length) {
    const counts = new Map<number, number>();
    for (const c of [...hole, ...board]) counts.set(cardRank(c), (counts.get(cardRank(c)) ?? 0) + 1);
    const vals = [...counts.values()];
    const maxCount = Math.max(...vals);
    const holeRanks = [r1, r2];
    if (maxCount >= 4) s = 0.97;
    else if (maxCount === 3) s = Math.max(s, 0.85);
    else if (vals.filter((c) => c === 2).length >= 2) s = Math.max(s, 0.78);
    else if (maxCount === 2) {
      const paired = [...counts.entries()].find(([, c]) => c === 2)?.[0];
      s = Math.max(s, paired !== undefined && holeRanks.includes(paired) ? 0.6 : 0.4);
    }
  }
  return Math.max(0, Math.min(1, s));
}

function safeAction(ctx: DecisionContext): { action: ActionType; size: number; rationale: string } {
  const s = handStrength(ctx.hole, ctx.board);
  const potOdds = ctx.toCall > 0 ? ctx.toCall / (ctx.pot + ctx.toCall) : 0;
  if (s >= 0.72 && ctx.canRaise) {
    const size = Math.round(Math.min(ctx.maxRaiseTo, Math.max(ctx.minRaiseTo, ctx.currentBet + ctx.pot * 0.7)));
    return { action: "raise", size, rationale: "Fallback: strong hand, value raise." };
  }
  if (s >= 0.45) {
    if (ctx.canCall && potOdds <= s) return { action: "call", size: 0, rationale: "Fallback: decent hand, price is right." };
    if (ctx.canCheck) return { action: "check", size: 0, rationale: "Fallback: decent hand, take a free card." };
  }
  if (ctx.canCheck) return { action: "check", size: 0, rationale: "Fallback: weak hand, check." };
  if (ctx.canCall && ctx.toCall <= ctx.pot * 0.1) return { action: "call", size: 0, rationale: "Fallback: weak hand, cheap call." };
  return { action: "fold", size: 0, rationale: "Fallback: weak hand, fold." };
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
