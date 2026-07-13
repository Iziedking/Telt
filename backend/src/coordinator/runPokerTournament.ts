import { playMatch } from "./table.js";
import { provisionAgentEntry, type Participant } from "./provision.js";
import { settleContest } from "../chain/sui.js";
import { broadcast } from "./ws.js";
import {
  buildBracket,
  nextMatch,
  recordResult,
  champion,
  placements,
  roundName,
  type Bracket,
} from "../poker/bracket.js";
import type { BracketSeat, BracketSnapshot } from "./ws.js";

// The poker championship: a single-elimination knockout of up to eight agents, seeded by
// level so the strongest meet last, played through the ordinary heads-up table one match at
// a time. The bracket never taught the poker engine about more than two seats -- it just
// maps eight players onto A-versus-B pairs and advances the winners.
//
// Two things make this more than a long duel.
//
// SCOUTING COMPOUNDS. Every move an agent makes is anchored, and the x402 intel market
// compiles a dossier from an opponent's anchored history. In a one-off match there is barely
// any history to buy. In a bracket there is: by the semifinal your opponent has played two
// matches in front of you, and the dossier that was worthless in round one is now a real
// read. Intel gets MORE valuable the deeper the tournament goes, which is a market that only
// exists because the games are on chain, and it is why the higher tiers' larger dossier
// budget is worth paying for.
//
// PLACEMENT IS RANKED, THE POT IS NOT. The on-chain contest settles winner-take-all, so the
// champion takes the pool. But the bracket knows exactly how far every agent got, so the
// podium and the standings rank the whole field honestly. A house agent can win the bracket
// on the table and still not take a real player's money.

const DEFAULT_SEATS = Number(process.env.POKER_TOURNEY_SEATS ?? "8");

export interface TourneyPlayer {
  agentId: string;
  isHouse: boolean;
}

function snapshot(
  contestId: string,
  bracket: Bracket,
  seats: BracketSeat[],
  status: BracketSnapshot["status"],
  live: { round: number; index: number } | null,
): BracketSnapshot {
  const total = bracket.rounds.length;
  const nameOf = (id: string | null) => seats.find((s) => s.agentId === id)?.name ?? "—";
  const m = live ? bracket.rounds[live.round]?.[live.index] : null;
  return {
    contestId,
    status,
    size: bracket.size,
    capacity: seats.length || DEFAULT_SEATS,
    filled: seats.length,
    rounds: bracket.rounds.map((round) =>
      round.map((x) => ({
        round: x.round,
        index: x.index,
        a: x.a,
        b: x.b,
        winner: x.winner,
        live: Boolean(live && live.round === x.round && live.index === x.index),
      })),
    ),
    seats,
    currentMatch:
      live && m
        ? {
            round: live.round,
            index: live.index,
            label: `${roundName(live.round, total)} · ${nameOf(m.a)} vs ${nameOf(m.b)}`,
          }
        : null,
    champion: champion(bracket),
    placements: status === "complete" ? placements(bracket) : [],
  };
}

export async function runPokerTournament(contestId: string, entries: TourneyPlayer[]): Promise<void> {
  const field = entries.slice(0, DEFAULT_SEATS);

  // Provision every agent ONCE for the whole bracket. A non-roster agent costs two chain
  // transactions to provision (a coordinator-owned mandate and its evidence access), so doing
  // it per round would pay that bill three times for a finalist. Seats are reassigned per
  // match; the identity is stable.
  const provisioned = new Map<string, Participant>();
  for (const e of field) {
    provisioned.set(e.agentId, await provisionAgentEntry(e.agentId, "A", e.isHouse));
  }

  const levelOf = (id: string) => provisioned.get(id)?.level ?? 0;
  const bracket = buildBracket(field.map((e) => ({ agentId: e.agentId, level: levelOf(e.agentId) })));

  // Seat metadata in seed order (strongest first), matching buildBracket's own sort so the
  // seed numbers shown in the room are the ones the draw actually used.
  const seeded = [...field].sort(
    (a, b) => levelOf(b.agentId) - levelOf(a.agentId) || a.agentId.localeCompare(b.agentId),
  );
  const seats: BracketSeat[] = seeded.map((e, i) => {
    const p = provisioned.get(e.agentId)!;
    return { agentId: e.agentId, name: p.name, level: p.level, isHouse: e.isHouse, seed: i + 1 };
  });

  broadcast({ type: "bracket", payload: snapshot(contestId, bracket, seats, "playing", null) });
  broadcast({
    type: "status",
    payload: { status: "running", detail: `Championship: ${field.length} agents, single elimination` },
  });

  const total = bracket.rounds.length;

  // Play every pending match in bracket order. Wrapped, so an unexpected failure still falls
  // through to settlement with the bracket as it stands rather than stranding the pool.
  try {
    let m = nextMatch(bracket);
    while (m) {
      const a = provisioned.get(m.a!)!;
      const b = provisioned.get(m.b!)!;
      const label = `${roundName(m.round, total)} · ${a.name} vs ${b.name}`;

      broadcast({ type: "status", payload: { status: "running", detail: `${label} — playing` } });
      broadcast({
        type: "bracket",
        payload: snapshot(contestId, bracket, seats, "playing", { round: m.round, index: m.index }),
      });

      // The higher seed takes seat A. Seat itself carries no edge (the button alternates and
      // the tie-break is drawn from the match id), so this is presentation, not an advantage.
      const participants: Participant[] = [
        { ...a, key: "A" },
        { ...b, key: "B" },
      ];
      const { winnerAgentId } = await playMatch({
        participants,
        sponsorTable: false,
        intelRef: contestId,
      });

      const winner = winnerAgentId === b.agentId ? b : a;
      const loser = winner.agentId === a.agentId ? b : a;
      recordResult(bracket, m.round, m.index, winner.agentId);

      broadcast({
        type: "status",
        payload: { status: "running", detail: `${winner.name} knocks out ${loser.name}` },
      });
      broadcast({ type: "bracket", payload: snapshot(contestId, bracket, seats, "playing", null) });

      m = nextMatch(bracket);
    }
  } catch (err) {
    console.error(`[tournament ${contestId.slice(0, 10)}] bracket aborted, settling on what was played:`, (err as Error).message);
  }

  const placed = placements(bracket);
  broadcast({ type: "bracket", payload: snapshot(contestId, bracket, seats, "complete", null) });

  // The pool is winner-take-all on chain and house agents cannot be paid, so it goes to the
  // best REAL agent by placement. A house agent may lift the trophy on the table; it never
  // lifts the money.
  const placeOf = new Map(placed.map((p) => [p.agentId, p.place]));
  const eligible = field
    .filter((e) => !e.isHouse)
    .sort((x, y) => (placeOf.get(x.agentId) ?? 99) - (placeOf.get(y.agentId) ?? 99));
  const payee = eligible[0];
  if (!payee) {
    console.warn(`[tournament ${contestId.slice(0, 10)}] no real entrant to pay, leaving the pool open`);
    return;
  }

  const champ = champion(bracket);
  const champName = seats.find((s) => s.agentId === champ)?.name ?? "—";
  const payeeName = provisioned.get(payee.agentId)?.name ?? "—";
  broadcast({
    type: "status",
    payload: {
      status: "running",
      detail:
        champ === payee.agentId
          ? `${champName} wins the championship`
          : `${champName} wins the bracket · pool to ${payeeName}`,
    },
  });

  await settleContest(contestId, payee.agentId);
  console.log(`[tournament ${contestId.slice(0, 10)}] settled, pool to ${payeeName}`);
}
