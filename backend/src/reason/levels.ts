// The single skill dial: reasoning compute, bought on chain. Every agent starts
// at level 0 and is identical at claim. Each level adds a self-consistency pass
// and a bigger token budget, so the agent reasons harder per decision and plays
// measurably better. Ported from Zerun's computeLevels.ts; the lever is the same
// (self-consistency), only the units changed from 0G to a Sui asset.

// The demo caps at 3 levels. Gains flatten past that, and we do not claim
// unbounded scaling. Level 0 is the floor where the house sits.
export const MAX_LEVEL = 3;

// Cost (in MIST, 9 decimals for SUI) to go from level i to level i+1. Mirrors the
// shape of COMPUTE_COSTS_OG: an easy on-ramp, then a real climb. Kept modest so a
// demo wallet on testnet can actually afford to level up.
export const UPGRADE_COSTS_MIST = [
  100_000_000n, // level 0 -> 1: 0.1 SUI
  300_000_000n, // level 1 -> 2: 0.3 SUI
  800_000_000n, // level 2 -> 3: 0.8 SUI
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
}

const LEVELS: InferencePlan[] = [
  { maxTokens: 320, temperature: 0.7, samples: 1, retries: 1, hint: "", intel: 0 },
  { maxTokens: 480, temperature: 0.65, samples: 3, retries: 1, hint: " Think through the hand before deciding.", intel: 0 },
  { maxTokens: 640, temperature: 0.62, samples: 4, retries: 1, hint: " Think through the hand, then sanity-check your action.", intel: 1 },
  { maxTokens: 800, temperature: 0.6, samples: 5, retries: 1, hint: " Reason through the hand, weigh the opponent's tendencies, then commit.", intel: 2 },
];

export function levelClamp(level: number): number {
  return Math.max(0, Math.min(MAX_LEVEL, Math.floor(level || 0)));
}

export function planForLevel(level: number): InferencePlan {
  return LEVELS[levelClamp(level)]!;
}

// MIST needed to reach the next level from `current`, or null at the cap.
export function nextLevelCostMist(current: number): bigint | null {
  const l = levelClamp(current);
  if (l >= MAX_LEVEL) return null;
  return UPGRADE_COSTS_MIST[l]!;
}
