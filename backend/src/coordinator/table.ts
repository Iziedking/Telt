import { Hand, otherSeat } from "../poker/engine.js";
import { blindsForHand } from "../poker/blinds.js";
import type { Seat } from "../poker/types.js";
import { planForLevel, intelBudgetForLevel } from "../reason/levels.js";
import { decide, wantsIntel } from "../runners/pokerRunner.js";
import { anchorMove, verifyLatestForMandate, type AgentAvow } from "../avow/anchorMove.js";
import { recallNotes, rememberNote } from "../avow/memory.js";
import { coordinatorAddress, openTable, joinTable, settleTable, recordResult } from "../chain/sui.js";
import { buyAndDeliver } from "../intel/market.js";
import { loadRoster, avowFor, isPlatformAgent, type RosterEntry } from "./roster.js";
import { type Participant } from "./provision.js";
import { broadcast, type MovePayload } from "./ws.js";
import { query, persist } from "../db/pool.js";

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

// Monotonic id for each move broadcast, so a late-arriving proof can be matched to its move.
let moveSeq = 0;

export interface MatchOptions {
  hands?: number;
  buyinMist?: bigint;
  startingChips?: number;
  smallBlind?: number;
  bigBlind?: number;
  /** Anchor every move through Avow. Off makes a fast engine/LLM-only dry run. */
  anchor?: boolean;
  /** The underdog buys a dossier on its opponent before the hand at this index. When buyerSeat is
   *  omitted, the buyer is whichever seat is actually behind on chips at that point. */
  intel?: { buyerSeat?: Seat; beforeHand: number };
  /** A valid on-chain object id for `buy_intel` to reference when there is no SUI table (a contest
   *  passes its contest id). buy_intel only records this id, so any real object id works and intel
   *  can run in contests, not just standalone. */
  intelRef?: string;
  /** Play a freezeout until one agent busts (a natural single winner). Default true. */
  untilBust?: boolean;
  /** Safety cap on hands when playing to bust. */
  maxHands?: number;
  /** Blinds double every this many hands, to force a bust. */
  escalateEvery?: number;
  /** Who plays seats A and B. Defaults to the two platform agents from the roster. */
  participants?: Participant[];
  /**
   * Open and settle an on-chain SUI table to escrow the buy-in. Default true for the standalone
   * demo (the coordinator owns both agents). Set false for a contest, where the coordinator does
   * not own the players' agents (join_table would abort) and the tUSDC pool is the real escrow.
   */
  sponsorTable?: boolean;
}

const DEFAULTS = {
  hands: 2,
  buyinMist: 50_000_000n, // 0.05 SUI
  // ~60 big blinds deep: enough room for real preflop/flop/turn/river play and several hands,
  // instead of a 15 BB push/fold stack where one pot busts someone and the game ends instantly.
  startingChips: 1200,
  smallBlind: 10,
  bigBlind: 20,
  anchor: true,
  untilBust: true,
  sponsorTable: true,
  maxHands: 24,
  // Blinds escalate slowly so the stacks stay deep through the early hands; the maxHands cap still
  // guarantees the freezeout resolves.
  escalateEvery: 8,
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

export async function playMatch(
  opts: MatchOptions = {},
): Promise<{ matchId: string; tableId: string; winner: Seat; winnerAgentId: string }> {
  const o = { ...DEFAULTS, ...opts };
  // Seat whoever is passed in (a user's agent and/or platform agents); default to the two
  // platform agents from the roster.
  const seatList: RosterEntry[] = opts.participants ?? loadRoster().agents.slice(0, 2);
  const bySeat: Record<Seat, MatchAgent> = {} as Record<Seat, MatchAgent>;
  for (const e of seatList) bySeat[e.key] = toMatchAgent(e);
  const A = bySeat.A;
  const B = bySeat.B;
  if (!A || !B) throw new Error("a poker match needs two agents seated at A and B");

  // Escrow on chain: open a SUI table and seat both agents. For a contest we skip this, since
  // the coordinator does not own the players' agents (join_table would abort) and the tUSDC pool
  // is the real escrow; the hands still play and anchor exactly the same off a synthetic id.
  const tableId = o.sponsorTable ? (await openTable(o.buyinMist)).tableId : `off-${Date.now().toString(36)}`;
  const matchId = tableId;
  // The valid on-chain id `buy_intel` references: the SUI table for a standalone match, or the
  // contest id for a contest. Empty when neither (a dry run), which disables intel.
  const intelRef = o.sponsorTable ? tableId : (o.intelRef ?? "");
  log(matchId, "status", { status: "opening", detail: o.sponsorTable ? `table ${short(tableId)} buyin ${fmtSui(o.buyinMist)}` : "contest table (off-chain escrow)" });
  if (o.sponsorTable) {
    await joinTable(tableId, A.agentId, o.buyinMist);
    await joinTable(tableId, B.agentId, o.buyinMist);
  }
  broadcast({
    type: "match",
    payload: {
      matchId,
      tableId,
      buyin: Number(o.buyinMist),
      agents: [
        { seat: "A", name: A.name, level: A.level, agentId: A.agentId, platform: isPlatformAgent(A.agentId) },
        { seat: "B", name: B.name, level: B.level, agentId: B.agentId, platform: isPlatformAgent(B.agentId) },
      ],
    },
  });
  log(matchId, "status", { status: "seated", detail: `${A.name} (L${A.level}) vs ${B.name} (L${B.level})` });

  const chips: Record<Seat, number> = { A: o.startingChips, B: o.startingChips };
  // Tie-break seat, varied per match (not always A), used when chips are dead even.
  const tieBreak: Seat = matchId.charCodeAt(matchId.length - 1) % 2 === 0 ? "A" : "B";
  // Dossiers bought mid-match are injected into the buyer's decisions as notes.
  const injected: Record<Seat, string[]> = { A: [], B: [] };
  // How many dossiers each seat has bought this match, against its per-tier cap.
  const intelBought: Record<Seat, number> = { A: 0, B: 0 };

  // Intel runs in any match that anchors and has a valid on-chain id to reference (a standalone
  // SUI table or a contest id) — standalone AND contests, not just standalone. Whether and when a
  // dossier is actually bought is the agent's own reasoned choice each hand (below), not scripted.
  const intelOn = "intel" in opts ? opts.intel != null : Boolean(o.anchor && intelRef);

  // A freezeout: play until one agent can no longer post the big blind (busted), or the
  // safety cap. Either way the match yields exactly one winner.
  const cap = o.untilBust ? o.maxHands : o.hands;
  let handsPlayed = 0;
  for (let handIndex = 0; handIndex < cap; handIndex++) {
    const { sb, bb } = blindsForHand(handIndex, o.smallBlind, o.bigBlind, o.escalateEvery);
    if (chips.A <= bb || chips.B <= bb) {
      log(matchId, "status", { status: "busted", detail: `${otherSeat(chips.A <= bb ? "A" : "B")} takes it after ${handIndex} hands` });
      break;
    }
    // From the second hand on, the trailing agent (with intel budget left) decides for itself
    // whether a dossier is worth the x402 fee this hand. Reasoned and variable, not programmed.
    if (intelOn && handIndex >= 1) {
      const behind: Seat = chips.A < chips.B ? "A" : chips.B < chips.A ? "B" : tieBreak;
      const ag = bySeat[behind];
      const budget = intelBudgetForLevel(ag.level);
      if (intelBought[behind] < budget) {
        const oppSeat = otherSeat(behind);
        const choice = await wantsIntel(
          {
            agentName: ag.name,
            myChips: chips[behind],
            oppName: bySeat[oppSeat].name,
            oppChips: chips[oppSeat],
            handIndex,
            bought: intelBought[behind],
            budget,
          },
          planForLevel(ag.level),
        ).catch(() => ({ buy: false, reason: "" }));
        if (choice.buy) await runIntelBeat(matchId, intelRef, behind, bySeat, injected, intelBought);
      }
    }
    const button: Seat = handIndex % 2 === 0 ? "A" : "B";
    await playHand(matchId, tableId, handIndex, button, bySeat, chips, injected, o, sb, bb);
    handsPlayed = handIndex + 1;
  }

  // Exactly one winner: the survivor, or the chip leader at the cap (higher seat A on a
  // dead-even tie, which is vanishingly rare).
  const winner: Seat = chips.A > chips.B ? "A" : chips.B > chips.A ? "B" : tieBreak;
  const loser = otherSeat(winner);
  const settleDigest = o.sponsorTable ? await settleTable(tableId, coordinatorAddress(), handsPlayed) : "";
  broadcast({
    type: "settled",
    payload: {
      matchId,
      tableId,
      winnerOwner: coordinatorAddress(),
      amount: o.sponsorTable ? Number(o.buyinMist) * 2 : 0,
      digest: settleDigest,
    },
  });
  // Real agents are graded; platform (house) agents never are.
  if (!isPlatformAgent(bySeat[winner].agentId)) await bestEffort(() => recordResult(bySeat[winner].agentId, true));
  if (!isPlatformAgent(bySeat[loser].agentId)) await bestEffort(() => recordResult(bySeat[loser].agentId, false));
  log(matchId, "status", {
    status: "settled",
    // Contests pay the tUSDC pool (settled by the caller); only the standalone SUI table has a SUI payout.
    detail: o.sponsorTable ? `${bySeat[winner].name} wins, payout ${fmtSui(o.buyinMist * 2n)}` : `${bySeat[winner].name} wins`,
  });

  // Day 2 acceptance: confirm one anchored move actually verifies. Fire-and-forget, so a slow
  // or stuck verify never blocks the match from returning and the contest pool from settling.
  if (o.anchor) {
    void verifyLatestForMandate(bySeat[winner].mandateId)
      .then((vr) => {
        if (!vr) return;
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
      })
      .catch(() => {});
  }

  return { matchId, tableId, winner, winnerAgentId: bySeat[winner].agentId };
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
  smallBlind: number,
  bigBlind: number,
): Promise<void> {
  const hand = new Hand({
    button,
    stacks: { A: chips.A, B: chips.B },
    smallBlind,
    bigBlind,
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

    // Anchor the move through Avow, but never block live play on it: the move streams now,
    // and the proof (Walrus blob, serialized so it cannot race the gas coin) lands a moment
    // later as a "moveProven" update. A Walrus hiccup just means a move stays unproven.
    const moveKey = `${matchId}:${++moveSeq}`;
    if (o.anchor) {
      void anchorMove(me.avow, {
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
      })
        .then((proof) => {
          broadcast({
            type: "moveProven",
            payload: {
              matchId,
              moveKey,
              blobId: proof.blobId,
              evidenceHash: proof.evidenceHashHex,
              anchorDigest: proof.anchorDigest,
              // The mandate the move was actually anchored under. For a user's agent this is the
              // coordinator-provisioned mandate, not the agent's registered one, so verify must use
              // this rather than resolving the agent's on-chain mandate (which would 404).
              mandateId: me.avow.mandateId,
            },
          });
        })
        .catch((e) => console.warn(`anchor failed (${me.name} ${applied.action}):`, (e as Error).message));
    }

    const payload: MovePayload = {
      matchId,
      tableId,
      handIndex,
      moveKey,
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
      blobId: null,
      evidenceHash: null,
      anchorDigest: null,
      withinMandate: null,
      mandateId: me.avow.mandateId,
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
      // The anchor lands asynchronously after the row is written, so the proof columns are
      // filled by the moveProven broadcast on the client rather than recorded here.
      null,
      null,
      null,
      null,
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
  intelBought: Record<Seat, number>,
): Promise<void> {
  const buyer = bySeat[buyerSeat];
  const target = bySeat[otherSeat(buyerSeat)];

  // Per-tier spending cap: refuse once this tier has used its dossier budget for the
  // match, so an agent cannot buy a fresh read every street.
  const budget = intelBudgetForLevel(buyer.level);
  if (intelBought[buyerSeat] >= budget) {
    log(matchId, "status", {
      status: "intel-capped",
      detail: `${buyer.name} hit its tier intel cap (${intelBought[buyerSeat]}/${budget})`,
    });
    return;
  }

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
    intelBought[buyerSeat] += 1;
    log(matchId, "status", {
      status: "intel-delivered",
      detail: `${delivered.dossier.verifiedCount}/${delivered.dossier.sourceCount} moves verified; loaded into ${buyer.name} (${intelBought[buyerSeat]}/${budget})`,
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
  await persist(async () => {
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

// Best-effort side work (anchoring a move, recording a result). It must never stall the
// match: if the coordinator transaction errors or hangs, we log it and move on, so a slow or
// contended tx cannot freeze the game mid-hand.
async function bestEffort(fn: () => Promise<unknown>, timeoutMs = 25_000): Promise<void> {
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), timeoutMs)),
    ]);
  } catch (e) {
    console.warn("non-fatal:", (e as Error).message || "(no message)");
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
