import type { AppliedMove, Card, Seat, Street } from "./types.js";

// What one agent knows about the other, kept as it plays.
//
// This exists because the agents were being asked to out-play each other while being told almost
// nothing about each other. The prompt carried the last six actions and nothing else -- no idea
// how often this opponent folds, whether they bet or call, what they have actually shown down.
// A model cannot form a read out of that, so it did not form one, and every agent played the same
// solid, opponent-blind poker. The tiers drew because there was nothing to be better AT.
//
// These are the numbers a human tracks at a table without thinking about it, and they are the ones
// that decide what beats a given player:
//
//   fold to bet   the single most exploitable stat there is. Someone who folds most of the time
//                 should be bet into relentlessly; someone who never folds should never be bluffed
//                 and always value-bet thin.
//   aggression    do they bet and raise, or call and check? A passive player's raise means
//                 something. An aggressive player's does not.
//   showdowns     what they were actually holding when the money went in, which is the only
//                 ground truth about their range that exists.
//
// Kept per match, in memory, and fed to the decision. A bought dossier layers the opponent's
// history from PREVIOUS matches on top of this; together they are a real read.

export interface OpponentRead {
  hands: number;
  /** Times they faced a bet, and times they folded to one. */
  facedBet: number;
  foldedToBet: number;
  /** Bets and raises, against calls and checks. */
  aggressive: number;
  passive: number;
  /** What they turned over, most recent first. */
  showdowns: { hole: [Card, Card]; board: Card[]; descr: string; won: boolean }[];
}

export function emptyRead(): OpponentRead {
  return { hands: 0, facedBet: 0, foldedToBet: 0, aggressive: 0, passive: 0, showdowns: [] };
}

/** Fold one applied move into the read. `facingBet` is whether there was a live bet to answer. */
export function noteMove(read: OpponentRead, move: AppliedMove, facingBet: boolean): void {
  if (facingBet) {
    read.facedBet += 1;
    if (move.action === "fold") read.foldedToBet += 1;
  }
  if (move.action === "raise") read.aggressive += 1;
  else if (move.action === "call" || move.action === "check") read.passive += 1;
}

export function noteShowdown(
  read: OpponentRead,
  hole: [Card, Card],
  board: Card[],
  descr: string,
  won: boolean,
): void {
  read.showdowns.unshift({ hole, board, descr, won });
  if (read.showdowns.length > 4) read.showdowns.pop();
}

// Render the read as the lines a player would actually say to themselves. Percentages only once
// there is enough to mean anything: a fold rate off two decisions is not a read, it is a rumour,
// and telling a model "they fold 100% of the time" after one fold is how you teach it to bluff off
// its stack.
export function describeRead(read: OpponentRead, name: string): string[] {
  const out: string[] = [];

  if (read.facedBet >= 4) {
    const pct = Math.round((read.foldedToBet / read.facedBet) * 100);
    const verdict =
      pct >= 60
        ? "folds far too often — bet into them relentlessly, bluffs get through"
        : pct <= 25
          ? "almost never folds — do not bluff, value-bet thinner than usual"
          : "defends about the right amount";
    out.push(`${name} folds to ${pct}% of bets (${read.foldedToBet} of ${read.facedBet}): ${verdict}.`);
  }

  const acts = read.aggressive + read.passive;
  if (acts >= 6) {
    const pct = Math.round((read.aggressive / acts) * 100);
    const verdict =
      pct >= 55
        ? "very aggressive — their bets mean less, call down lighter"
        : pct <= 20
          ? "passive — when they finally raise, believe it"
          : "balanced between betting and calling";
    out.push(`${name} bets or raises ${pct}% of the time: ${verdict}.`);
  }

  for (const s of read.showdowns.slice(0, 3)) {
    out.push(
      `${name} showed ${s.hole.join(" ")} (${s.descr}) on ${s.board.join(" ")} and ${s.won ? "won" : "lost"}.`,
    );
  }

  return out;
}

export type { Seat, Street };
