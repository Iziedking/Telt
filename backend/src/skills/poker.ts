// Per-tier expert skill modules for heads-up poker, the training axis. A tier is two
// things: how hard the agent thinks (reasoning passes, in reason/levels.ts) and what
// it knows (this expert skill, injected into the decision prompt). A higher tier both
// reasons more and plays from deeper strategy, so the gap between levels is real, not
// cosmetic. Level 0 is untrained; level 4 is grandmaster.
//
// Other games (chess, solver) will carry their own skill ladders with the same shape,
// so a level-4 chess agent and a level-4 poker agent both hold the top skill for their
// game, but they are different modules.

export interface ExpertSkill {
  /** Short tier label for the UI. */
  name: string;
  /** One-line description of what this tier brings. */
  brief: string;
  /** Strategy knowledge appended to the agent's system prompt at decision time. */
  system: string;
}

// Tier names are Telt Foundation ranks, a progression of tell-reading mastery: the
// untrained Mark up to the all-seeing Oracle. The brand is the tell, proven.
// A positive knowledge ladder, not a handicap: every tier is asked to play well, and the
// higher tiers carry more strategy on top. Strength comes mainly from the model behind the
// tier (cheap and weak at level 0, Haiku at level 4); this skill is the extra coaching the
// stronger tiers also get. Other games (chess, solver) will carry their own ladders.
const POKER_SKILLS: ExpertSkill[] = [
  {
    name: "Mark",
    brief: "Cheapest model, no extra training.",
    system: "",
  },
  {
    name: "Reader",
    brief: "Preflop discipline and position.",
    system:
      " You have basic training. Play tight and positionally: raise strong hands, fold weak ones, and " +
      "respect that acting last is an advantage. Do not call off chips with weak holdings.",
  },
  {
    name: "Spotter",
    brief: "Pot odds and continuation betting.",
    system:
      " You are a solid regular. Weigh pot odds before calling: compare the price you pay to the pot. " +
      "Continuation-bet when you raised and the board likely missed your opponent, but give up when the " +
      "board favors their range. Value-bet made hands; do not pay off obvious strength.",
  },
  {
    name: "Profiler",
    brief: "Ranges, board texture, balance.",
    system:
      " You are a strong winning player. Think in ranges, not single hands: what can your opponent hold " +
      "here, and how does this board hit both ranges? Balance value bets with bluffs so you are not " +
      "readable, choose bluffs with equity over pure air, and size to the texture. Apply pressure on " +
      "boards that favor you and slow down on boards that favor them.",
  },
  {
    name: "Oracle",
    brief: "Haiku. GTO-aware, exploitative.",
    system:
      " You are a heads-up specialist near game-theory-optimal, and you deviate to exploit. Default to a " +
      "balanced, unexploitable strategy, then adjust to observed leaks: over-folders get bluffed more, " +
      "stations get value-bet thinner and bluffed less. Value-bet thin, betting second pair or better when " +
      "checked to in position on the river. Size deliberately (small for thin value and range bets, large " +
      "or overbet when polarized), protect your range, and give every bet a clear reason: value, a bluff " +
      "with a plan, or denial of equity.",
  },
];

export function pokerSkill(level: number): ExpertSkill {
  const i = Math.max(0, Math.min(POKER_SKILLS.length - 1, Math.floor(level || 0)));
  return POKER_SKILLS[i]!;
}

/** Tier names by level, for display. */
export function pokerTierName(level: number): string {
  return pokerSkill(level).name;
}
