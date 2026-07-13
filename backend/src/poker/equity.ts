import pokersolver from "pokersolver";
import { freshDeck } from "./engine.js";
import type { Card } from "./types.js";

const { Hand: Solved } = pokersolver;
type SolvedHand = ReturnType<typeof Solved.solve>;

// Monte Carlo equity, and the thing that actually matters: equity against the hands that
// CONTINUE.
//
// This exists because a language model cannot do this arithmetic. Ask one whether a flush
// draw is worth a call and it produces a confident sentence with a number in it, and the
// number is wrong. So the model is never asked. The engine deals the unknown cards out
// thousands of times, ranks both hands with the same solver that settles a real showdown,
// and hands the model a fact.
//
// Raw equity (against a uniformly random opponent) is the right price for a CALL, because
// a caller faces the opponent's whole range. It is the wrong price for a BET, and getting
// that wrong is what made the agents blunder. A busted flush on the river beats about 9%
// of random hands, so a naive model prices a bluff off that 9% and fires. But nobody calls
// a river bet with the hands the busted flush beats. Against the hands that actually call,
// it beats nothing, and the bluff is burning chips.
//
// So a bet is priced against the CONTINUING range: sample the opponent's holding, rank it
// as they would see it at the moment they decide, and ask how we do against only the top
// slice that would keep going. `vsTop` is that question, and it is what makes a value bet
// and a bluff price differently with the same cards on the table.

export interface EquityRead {
  /** Win rate against the opponent's entire range. The price of a call. */
  raw: number;
  /**
   * Win rate against only the strongest `frac` of the opponent's holdings: the ones that
   * would call. The price of a bet. `frac` of 1 is `raw`.
   */
  vsTop(frac: number): number;
}

// Preflop there is no board, so the opponent's holding cannot be ranked by the solver
// (it needs five cards). Rank it the way a player does: pairs first, then high cards,
// with a nudge for suited and connected. Only the ORDER matters here, not the scale.
function preflopScore(hole: [Card, Card]): number {
  const order = "23456789TJQKA";
  const a = order.indexOf(hole[0]![0]!);
  const b = order.indexOf(hole[1]![0]!);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  const paired = a === b;
  const suited = hole[0]![1] === hole[1]![1];
  const gap = hi - lo;
  return (
    (paired ? 1000 + hi * 10 : hi * 10 + lo) +
    (suited ? 12 : 0) +
    (!paired && gap <= 4 ? 8 - gap : 0)
  );
}

/**
 * Sample the unknown cards `iterations` times. Returns the raw win rate and a `vsTop`
 * function that re-prices the same sample against any continuing range, so every candidate
 * bet size can be evaluated without re-running the simulation.
 */
export function readEquity(hole: [Card, Card], board: Card[], iterations: number): EquityRead {
  const known = new Set<string>([...hole, ...board]);
  const deck = freshDeck().filter((c) => !known.has(c));
  const need = 2 + (5 - board.length);
  const preflop = board.length === 0;

  // One entry per sampled deal: how the opponent's holding ranks AT THE DECISION (which is
  // what they call on), and whether we won once the board ran out (which is what pays).
  const deals: { oppNow: SolvedHand | null; oppPre: number; won: number }[] = [];

  const pool = deck.slice();
  for (let i = 0; i < iterations; i++) {
    for (let d = 0; d < need; d++) {
      const j = d + Math.floor(Math.random() * (pool.length - d));
      const tmp = pool[d]!;
      pool[d] = pool[j]!;
      pool[j] = tmp;
    }
    const oppHole: [Card, Card] = [pool[0]!, pool[1]!];
    const runout = [...board, ...pool.slice(2, need)];

    const mine = Solved.solve([...hole, ...runout]);
    const theirs = Solved.solve([...oppHole, ...runout]);
    const winners = Solved.winners([mine, theirs]);
    const iWon = winners.includes(mine);
    const theyWon = winners.includes(theirs);
    const won = iWon && theyWon ? 0.5 : iWon ? 1 : 0;

    deals.push({
      oppNow: preflop ? null : Solved.solve([...oppHole, ...board]),
      oppPre: preflop ? preflopScore(oppHole) : 0,
      won,
    });
  }

  // Strongest opponent holdings first, so the top slice IS the continuing range.
  if (preflop) {
    deals.sort((x, y) => y.oppPre - x.oppPre);
  } else {
    deals.sort((x, y) => {
      const w = Solved.winners([x.oppNow!, y.oppNow!]);
      const xw = w.includes(x.oppNow!);
      const yw = w.includes(y.oppNow!);
      if (xw && yw) return 0;
      return xw ? -1 : 1;
    });
  }

  // Prefix sums, so re-pricing against a different continuing range is O(1) per bet size.
  const prefix: number[] = new Array(deals.length + 1).fill(0);
  for (let i = 0; i < deals.length; i++) prefix[i + 1] = prefix[i]! + deals[i]!.won;
  const total = prefix[deals.length]!;

  return {
    raw: deals.length ? total / deals.length : 0,
    vsTop(frac: number): number {
      if (!deals.length) return 0;
      const k = Math.max(1, Math.min(deals.length, Math.ceil(frac * deals.length)));
      return prefix[k]! / k;
    },
  };
}
