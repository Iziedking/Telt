import pokersolver from "pokersolver";
import type { Card, Seat } from "./types.js";

const { Hand } = pokersolver;

// Rank the two 7-card hands at showdown with pokersolver and decide the winner.
// Heads-up means exactly two hands, so there is one winner or a split; no side
// pots. This is the only place hand strength is judged, and it is judged by a
// library, not by the agent, so the result is objective.

export interface ShowdownResult {
  winner: Seat | "split";
  /** Human label for each seat's best five-card hand, for the feed. */
  descr: Record<Seat, string>;
}

export function showdown(
  board: Card[],
  holeA: [Card, Card],
  holeB: [Card, Card],
): ShowdownResult {
  if (board.length !== 5) {
    throw new Error(`showdown needs a full 5-card board, got ${board.length}`);
  }
  const handA = Hand.solve([...holeA, ...board]);
  const handB = Hand.solve([...holeB, ...board]);
  const winners = Hand.winners([handA, handB]);

  const descr: Record<Seat, string> = { A: handA.descr, B: handB.descr };

  const wonA = winners.includes(handA);
  const wonB = winners.includes(handB);
  if (wonA && wonB) return { winner: "split", descr };
  return { winner: wonA ? "A" : "B", descr };
}
