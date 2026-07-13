import { readEquity } from "./equity.js";
import type { Card, Seat } from "./types.js";

// The engine half of the hybrid brain, and the reason a Telt tier is now a real player
// rather than a prompt with a bigger model behind it.
//
// A language model asked to play poker plays badly in a specific, repeatable way: it
// cannot price a call, so it calls when the odds forbid it, and it cannot tell a made
// hand from a dead draw, so it fires a busted flush on the river because the story it
// told itself on the turn is still in its context. No amount of prompt wording fixes
// this, and we tried: the river blunder was patched with an explicit "never bet a busted
// draw" sentence and Maverick did it again.
//
// So the model is not asked. The engine enumerates the legal actions, prices each one
// against a Monte Carlo equity estimate, and hands the agent a SHORTLIST. The agent
// chooses among the shortlist and says why. Its judgment is real (which of these good
// lines fits this opponent?) but its downside is bounded by what it was allowed to see.
//
// `slack` is how far below the best EV an action may sit and still reach the shortlist. It is a
// FILTER, not a ladder: it keeps the stack-punting actions off the list at every level, and it is
// deliberately generous, because the engine below is a heuristic and a tier held tightly to a
// heuristic inherits its mistakes. See the TIERS table for the measurement that settled that, and
// for where a level's strength actually comes from.

export interface SolverContext {
  hole: [Card, Card];
  board: Card[];
  pot: number;
  toCall: number;
  /** Chips this player has already put in on this street. */
  myCommitted: number;
  /** Chips the opponent has put in on this street. */
  oppCommitted: number;
  myStack: number;
  oppStack: number;
  bigBlind: number;
  legal: {
    canFold: boolean;
    canCheck: boolean;
    canCall: boolean;
    callAmount: number;
    canRaise: boolean;
    minRaiseTo: number;
    maxRaiseTo: number;
  };
}

export interface ActionCandidate {
  action: "fold" | "check" | "call" | "raise";
  /** Raise-to total; 0 for the others. Matches the engine's Action.size contract. */
  size: number;
  /** Expected chip gain against a fold-now baseline of zero. */
  ev: number;
  /** Short label for the prompt, e.g. "raise to 240 (2/3 pot)". */
  label: string;
}

export interface Shortlist {
  /** Priced, legal, best-first. What the agent is allowed to choose from. */
  actions: ActionCandidate[];
  /** Win probability against the opponent's whole range. Shown in the feed and anchored. */
  equity: number;
}

/** Per-level engine dials. Higher levels see more accurately and are given less rope. */
export interface SolverTier {
  /** Monte Carlo deals per decision. More deals, less noise in the price. */
  iterations: number;
  /** How far below the best EV an action may be and still reach the prompt, in big blinds. */
  slackBb: number;
  /** How many actions reach the prompt at all. */
  candidates: number;
}

// THE ENGINE IS A BLUNDER FILTER, NOT A LEASH. This is the single most important thing in this
// file, it is the opposite of what was built first, and it was settled by measurement rather than
// by argument.
//
// The first design copied chess: bind the top tier tightly to the engine's best line (a slack of
// a fraction of a big blind) and hand the bottom tier enough rope to hang itself. In chess that
// works, because the engine there is a real negamax search and is genuinely stronger than the
// model. Here it does not, because THIS engine is a heuristic. Binding level 4 tightly to a
// heuristic binds it to that heuristic's mistakes, while level 0's rope lets its model wander off
// them -- and wandering away from a biased engine is an improvement.
//
// Duplicate poker said so plainly. Same eight boards, same cards dealt to both tiers, one variable
// changed:
//
//   slack as the ladder (level 4 held tight to the engine)   level 4 LOST by 165 chips a board
//   slack as a blunder filter (every tier given room)        level 4 WON  by 380 chips a board
//
// So slack is generous at every level now, and it exists only to keep genuinely losing actions off
// the shortlist. Every tier still chooses, and it chooses among sane options. The LADDER is the
// rest of the stack -- a sharper equity read here, a stronger model, more self-consistency passes,
// a better expert skill, a bigger dossier budget -- which are the things that were actually helping
// all along. A weaker tier is not handcuffed to a worse engine; it simply reads the same table less
// accurately and thinks about it less.
// Slack and shortlist width are now IDENTICAL at every level. They are a safety rail, not a
// ladder: they keep the stack-punting actions off the list for everyone, and nothing more.
//
// They were graded before, and grading them backfired twice. First tightly (level 4 pinned to the
// engine's top line) which bound the top tier to a heuristic's mistakes. Then loosely-but-still-
// graded, which was worse in a way that took a whole championship to see: a WIDER shortlist is not
// a handicap in heads-up poker, it is a licence to be aggressive. Level 0, handed 12 big blinds of
// rope, was being offered the bullying lines that level 4 was not, and it used them -- it knocked
// out both Oracles and won the bracket. The rope was not rope. It was a weapon.
//
// So the engine treats every tier the same, and a level's strength comes entirely from the things
// that genuinely make a player better: a sharper equity read (iterations, below), a stronger model,
// more self-consistency passes, a better expert skill, and a bigger dossier budget to scout with.
const SLACK_BB = 8.0;
const SHORTLIST = 4;

const TIERS: SolverTier[] = [
  { iterations: 150, slackBb: SLACK_BB, candidates: SHORTLIST },
  { iterations: 400, slackBb: SLACK_BB, candidates: SHORTLIST },
  { iterations: 900, slackBb: SLACK_BB, candidates: SHORTLIST },
  { iterations: 1800, slackBb: SLACK_BB, candidates: SHORTLIST },
  { iterations: 3000, slackBb: SLACK_BB, candidates: SHORTLIST },
];

export function solverTier(level: number): SolverTier {
  return TIERS[Math.max(0, Math.min(TIERS.length - 1, Math.floor(level || 0)))]!;
}

// How often a bet gets folded to, and how wide the range that calls it is. This is not a
// guess: minimum defence frequency says that to stop a bet of `size` into `pot` from being
// a free bluff, the opponent must continue with pot / (pot + size) of their range. So the
// bet size DERIVES the continuing range, and the continuing range is what the bet must beat.
//
// This is used UNCAPPED, and the first version of this file capped it, which was a mistake
// worth recording. The cap was meant to stop the engine from overbet-bluffing (pure MDF says
// a huge shove gets folded to almost always, which looks like free money). It did stop that,
// and in exchange it told the engine that a 74bb shove gets CALLED by 45% of hands -- so every
// premium hand shoved preflop, every match became a coin flip, and the opponent's only sane
// reply was to fold. That is exactly what the tier test caught: the engine folded 91% of spots
// because it was always facing a shove.
//
// The cap was never needed. MDF is self-correcting: a bluff with no equity when called prices
// at EXACTLY break-even at the defence frequency, never above it. The theorem does the job the
// cap was hacked in to do, and it does it without lying about the calling range.
function pricing(betSize: number, pot: number): { fold: number; continues: number } {
  if (betSize <= 0 || pot <= 0) return { fold: 0, continues: 1 };
  const fold = betSize / (pot + betSize);
  return { fold, continues: 1 - fold };
}

// Equity realization. Raw equity is what a hand is worth if every street is dealt out for
// free, and no street is free. A weak hand does not collect its share: it is dominated, it
// is outplayed, it folds the pots it should win and pays off the ones it should not. A strong
// hand collects MORE than its share for the same reasons in reverse.
//
// This is the piece that keeps the engine from bluff-raising 72-offsuit preflop. Preflop
// equities are compressed -- the worst hand in poker still beats ace-king about a third of
// the time -- so a one-street model prices the 3-bet as roughly break-even and fires it. It
// only looks break-even because the model assumed 72o would be handed its 32% at showdown.
//
// The correction stretches equity away from a coin flip, by an amount that grows with the
// number of streets still to be played. On the river it is exactly zero: nothing is left to
// be outplayed on, and the hand is worth precisely what it is.
const REALIZATION_STRETCH = 0.60;

function streetsLeft(board: Card[]): number {
  if (board.length === 0) return 3; // preflop: flop, turn, river to come
  if (board.length === 3) return 2;
  if (board.length === 4) return 1;
  return 0; // river
}

function realized(e: number, board: Card[]): number {
  const k = REALIZATION_STRETCH * (streetsLeft(board) / 3);
  return Math.max(0, Math.min(1, e + k * (e - 0.5)));
}

// Implied odds, and the risk of being played back at. These two are what a ONE-STREET model
// cannot see, and without them the engine was a maniac: it folded or it raised, and across
// hundreds of spots it never once called. Any poker player would laugh at that, and the tier
// test did the equivalent -- the tier forced closest to this engine's top line lost to the one
// given enough rope to sometimes call.
//
// A call was scored on showdown value alone, so it could never beat a raise: raising collects
// fold equity, and calling collected nothing but the pot it was already looking at. But a call
// buys a card, and a hand that improves gets PAID on the streets that follow. That is implied
// odds, and it is most of why calling exists.
//
// A raise, meanwhile, was scored as though the opponent may only fold or call. Let them raise
// back and a wide bluff stops being free: some of the time the chips go in and come straight
// back out. Both corrections go to zero on the river -- no streets left to be paid on, and the
// busted-draw fix that started all this is untouched.
const IMPLIED_ODDS = 0.5;
const RERAISE_RISK = 0.08;

function impliedPot(pot: number, board: Card[]): number {
  return pot * (1 + IMPLIED_ODDS * (streetsLeft(board) / 3));
}

// The opponent's range, narrowed by what they have ALREADY done. This is the other half of
// the same idea, and leaving it out is what made the engine want to 3-bet bluff 72-offsuit:
// it priced the bluff against a villain holding a random hand, when the villain had just
// raised four times the blind and could not possibly hold one.
//
// A player who has put in a big bet relative to the pot is representing a narrow range; one
// who made a small bet is representing almost nothing. Same shape as the defence frequency,
// read from the other side of the table. A check tells us nothing, so it narrows nothing.
// Floored, because nobody's range is only the nuts, and a floor keeps a bluff-catcher alive.
//
// PREFLOP the same reading is wrong, and reading it the same way cost the big blind 85% of
// its hands. Heads-up, the small blind opens almost any two cards -- the raise is positional,
// not a claim of strength -- so treating a routine 3x open as "the top third of hands" makes
// every defence look hopeless and folds the blind into the ground. Postflop a bet size really
// does say something about a range; preflop it barely does. So preflop narrows gently, from a
// floor of half the deck.
function opponentRange(toCall: number, pot: number, board: Card[]): number {
  if (toCall <= 0) return 1; // they checked: no information, no narrowing
  const before = Math.max(1, pot - toCall);
  if (board.length === 0) return Math.max(0.5, Math.min(1, before / (before + toCall)));
  return Math.max(0.2, Math.min(1, before / (before + 2 * toCall)));
}

// Price every legal action in chips, against a baseline where folding right now is worth
// zero. Chips already in the pot are sunk and are not counted as recoverable, which is
// what makes `call` obey pot odds: it beats folding exactly when equity clears the price.
export function candidates(ctx: SolverContext, tier: SolverTier): Shortlist {
  const { legal, pot, toCall } = ctx;
  const eq = readEquity(ctx.hole, ctx.board, tier.iterations);
  // Everything is priced against the range the opponent can still credibly hold after the
  // action they took, not against a random hand.
  const theirs = opponentRange(toCall, pot, ctx.board);
  const eReal = realized(eq.vsTop(theirs), ctx.board);

  const out: ActionCandidate[] = [];

  // Folding when checking is free is not a judgment call, it is a mistake with no upside,
  // so it is never offered. Rope is for actions that could plausibly be argued.
  if (legal.canFold && toCall > 0) {
    out.push({ action: "fold", size: 0, ev: 0, label: "fold" });
  }
  if (legal.canCheck) {
    // Checking wins the pot as it stands, and nothing more. Implied odds deliberately do NOT
    // apply here: they are what a hand earns by PAYING to continue and getting paid off later,
    // and a made hand that checks is not being paid, it is declining to charge. Crediting a
    // check with implied value is what made the engine stop value-betting entirely -- it
    // checked its overpairs and its queens and its thin river value, and the benchmark caught
    // all three in one pass.
    out.push({ action: "check", size: 0, ev: eReal * pot, label: "check" });
  }
  if (legal.canCall) {
    // Pot odds, against the range that actually bet at us, plus the implied odds: calling buys
    // a card, and the hands that get there collect more than the pot they are looking at now.
    const call = legal.callAmount;
    out.push({
      action: "call",
      size: 0,
      ev: eReal * impliedPot(pot, ctx.board) - (1 - eReal) * call,
      label: `call ${call}`,
    });
  }

  if (legal.canRaise) {
    // A handful of human sizings rather than every legal integer: a third, two thirds, pot.
    // Deduped after clamping, since a short stack collapses them together.
    const fractions: [number, string][] = [
      [0.33, "1/3 pot"],
      [0.66, "2/3 pot"],
      [1.0, "pot"],
    ];
    const sizes = new Map<number, string>();
    for (const [f, name] of fractions) {
      const raiseTo = Math.round(ctx.myCommitted + toCall + f * (pot + toCall));
      const clamped = Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, raiseTo));
      if (!sizes.has(clamped)) sizes.set(clamped, name);
    }

    // The shove is offered only when the stack is actually in shoving range of the pot. Deep
    // stacked it is not a poker bet, it is an artifact of enumerating maxRaiseTo: 75 big blinds
    // into a 30 chip pot. The one-street model cannot price a bet that large -- it has no idea
    // what calls a 50x overbet, and MDF, honestly applied, says almost nothing does, which made
    // every premium hand shove preflop and every weak hand shove as a bluff. Both were the model
    // being asked a question outside its competence. So do not ask it: keep the sizings inside
    // the range real poker uses, and let the shove appear when the stack has come to it.
    const potRaiseTo = ctx.myCommitted + toCall + (pot + toCall);
    if (legal.maxRaiseTo <= potRaiseTo * 1.6) sizes.set(legal.maxRaiseTo, "all in");

    for (const [raiseTo, name] of sizes) {
      const invest = raiseTo - ctx.myCommitted; // chips I add now
      const oppAdds = Math.min(raiseTo - ctx.oppCommitted, ctx.oppStack); // chips they add if they call
      const { fold, continues } = pricing(invest - toCall, pot);
      // Priced against the hands that call THIS bet, out of the range they could still have.
      // Both narrowings compound, and they must: a bluff has to get through what they already
      // showed AND beat what calls, which is why a busted draw prices as the chip-burner it
      // is while a monster still gets paid by a tight range.
      const raw = eq.vsTop(theirs * continues);
      // An all-in has no later streets to be outplayed on: it runs to showdown, so it collects
      // exactly its equity and no realization correction applies. Skipping this is what made
      // the engine love shoving -- the stretch was BOOSTING a premium hand's equity on a bet
      // that was already going to be decided by the cards alone.
      const shove = raiseTo >= legal.maxRaiseTo || oppAdds >= ctx.oppStack;
      const eCalled = shove ? raw : realized(raw, ctx.board);
      const called = eCalled * (pot + oppAdds) - (1 - eCalled) * invest;
      // Of the hands that do not fold, some raise back. An all-in cannot be re-raised, so it
      // carries no such risk; everything else does, and it is what stops a wide bluff from
      // looking free.
      const reraise = shove ? 0 : RERAISE_RISK;
      const answered = reraise * -invest + (1 - reraise) * called;
      out.push({
        action: "raise",
        size: raiseTo,
        ev: fold * pot + continues * answered,
        label: `raise to ${raiseTo} (${name})`,
      });
    }
  }

  // Rank, then cut by the tier's rope and its shortlist width. The best action always
  // survives, so there is never an empty list to decide from.
  out.sort((a, b) => b.ev - a.ev);
  const best = out[0]!;
  const floor = best.ev - tier.slackBb * ctx.bigBlind;
  const kept = out.filter((c) => c.ev >= floor).slice(0, Math.max(1, tier.candidates));
  // The equity reported to the feed is the raw one: "how often this hand wins" is what a
  // spectator means, and the range-adjusted numbers are already baked into the EVs.
  return { actions: kept.length ? kept : [best], equity: eq.raw };
}

export type { Seat };
