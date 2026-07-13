import type {
  Action,
  AppliedMove,
  Card,
  HandResult,
  PlayerState,
  Seat,
  Street,
} from "./types.js";
import { showdown } from "./showdown.js";

// Heads-up No-Limit Hold'em, two players, one pot. The engine is deliberately
// dumb about strategy: it only enforces the rules of betting and deals the board.
// It must be correct before any agent touches it, so it is exercised with scripted
// actions in engine.test.ts.
//
// Heads-up blind rules: the button posts the small blind, acts FIRST pre-flop, and
// acts LAST on every later street. The big blind has the option pre-flop.

const RANKS = "23456789TJQKA";
const SUITS = "shdc";

export function freshDeck(): Card[] {
  const deck: Card[] = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  return deck;
}

// Mulberry32: a tiny seeded PRNG so a hand can be replayed exactly from a seed.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled(seed: number): Card[] {
  const deck = freshDeck();
  const rng = mulberry32(seed);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return deck;
}

export interface HandConfig {
  button: Seat; // the dealer / small blind
  stacks: Record<Seat, number>;
  smallBlind: number;
  bigBlind: number;
  /** Optional preset deck for deterministic tests: [A,B,A,B, flop x3, turn, river, ...]. */
  deck?: Card[];
  /** Seed for the built-in shuffle when no deck is given. */
  seed?: number;
}

export class Hand {
  readonly button: Seat;
  readonly sb: number;
  readonly bb: number;
  players: Record<Seat, PlayerState>;
  board: Card[] = [];
  street: Street = "preflop";
  pot = 0;
  currentBet = 0;
  minRaise: number;
  toAct: Seat | null;
  history: AppliedMove[] = [];
  result: HandResult | null = null;

  private deck: Card[];
  private deckIdx: number;
  private actedThisStreet: Set<Seat> = new Set();
  private lastAggressor: Seat | null = null;

  constructor(cfg: HandConfig) {
    this.button = cfg.button;
    this.sb = cfg.smallBlind;
    this.bb = cfg.bigBlind;
    this.minRaise = cfg.bigBlind;

    const deck = cfg.deck ?? shuffled(cfg.seed ?? 1);
    this.deck = deck;
    // Deal alternating, button first: button c1, other c1, button c2, other c2.
    const other = otherSeat(cfg.button);
    const bHole: [Card, Card] = [deck[0]!, deck[2]!];
    const oHole: [Card, Card] = [deck[1]!, deck[3]!];
    this.deckIdx = 4;

    this.players = {
      [cfg.button]: mkPlayer(cfg.button, bHole, cfg.stacks[cfg.button]),
      [other]: mkPlayer(other, oHole, cfg.stacks[other]),
    } as Record<Seat, PlayerState>;

    // Post blinds: button = small blind, other = big blind.
    this.postBlind(cfg.button, this.sb);
    this.postBlind(other, this.bb);
    this.currentBet = this.bb;
    this.minRaise = this.bb;
    // Pre-flop the button (small blind) acts first.
    this.toAct = cfg.button;
  }

  private postBlind(seat: Seat, amount: number): void {
    const p = this.players[seat];
    const put = Math.min(amount, p.stack);
    p.stack -= put;
    p.committedStreet += put;
    p.committedHand += put;
    if (p.stack === 0) p.allIn = true;
  }

  /** The active (non-folded) opponent's seat. */
  private opp(seat: Seat): Seat {
    return otherSeat(seat);
  }

  /** What the player to act may legally do, with the call amount and raise bounds. */
  legalActions(seat: Seat = this.toAct!): {
    canFold: boolean;
    canCheck: boolean;
    canCall: boolean;
    callAmount: number;
    canRaise: boolean;
    minRaiseTo: number;
    maxRaiseTo: number;
  } {
    const p = this.players[seat];
    const toCall = this.currentBet - p.committedStreet;
    const canCheck = toCall <= 0;
    const canCall = toCall > 0 && p.stack > 0;
    const callAmount = Math.min(toCall, p.stack);
    // A raise must reach at least currentBet + minRaise, but is always allowed as
    // an all-in shove even if the stack cannot cover a full min-raise.
    const maxRaiseTo = p.committedStreet + p.stack;
    const minRaiseTo = Math.min(this.currentBet + this.minRaise, maxRaiseTo);
    const canRaise = p.stack > 0 && maxRaiseTo > this.currentBet;
    return {
      canFold: true,
      canCheck,
      canCall,
      callAmount,
      canRaise,
      minRaiseTo,
      maxRaiseTo,
    };
  }

  /** Apply one action by the player to act. Returns the resolved move. */
  apply(action: Action): AppliedMove {
    if (this.result) throw new Error("hand is already complete");
    const seat = this.toAct;
    if (!seat) throw new Error("no player to act");
    const p = this.players[seat];
    const legal = this.legalActions(seat);

    let amount = 0;
    let type = action.type;

    if (type === "fold") {
      p.folded = true;
      this.recordMove(seat, "fold", 0);
      this.endByFold(this.opp(seat));
      return this.lastMove();
    }

    if (type === "check") {
      if (!legal.canCheck) {
        // A check facing a bet is treated as a call (defensive: agents drift).
        type = "call";
      }
    }

    if (type === "call") {
      amount = legal.callAmount;
      this.commit(seat, amount);
      this.recordMove(seat, "call", amount);
    } else if (type === "raise") {
      // Clamp the requested total to a legal raise-to, or fall back to a call if
      // the player cannot actually raise.
      if (!legal.canRaise) {
        amount = legal.callAmount;
        this.commit(seat, amount);
        this.recordMove(seat, legal.canCall ? "call" : "check", amount);
      } else {
        const requested = action.size ?? legal.minRaiseTo;
        const raiseTo = Math.max(legal.minRaiseTo, Math.min(requested, legal.maxRaiseTo));
        amount = raiseTo - p.committedStreet;
        // A full raise (not a short all-in) reopens the action and sets minRaise.
        const raiseIncrement = raiseTo - this.currentBet;
        this.commit(seat, amount);
        if (raiseIncrement >= this.minRaise) {
          this.minRaise = raiseIncrement;
        }
        this.currentBet = Math.max(this.currentBet, p.committedStreet);
        this.lastAggressor = seat;
        this.recordMove(seat, "raise", amount);
      }
    } else if (type === "check") {
      this.recordMove(seat, "check", 0);
    }

    this.actedThisStreet.add(seat);
    this.advanceAfterAction(seat);
    return this.lastMove();
  }

  private commit(seat: Seat, amount: number): void {
    const p = this.players[seat];
    const put = Math.min(amount, p.stack);
    p.stack -= put;
    p.committedStreet += put;
    p.committedHand += put;
    if (p.stack === 0) p.allIn = true;
  }

  private recordMove(seat: Seat, action: AppliedMove["action"], amount: number): void {
    this.history.push({
      seat,
      street: this.street,
      action,
      amount,
      toLevel: this.players[seat].committedStreet,
    });
  }

  private lastMove(): AppliedMove {
    return this.history[this.history.length - 1]!;
  }

  // Decide whether the betting round is closed, who acts next, or whether to run
  // the board out (both all-in). Mutates toAct / street accordingly.
  private advanceAfterAction(seat: Seat): void {
    const opp = this.opp(seat);
    const me = this.players[seat];
    const them = this.players[opp];

    const levelBets = me.committedStreet === them.committedStreet;
    const bothActed = this.actedThisStreet.has("A") && this.actedThisStreet.has("B");
    const someoneCanAct = (!me.allIn || !them.allIn);

    // If both are all-in (or one all-in and the other has matched), no more
    // betting is possible: run the remaining streets to showdown.
    if (me.allIn && them.allIn) {
      this.returnUncalled();
      this.runOutAndShowdown();
      return;
    }

    if (levelBets && bothActed) {
      this.closeStreet();
      return;
    }

    // The opponent still needs to respond (to a raise, or as the first actor, or
    // the pre-flop big-blind option). If the opponent is all-in they cannot act,
    // so the bet must be uncalled — return the excess and close.
    if (them.allIn) {
      this.returnUncalled();
      if (this.players[seat].allIn) this.runOutAndShowdown();
      else this.closeStreet();
      return;
    }

    if (someoneCanAct) {
      this.toAct = opp;
    } else {
      this.closeStreet();
    }
  }

  // When betting ends with unequal commitments (a player went all-in for less than
  // the other wagered), the uncalled excess returns to the over-committer.
  private returnUncalled(): void {
    const a = this.players.A;
    const b = this.players.B;
    const diff = a.committedStreet - b.committedStreet;
    if (diff === 0) return;
    const over = diff > 0 ? a : b;
    const amount = Math.abs(diff);
    over.committedStreet -= amount;
    over.committedHand -= amount;
    over.stack += amount;
    if (over.stack > 0) over.allIn = false;
  }

  // Fold the street's commitments into the pot and move to the next street, or to
  // showdown after the river.
  private closeStreet(): void {
    this.collectToPot();
    if (this.street === "river") {
      this.toShowdown();
      return;
    }
    this.dealNextStreet();
    // Reset the betting round. Post-flop the non-button (big blind) acts first.
    this.currentBet = 0;
    this.minRaise = this.bb;
    this.actedThisStreet.clear();
    this.lastAggressor = null;
    this.toAct = otherSeat(this.button);
    // If a player is already all-in from a prior street, there is no betting:
    // keep running out.
    if (this.players.A.allIn || this.players.B.allIn) {
      this.runOutAndShowdown();
    }
  }

  private collectToPot(): void {
    for (const seat of ["A", "B"] as Seat[]) {
      this.pot += this.players[seat].committedStreet;
      this.players[seat].committedStreet = 0;
    }
  }

  private dealNextStreet(): void {
    if (this.street === "preflop") {
      this.board.push(this.draw(), this.draw(), this.draw());
      this.street = "flop";
    } else if (this.street === "flop") {
      this.board.push(this.draw());
      this.street = "turn";
    } else if (this.street === "turn") {
      this.board.push(this.draw());
      this.street = "river";
    }
  }

  private draw(): Card {
    const c = this.deck[this.deckIdx];
    if (!c) throw new Error("deck exhausted");
    this.deckIdx += 1;
    return c;
  }

  // Deal whatever board cards remain, then evaluate. Used when both players are
  // all-in and no betting remains.
  private runOutAndShowdown(): void {
    if (this.result) return;
    this.collectToPot();
    while (this.board.length < 5) {
      this.board.push(this.draw());
    }
    this.toShowdown();
  }

  private toShowdown(): void {
    this.street = "showdown";
    const res = showdown(this.board, this.players.A.hole, this.players.B.hole);
    this.award(res.winner, "showdown", res.descr);
  }

  private endByFold(winner: Seat): void {
    this.collectToPot();
    this.award(winner, "fold");
  }

  private award(winner: Seat | "split", reason: HandResult["reason"], descr?: Record<Seat, string>): void {
    this.street = "complete";
    this.toAct = null;
    if (winner === "split") {
      const half = Math.floor(this.pot / 2);
      this.players.A.stack += half;
      this.players.B.stack += this.pot - half; // odd chip to seat B
    } else {
      this.players[winner].stack += this.pot;
    }
    this.result = { winner, reason, pot: this.pot, descr };
  }

  /**
   * A snapshot of the public state for prompting and the feed (no hole cards).
   *
   * `pot` is the LIVE pot: chips banked from earlier streets plus everything wagered on this
   * one. The internal `this.pot` only banks a street's bets when the street ends, so reading it
   * mid-street reports a pot with the current action missing from it -- preflop, before a single
   * bet is collected, it reports ZERO while the blinds sit in front of the players. Every caller
   * wants the money on the table, so that is what this returns. (The bug this fixes: the solver
   * priced the small blind's opening decision against a pot of nothing, so calling 10 to win 0
   * was correctly a fold, and the agents folded 95% of their hands before the flop.)
   */
  publicView(): {
    street: Street;
    board: Card[];
    pot: number;
    currentBet: number;
    toAct: Seat | null;
    stacks: Record<Seat, number>;
    committedStreet: Record<Seat, number>;
  } {
    return {
      street: this.street,
      board: [...this.board],
      pot: this.pot + this.players.A.committedStreet + this.players.B.committedStreet,
      currentBet: this.currentBet,
      toAct: this.toAct,
      stacks: { A: this.players.A.stack, B: this.players.B.stack },
      committedStreet: {
        A: this.players.A.committedStreet,
        B: this.players.B.committedStreet,
      },
    };
  }

  isComplete(): boolean {
    return this.result !== null;
  }
}

function mkPlayer(seat: Seat, hole: [Card, Card], stack: number): PlayerState {
  return {
    seat,
    hole,
    stack,
    committedStreet: 0,
    committedHand: 0,
    folded: false,
    allIn: false,
  };
}

export function otherSeat(seat: Seat): Seat {
  return seat === "A" ? "B" : "A";
}
