import { Hand, otherSeat } from "../poker/engine.js";
import type { Seat } from "../poker/types.js";
import { planForLevel } from "../reason/levels.js";
import { decide } from "../runners/pokerRunner.js";
import { anchorMove, verifyLatestForMandate, type AgentAvow } from "../avow/anchorMove.js";
import { recallNotes, rememberNote } from "../avow/memory.js";
import { coordinatorAddress, openTable, joinTable, settleTable, recordResult } from "../chain/sui.js";
import { buyAndDeliver } from "../intel/market.js";
import { loadRoster, avowFor, type RosterEntry } from "./roster.js";
import { broadcast, type MovePayload } from "./ws.js";
import { query } from "../db/pool.js";

// Run one heads-up match end to end: open a table and escrow both buy-ins on Sui, play
// N hands through the engine and the Haiku runner, anchor every move through Avow,
// settle on chain to the chip leader, and stream the whole thing over the feed. This is
// the Day 2 spine: agents play, provably, no intel yet.
//
// Chips are the in-game scoreboard; the SUI buy-ins are the real escrow. Whoever leads
// in chips after N hands is paid the pot on chain. Decoupling the two keeps the game
// fast while the money move stays real.

interface MatchAgent {
  seat: Seat;
  name: string;
  level: number;
  agentId: string;
  mandateId: string;
  avow: AgentAvow;
}

export interface MatchOptions {
  hands?: number;
  buyinMist?: bigint;
  startingChips?: number;
  smallBlind?: number;
  bigBlind?: number;
  /** Anchor every move through Avow. Off makes a fast engine/LLM-only dry run. */
  anchor?: boolean;
  /** The underdog buys a dossier on its opponent before the hand at this index. */
  intel?: { buyerSeat: Seat; beforeHand: number };
}

const DEFAULTS = {
  hands: 2,
  buyinMist: 50_000_000n, // 0.05 SUI
  startingChips: 1000,
  smallBlind: 10,
  bigBlind: 20,
  anchor: true,
};

function toMatchAgent(e: RosterEntry): MatchAgent {
  return {
    seat: e.key,
    name: e.name,
    level: e.level,
    agentId: e.agentId,
    mandateId: e.mandateId,
    avow: avowFor(e),
  };
}

export async function playMatch(opts: MatchOptions = {}): Promise<{ matchId: string; tableId: string; winner: Seat }> {
  const o = { ...DEFAULTS, ...opts };
  const roster = loadRoster();
  const bySeat: Record<Seat, MatchAgent> = {} as Record<Seat, MatchAgent>;
  for (const e of roster.agents) bySeat[e.key] = toMatchAgent(e);
  const A = bySeat.A;
  const B = bySeat.B;
  if (!A || !B) throw new Error("agents.json must define seats A and B (run setup:agents)");

  // Escrow on chain: open a table and seat both agents.
  const { tableId } = await openTable(o.buyinMist);
  const matchId = tableId;
  log(matchId, "status", { status: "opening", detail: `table ${short(tableId)} buyin ${fmtSui(o.buyinMist)}` });
  await joinTable(tableId, A.agentId, o.buyinMist);
  await joinTable(tableId, B.agentId, o.buyinMist);
  broadcast({
    type: "match",
    payload: {
      matchId,
      tableId,
      buyin: Number(o.buyinMist),
      agents: [
        { seat: "A", name: A.name, level: A.level, agentId: A.agentId },
        { seat: "B", name: B.name, level: B.level, agentId: B.agentId },
      ],
    },
  });
  log(matchId, "status", { status: "seated", detail: `${A.name} (L${A.level}) vs ${B.name} (L${B.level})` });

  const chips: Record<Seat, number> = { A: o.startingChips, B: o.startingChips };
  // Dossiers bought mid-match are injected into the buyer's decisions as notes.
  const injected: Record<Seat, string[]> = { A: [], B: [] };

  for (let handIndex = 0; handIndex < o.hands; handIndex++) {
    if (chips.A <= o.bigBlind || chips.B <= o.bigBlind) {
      log(matchId, "status", { status: "busted", detail: `after ${handIndex} hands` });
      break;
    }
    if (opts.intel && handIndex === opts.intel.beforeHand) {
      await runIntelBeat(matchId, tableId, opts.intel.buyerSeat, bySeat, injected);
    }
    const button: Seat = handIndex % 2 === 0 ? "A" : "B";
    await playHand(matchId, tableId, handIndex, button, bySeat, chips, injected, o);
  }

  const winner: Seat = chips.A >= chips.B ? "A" : "B";
  const loser = otherSeat(winner);
  const settleDigest = await settleTable(tableId, coordinatorAddress(), o.hands);
  broadcast({
    type: "settled",
    payload: {
      matchId,
      tableId,
      winnerOwner: coordinatorAddress(),
      amount: Number(o.buyinMist) * 2,
      digest: settleDigest,
    },
  });
  await bestEffort(() => recordResult(bySeat[winner].agentId, true));
  await bestEffort(() => recordResult(bySeat[loser].agentId, false));
  log(matchId, "status", { status: "settled", detail: `${bySeat[winner].name} wins, payout ${fmtSui(o.buyinMist * 2n)}` });

  // Day 2 acceptance: confirm one anchored move actually verifies.
  if (o.anchor) {
    const vr = await verifyLatestForMandate(bySeat[winner].mandateId).catch(() => null);
    if (vr) {
      broadcast({
        type: "verify",
        payload: {
          matchId,
          anchorDigest: "(latest)",
          hashMatches: vr.hashMatches,
          amountMatches: vr.amountMatches,
          withinMandate: vr.withinMandate,
          blobId: "(sealed)",
        },
      });
      log(matchId, "status", {
        status: "verified",
        detail: `hashMatches=${vr.hashMatches} amountMatches=${vr.amountMatches} withinMandate=${vr.withinMandate}`,
      });
    }
  }

  return { matchId, tableId, winner };
}

async function playHand(
  matchId: string,
  tableId: string,
  handIndex: number,
  button: Seat,
  bySeat: Record<Seat, MatchAgent>,
  chips: Record<Seat, number>,
  injected: Record<Seat, string[]>,
  o: typeof DEFAULTS,
): Promise<void> {
  const hand = new Hand({
    button,
    stacks: { A: chips.A, B: chips.B },
    smallBlind: o.smallBlind,
    bigBlind: o.bigBlind,
    seed: (Date.now() + handIndex * 7919) % 2_000_000_000,
  });
  log(matchId, "status", { status: "deal", detail: `hand ${handIndex + 1}/${o.hands}, button ${button}` });

  const moveRows: unknown[][] = [];

  let guard = 0;
  while (!hand.isComplete()) {
    if (guard++ > 400) throw new Error("hand did not terminate");
    const seat = hand.toAct!;
    const opp = otherSeat(seat);
    const me = bySeat[seat];
    const them = bySeat[opp];
    const view = hand.publicView();
    const legal = hand.legalActions(seat);
    const pl = hand.players[seat];

    const recalled = await recallNotes(me.avow.user, `betting and bluffing tendencies of ${them.name}`).catch(() => []);
    // Bought intel leads; recalled memory follows.
    const notes = [...injected[seat], ...recalled];

    const decision = await decide(
      {
        seat,
        agentName: me.name,
        level: me.level,
        hole: pl.hole,
        street: view.street,
        board: view.board,
        pot: view.pot,
        myStack: view.stacks[seat],
        oppStack: view.stacks[opp],
        myCommitted: view.committedStreet[seat],
        currentBet: view.currentBet,
        toCall: legal.callAmount,
        canCheck: legal.canCheck,
        canCall: legal.canCall,
        canRaise: legal.canRaise,
        minRaiseTo: legal.minRaiseTo,
        maxRaiseTo: legal.maxRaiseTo,
        oppLastAction: lastActionOf(hand, opp),
        history: hand.history.map((h) => `${h.seat} ${h.action}${h.amount ? " " + h.amount : ""} (${h.street})`),
        notes,
      },
      planForLevel(me.level),
    );

    const streetAtDecision = view.street;
    const boardAtDecision = view.board;
    const applied = hand.apply({ type: decision.action, size: decision.size });
    const after = hand.publicView();

    // Anchor the move through Avow. Best effort: a Walrus hiccup must not stall play.
    let blobId: string | null = null;
    let evidenceHash: string | null = null;
    let anchorDigest: string | null = null;
    if (o.anchor) {
      try {
        const proof = await anchorMove(me.avow, {
          seat,
          street: streetAtDecision,
          board: boardAtDecision,
          holeCards: pl.hole,
          pot: view.pot,
          action: applied.action,
          size: decision.size,
          amount: applied.amount,
          rationale: decision.rationale,
          opponentAgentId: them.agentId,
          before: view,
          after,
        });
        blobId = proof.blobId;
        evidenceHash = proof.evidenceHashHex;
        anchorDigest = proof.anchorDigest;
      } catch (e) {
        console.warn(`anchor failed (${me.name} ${applied.action}):`, (e as Error).message);
      }
    }

    const payload: MovePayload = {
      matchId,
      tableId,
      handIndex,
      street: streetAtDecision,
      board: boardAtDecision,
      pot: after.pot,
      seat,
      agentName: me.name,
      agentId: me.agentId,
      level: me.level,
      action: applied.action,
      size: decision.size,
      amount: applied.amount,
      rationale: decision.rationale,
      samples: decision.samples,
      agreement: decision.agreement,
      blobId,
      evidenceHash,
      anchorDigest,
      withinMandate: anchorDigest ? true : null,
    };
    broadcast({ type: "move", payload });

    moveRows.push([
      tableId,
      handIndex,
      streetAtDecision,
      seat,
      me.agentId,
      applied.action,
      applied.amount,
      decision.rationale,
      decision.samples,
      blobId,
      evidenceHash,
      anchorDigest,
      anchorDigest ? true : null,
    ]);
  }

  const result = hand.result!;
  chips.A = hand.players.A.stack;
  chips.B = hand.players.B.stack;

  broadcast({
    type: "hand",
    payload: {
      matchId,
      tableId,
      handIndex,
      board: hand.board,
      pot: result.pot,
      winnerSeat: result.winner,
      reason: result.reason,
      descr: result.descr,
      stacks: { A: chips.A, B: chips.B },
    },
  });

  await persistHand(tableId, handIndex, button, hand, result, chips, moveRows);

  // Each agent jots a short note for future hands.
  const winnerName = result.winner === "split" ? "nobody" : bySeat[result.winner].name;
  await bestEffort(() =>
    rememberNote(
      bySeat.A.avow.user,
      `Hand ${handIndex + 1}: board ${hand.board.join(" ") || "preflop"}, ${winnerName} won ${result.pot} by ${result.reason}.`,
    ),
  );
  await bestEffort(() =>
    rememberNote(
      bySeat.B.avow.user,
      `Hand ${handIndex + 1}: board ${hand.board.join(" ") || "preflop"}, ${winnerName} won ${result.pot} by ${result.reason}.`,
    ),
  );
}

// The intel beat: the buyer pays for a dossier on its opponent, the coordinator
// verifies the payment on chain, compiles the dossier from the opponent's real
// anchored records, re-seals it to the buyer, and loads it into the buyer's notes for
// the rest of the match. Best effort: a failed purchase must not sink the match.
async function runIntelBeat(
  matchId: string,
  tableId: string,
  buyerSeat: Seat,
  bySeat: Record<Seat, MatchAgent>,
  injected: Record<Seat, string[]>,
): Promise<void> {
  const buyer = bySeat[buyerSeat];
  const target = bySeat[otherSeat(buyerSeat)];
  log(matchId, "status", { status: "intel", detail: `${buyer.name} buys a dossier on ${target.name}` });
  try {
    const delivered = await buyAndDeliver({
      tableId,
      targetAgentId: target.agentId,
      buyer: buyer.avow,
    });
    const summary = delivered.dossier.summary;
    injected[buyerSeat].push(`Scouting report on ${target.name}: ${summary}`);
    broadcast({
      type: "intel",
      payload: {
        matchId,
        buyerSeat,
        targetAgentId: target.agentId,
        amount: Number(delivered.amount),
        payDigest: delivered.payDigest,
        dossierDigest: delivered.dossier.anchor?.anchorDigest ?? null,
        summary,
      },
    });
    log(matchId, "status", {
      status: "intel-delivered",
      detail: `${delivered.dossier.verifiedCount}/${delivered.dossier.sourceCount} moves verified; loaded into ${buyer.name}`,
    });
  } catch (e) {
    console.warn(`intel beat failed:`, (e as Error).message);
    log(matchId, "status", { status: "intel-failed", detail: (e as Error).message });
  }
}

function lastActionOf(hand: Hand, seat: Seat): string | undefined {
  for (let i = hand.history.length - 1; i >= 0; i--) {
    const h = hand.history[i]!;
    if (h.seat === seat) return `${h.action}${h.amount ? " " + h.amount : ""} on the ${h.street}`;
  }
  return undefined;
}

async function persistHand(
  tableId: string,
  handIndex: number,
  button: Seat,
  hand: Hand,
  result: NonNullable<Hand["result"]>,
  chips: Record<Seat, number>,
  moveRows: unknown[][],
): Promise<void> {
  await bestEffort(async () => {
    const winnerOwner = result.winner === "split" ? null : coordinatorAddress();
    const { rows } = await query<{ id: string }>(
      `insert into hands (table_id, hand_index, button, board, pot, winner_seat, winner_owner, reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (table_id, hand_index) do update set
         board = excluded.board, pot = excluded.pot, winner_seat = excluded.winner_seat,
         winner_owner = excluded.winner_owner, reason = excluded.reason
       returning id`,
      [tableId, handIndex, button, hand.board, result.pot, result.winner, winnerOwner, result.reason],
    );
    const handId = rows[0]?.id;
    if (!handId) return;
    for (const r of moveRows) {
      await query(
        `insert into moves
           (table_id, hand_id, street, seat, agent_id, action, amount, rationale, samples, blob_id, evidence_hash, anchor_digest, within_mandate)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [r[0], handId, r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12]],
      );
    }
  });
}

async function bestEffort(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.warn("non-fatal:", (e as Error).message);
  }
}

function log(matchId: string, _t: "status", payload: { status: string; detail?: string }): void {
  broadcast({ type: "status", payload: { matchId, ...payload } });
  console.log(`[${short(matchId)}] ${payload.status}${payload.detail ? " - " + payload.detail : ""}`);
}

function short(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}..${id.slice(-4)}` : id;
}

function fmtSui(mist: bigint): string {
  return `${Number(mist) / 1e9} SUI`;
}
