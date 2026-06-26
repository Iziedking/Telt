// Shared poker types. Cards are pokersolver strings: rank in 23456789TJQKA,
// suit in shdc, e.g. "As", "Td", "2c".

export type Seat = "A" | "B";
export type Card = string;

export type Street = "preflop" | "flop" | "turn" | "river" | "showdown" | "complete";

export type ActionType = "fold" | "check" | "call" | "raise";

// One agent decision. For a raise, `size` is the TOTAL this player wants their
// wager for the current street to become (the new bet level), not the increment.
// It is clamped to a legal value when applied (min-raise floor, stack ceiling),
// so an out-of-range size never breaks the engine.
export interface Action {
  type: ActionType;
  size?: number;
}

export interface PlayerState {
  seat: Seat;
  hole: [Card, Card];
  /** Chips behind, not yet wagered. */
  stack: number;
  /** Chips wagered on the current street. */
  committedStreet: number;
  /** Total chips wagered this hand (for pot accounting and the record). */
  committedHand: number;
  folded: boolean;
  allIn: boolean;
}

export interface AppliedMove {
  seat: Seat;
  street: Street;
  action: ActionType;
  /** Chips this action put into the pot (0 for a check or fold). */
  amount: number;
  /** The street bet level after the action. */
  toLevel: number;
}

export interface HandResult {
  winner: Seat | "split";
  /** How the hand ended. */
  reason: "fold" | "showdown";
  /** Chips awarded to the winner (the whole pot; split divides it). */
  pot: number;
  /** Showdown descriptions when reason is "showdown". */
  descr?: Record<Seat, string>;
}
