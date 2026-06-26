// Minimal typings for pokersolver@2.1.4, which ships no types. It is a CommonJS
// module whose default export carries the classes. We use a thin slice: Hand.solve
// to rank a 7-card hand and Hand.winners to pick the best of two. Cards are strings
// like "As", "Td", "2c".
declare module "pokersolver" {
  export interface SolvedHand {
    name: string;
    descr: string;
    rank: number;
    cards: unknown[];
  }
  export interface HandStatic {
    solve(cards: string[], game?: string, canDisqualify?: boolean): SolvedHand;
    winners(hands: SolvedHand[]): SolvedHand[];
  }
  const pokersolver: { Hand: HandStatic };
  export default pokersolver;
}
