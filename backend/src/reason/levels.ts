import { config } from "../config/index.js";

// A tier is three real dials, all climbing together: the MODEL (a cheap small model at
// level 0 up to Claude Haiku at level 4, in config.reason.tierModels), the reasoning
// passes (self-consistency, here), and the expert skill (knowledge, in skills/poker.ts).
// The model is the main driver of strength: a weaker model given the same good advice
// simply plays it worse. No tier is told to play badly.

// Five levels, 0 to 4. Level 0 is the untrained floor; level 4 is the strongest. Each
// step adds a reasoning pass (here) and a stronger expert skill (the training axis, in
// skills/poker.ts), so the gap between tiers is real, not cosmetic.
export const MAX_LEVEL = 4;

// Cost (in MIST, 9 decimals for SUI) to go from level i to level i+1. An easy on-ramp,
// then a real climb to the Oracle. Mirrors registry::upgrade_cost on chain. The fee
// accumulates in the on-chain Treasury for the coordinator to claim.
export const UPGRADE_COSTS_MIST = [
  100_000_000n, // level 0 -> 1: 0.1 SUI
  300_000_000n, // level 1 -> 2: 0.3 SUI
  800_000_000n, // level 2 -> 3: 0.8 SUI
  1_500_000_000n, // level 3 -> 4: 1.5 SUI
] as const;

// Per-decision plan. `samples` is the number of independent reasoned action
// proposals; the runner takes the majority action and tie-breaks by the
// highest-confidence rationale. Temperature stays moderate at every level so the
// passes stay DIVERSE (cold sampling makes them identical and voting pointless).
// `intel` is the per-decision budget for opponent dossiers, unlocked at the top.
export interface InferencePlan {
  maxTokens: number;
  temperature: number;
  samples: number;
  retries: number;
  hint: string;
  intel: number;
  provider: "anthropic" | "openrouter";
  model: string;
}

// Reasoning params per level; the model and provider are stitched in from config at
// lookup time (so .env can retune the model ladder without touching this).
//
// `intel` is the per-match cap on how many opponent dossiers this tier may buy. Intel is
// the underdog's catch-up tool, so LOWER tiers get a bigger budget and the top tier gets
// none: an Oracle is already the strongest and should not be buying reads. This is the
// spending cap that stops an agent from buying a fresh dossier every street.
type ReasonParams = Omit<InferencePlan, "provider" | "model">;
const LEVELS: ReasonParams[] = [
  { maxTokens: 320, temperature: 0.7, samples: 1, retries: 1, hint: "", intel: 3 },
  { maxTokens: 420, temperature: 0.66, samples: 2, retries: 1, hint: " Think before deciding.", intel: 3 },
  { maxTokens: 540, temperature: 0.64, samples: 3, retries: 1, hint: " Think through the hand, then sanity-check your action.", intel: 2 },
  { maxTokens: 680, temperature: 0.62, samples: 4, retries: 1, hint: " Reason through the hand and weigh the opponent's tendencies before committing.", intel: 1 },
  { maxTokens: 820, temperature: 0.6, samples: 5, retries: 1, hint: " Reason carefully through ranges and the opponent's tendencies, then verify before committing.", intel: 0 },
];

export function levelClamp(level: number): number {
  return Math.max(0, Math.min(MAX_LEVEL, Math.floor(level || 0)));
}

// Per-match dossier cap for a tier. Lower tiers buy more; the top tier buys none.
export function intelBudgetForLevel(level: number): number {
  return LEVELS[levelClamp(level)]!.intel;
}

export function planForLevel(level: number): InferencePlan {
  const i = levelClamp(level);
  const tier = config.reason.tierModels[i] ?? config.reason.tierModels[config.reason.tierModels.length - 1]!;
  return { ...LEVELS[i]!, provider: tier.provider, model: tier.model };
}

// The model backing a tier, for display.
export function modelForLevel(level: number): string {
  const i = levelClamp(level);
  return (config.reason.tierModels[i] ?? config.reason.tierModels[0]!).model;
}

// MIST needed to reach the next level from `current`, or null at the cap.
export function nextLevelCostMist(current: number): bigint | null {
  const l = levelClamp(current);
  if (l >= MAX_LEVEL) return null;
  return UPGRADE_COSTS_MIST[l]!;
}
