// A heads-up freezeout needs escalating blinds, or two cautious agents fold at each
// other forever and no one busts. Blinds double every `escalateEvery` hands, so stacks
// shrink in big-blind terms until confrontation is forced and someone busts. Skill
// decides the deeper early hands; the structure guarantees a decisive end.

export function blindsForHand(
  handIndex: number,
  baseSmallBlind: number,
  baseBigBlind: number,
  escalateEvery: number,
): { sb: number; bb: number } {
  const tier = Math.floor(handIndex / Math.max(1, escalateEvery));
  const mult = 2 ** tier;
  return { sb: baseSmallBlind * mult, bb: baseBigBlind * mult };
}
