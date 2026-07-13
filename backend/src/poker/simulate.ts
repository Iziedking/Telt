import { Hand, otherSeat } from "./engine.js";
import { emptyRead, noteMove, noteShowdown, describeRead, type OpponentRead } from "./reads.js";
import { blindsForHand } from "./blinds.js";
import type { Seat } from "./types.js";
import { planForLevel } from "../reason/levels.js";
import { decide } from "../runners/pokerRunner.js";

// A pure off-chain heads-up match between two tiers: engine plus the Haiku runner, no
// chain, no anchoring, no memory. Used by the tier-strength harness to check that a
// higher tier actually beats a lower one. It plays a freezeout to bust (one natural
// winner), with a safety cap.

export interface SimOptions {
  startingChips?: number;
  smallBlind?: number;
  bigBlind?: number;
  maxHands?: number;
  seedBase?: number;
  /** Blinds double every this many hands, to force a bust. */
  escalateEvery?: number;
}

export interface SimResult {
  winner: Seat;
  chips: Record<Seat, number>;
  hands: number;
  busted: boolean;
}

// Mirror the real table (coordinator/table.ts): 1500 chips is ~75 big blinds. The old default of
// 400 was 20bb, and at 20bb heads-up is a push/fold game -- the correct strategy is a shove chart,
// most hands end all-in preflop, and the winner is decided by the deck. That is why this harness
// could never separate the tiers: it was not measuring poker, it was measuring coin flips.
const DEFAULTS = { startingChips: 1500, smallBlind: 10, bigBlind: 20, maxHands: 30, seedBase: 1, escalateEvery: 5 };

export async function simulateMatch(levelA: number, levelB: number, opts: SimOptions = {}): Promise<SimResult> {
  const o = { ...DEFAULTS, ...opts };
  const level: Record<Seat, number> = { A: levelA, B: levelB };
  const chips: Record<Seat, number> = { A: o.startingChips, B: o.startingChips };
  // The same opponent reads the real table keeps, so the harness measures the game we ship.
  const reads: Record<Seat, OpponentRead> = { A: emptyRead(), B: emptyRead() };

  let handIndex = 0;
  let busted = false;
  for (; handIndex < o.maxHands; handIndex++) {
    const { sb, bb } = blindsForHand(handIndex, o.smallBlind, o.bigBlind, o.escalateEvery);
    if (chips.A <= bb || chips.B <= bb) {
      busted = true;
      break;
    }
    const button: Seat = handIndex % 2 === 0 ? "A" : "B";
    const hand = new Hand({
      button,
      stacks: { A: chips.A, B: chips.B },
      smallBlind: sb,
      bigBlind: bb,
      seed: o.seedBase * 100000 + handIndex,
    });

    let guard = 0;
    while (!hand.isComplete()) {
      if (guard++ > 400) break;
      const seat = hand.toAct!;
      const opp = otherSeat(seat);
      const view = hand.publicView();
      const legal = hand.legalActions(seat);
      const pl = hand.players[seat];
      const decision = await decide(
        {
          seat,
          agentName: `L${level[seat]}`,
          level: level[seat],
          hole: pl.hole,
          street: view.street,
          board: view.board,
          pot: view.pot,
          myStack: view.stacks[seat],
          oppStack: view.stacks[opp],
          myCommitted: view.committedStreet[seat],
          oppCommitted: view.committedStreet[opp],
          currentBet: view.currentBet,
          bigBlind: bb,
          toCall: legal.callAmount,
          canCheck: legal.canCheck,
          canCall: legal.canCall,
          canRaise: legal.canRaise,
          minRaiseTo: legal.minRaiseTo,
          maxRaiseTo: legal.maxRaiseTo,
          history: hand.history.map((h) => `${h.seat} ${h.action}${h.amount ? " " + h.amount : ""}`),
          notes: describeRead(reads[opp], `L${level[opp]}`),
        },
        planForLevel(level[seat]),
      );
      const applied = hand.apply({ type: decision.action, size: decision.size });
      noteMove(reads[seat], applied, legal.callAmount > 0);
    }
    const r = hand.result;
    if (r?.reason === "showdown" && r.descr) {
      for (const s of ["A", "B"] as Seat[]) {
        noteShowdown(reads[s], hand.players[s].hole, hand.board, r.descr[s] ?? "", r.winner === s);
      }
    }
    for (const s of ["A", "B"] as Seat[]) reads[s].hands += 1;
    chips.A = hand.players.A.stack;
    chips.B = hand.players.B.stack;
  }

  // Exactly one winner: the survivor, or on the safety cap the chip leader, with the
  // higher tier taking a dead-even tie.
  const winner: Seat = chips.A === chips.B ? (levelA >= levelB ? "A" : "B") : chips.A > chips.B ? "A" : "B";
  return { winner, chips, hands: handIndex, busted };
}
