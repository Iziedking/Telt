import type { ActionType } from "./types.js";
import { decide, type DecisionContext } from "../runners/pokerRunner.js";
import { planForLevel } from "../reason/levels.js";

// A decision-quality benchmark. Win-rate over short freezeouts is swamped by card luck,
// so it cannot prove a tier is stronger. This isolates skill instead: fix the spot, vary
// only the tier, and score the decision against the textbook-correct play. A stronger
// tier should make the sound play more often. If every tier scores the same, the skill
// prompt is not biting, which is exactly what we want to find out.

export interface BenchmarkSpot {
  name: string;
  category: "discipline" | "value" | "foldout" | "protect" | "edge";
  ctx: DecisionContext; // level and agentName are overwritten per tier
  good: ActionType[]; // the defensible play(s)
  trap: ActionType; // the tempting mistake a weak player makes
  note: string;
}

// Sensible defaults for a heads-up spot; each case overrides what matters.
function mk(partial: Partial<DecisionContext>): DecisionContext {
  return {
    seat: "A",
    agentName: "bench",
    level: 0,
    hole: ["Ac", "Kc"],
    street: "flop",
    board: [],
    pot: 80,
    myStack: 360,
    oppStack: 360,
    myCommitted: 0,
    currentBet: 0,
    toCall: 0,
    canCheck: true,
    canCall: false,
    canRaise: true,
    minRaiseTo: 20,
    maxRaiseTo: 360,
    history: [],
    notes: [],
    ...partial,
  };
}

export const SPOTS: BenchmarkSpot[] = [
  {
    name: "Fold 72o to a big preflop raise",
    category: "discipline",
    ctx: mk({
      hole: ["7c", "2d"],
      street: "preflop",
      pot: 100,
      myCommitted: 20,
      currentBet: 80,
      toCall: 60,
      canCheck: false,
      canCall: true,
      minRaiseTo: 140,
      history: ["B raise 80"],
      oppLastAction: "raise 80",
    }),
    good: ["fold"],
    trap: "call",
    note: "The worst hand in poker facing a 4x raise. Trained players fold; a Mark calls.",
  },
  {
    name: "Raise aces preflop",
    category: "value",
    ctx: mk({
      hole: ["As", "Ad"],
      street: "preflop",
      pot: 30,
      myCommitted: 10,
      currentBet: 20,
      toCall: 10,
      canCheck: false,
      canCall: true,
      minRaiseTo: 40,
      history: [],
    }),
    good: ["raise"],
    trap: "call",
    note: "Pocket aces. Raise for value; limping is a clear leak.",
  },
  {
    name: "Value-bet the nut flush on the river",
    category: "value",
    ctx: mk({
      hole: ["Ah", "Kh"],
      board: ["Qh", "Jh", "Th", "2c", "5d"],
      street: "river",
      pot: 160,
      myStack: 300,
      oppStack: 300,
      history: ["B check"],
      oppLastAction: "check",
    }),
    good: ["raise"],
    trap: "check",
    note: "The nuts, checked to us on the river. Bet for value; checking burns money.",
  },
  {
    name: "Fold 8-high busted draw to a pot-size river bet",
    category: "foldout",
    ctx: mk({
      hole: ["8h", "7h"],
      board: ["Ah", "Kd", "2c", "Js", "3d"],
      street: "river",
      pot: 240,
      currentBet: 120,
      toCall: 120,
      canCheck: false,
      canCall: true,
      minRaiseTo: 240,
      history: ["B bet 120"],
      oppLastAction: "bet 120",
    }),
    good: ["fold"],
    trap: "call",
    note: "Missed everything, facing a big bet. Fold; a calling station pays it off.",
  },
  {
    name: "Continue with top pair top kicker vs a small bet",
    category: "discipline",
    ctx: mk({
      hole: ["Ac", "Kd"],
      board: ["Ah", "9s", "4c"],
      street: "flop",
      pot: 90,
      currentBet: 30,
      toCall: 30,
      canCheck: false,
      canCall: true,
      minRaiseTo: 60,
      history: ["B bet 30"],
      oppLastAction: "bet 30",
    }),
    good: ["call", "raise"],
    trap: "fold",
    note: "Top pair top kicker facing a third-pot bet. Folding here is far too weak.",
  },
  {
    name: "Bet an overpair to protect on a wet board",
    category: "protect",
    ctx: mk({
      hole: ["Ad", "Ac"],
      board: ["9h", "8h", "2s"],
      street: "flop",
      pot: 80,
      history: ["B check"],
      oppLastAction: "check",
    }),
    good: ["raise"],
    trap: "check",
    note: "Overpair on a board full of draws. Bet to charge the draws; checking gives a free card.",
  },
  {
    name: "Fold jack-high to a two-thirds-pot bet",
    category: "foldout",
    ctx: mk({
      hole: ["Js", "4c"],
      board: ["Ah", "Kd", "9s"],
      street: "flop",
      pot: 90,
      currentBet: 60,
      toCall: 60,
      canCheck: false,
      canCall: true,
      minRaiseTo: 120,
      history: ["B bet 60"],
      oppLastAction: "bet 60",
    }),
    good: ["fold"],
    trap: "call",
    note: "No pair, no draw, facing a real bet. Fold and move on.",
  },
  {
    name: "Bet queens for value on a dry turn",
    category: "value",
    ctx: mk({
      hole: ["Qd", "Qs"],
      board: ["Jh", "7c", "2d", "3s"],
      street: "turn",
      pot: 120,
      history: ["B check"],
      oppLastAction: "check",
    }),
    good: ["raise"],
    trap: "check",
    note: "Overpair, checked to on a dry turn. Bet for value rather than slowplay.",
  },
  {
    name: "Thin value: second pair river, checked to",
    category: "edge",
    ctx: mk({
      hole: ["Ad", "9c"],
      board: ["9h", "5s", "2d", "7c", "Kd"],
      street: "river",
      pot: 120,
      history: ["B check"],
      oppLastAction: "check",
    }),
    good: ["raise"],
    trap: "check",
    note: "Second pair, top kicker, checked to on the river. A sophisticated player bets thin; weaker tiers check back.",
  },
];

export interface SpotResult {
  name: string;
  category: string;
  correct: number;
  total: number;
}

export interface TierScore {
  level: number;
  correct: number;
  total: number;
  perSpot: SpotResult[];
}

export async function scoreTier(level: number, reps: number): Promise<TierScore> {
  const plan = planForLevel(level);
  const perSpot: SpotResult[] = [];
  let correct = 0;
  let total = 0;
  for (const spot of SPOTS) {
    let hit = 0;
    for (let r = 0; r < reps; r++) {
      const ctx: DecisionContext = { ...spot.ctx, level, agentName: `L${level}` };
      const decision = await decide(ctx, plan);
      if (spot.good.includes(decision.action)) hit += 1;
    }
    perSpot.push({ name: spot.name, category: spot.category, correct: hit, total: reps });
    correct += hit;
    total += reps;
  }
  return { level, correct, total, perSpot };
}
