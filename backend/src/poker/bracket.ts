// Single-elimination bracket for a poker championship (up to 8 agents). Pure and
// self-contained: it seeds players by level, produces the rounds, advances winners, and
// computes final placements. No engine, no chain, no model. The tournament runner drives
// it by playing each pending match through the ordinary heads-up table and reporting the
// winner, which is why the poker engine never had to learn about more than two seats.

export interface Seedable {
  agentId: string;
  /** Higher is stronger. Seeded so the strongest agents meet last. */
  level: number;
}

export interface BracketMatch {
  round: number; // 0 = first round (quarterfinal for 8), last round = final
  index: number; // match index within the round
  a: string | null; // agentId, or null until a prior round feeds it
  b: string | null;
  winner: string | null;
}

export interface Bracket {
  /** Padded to a power of two; short fields get byes. */
  size: number;
  rounds: BracketMatch[][];
}

// Standard seeding order, so the top seeds only meet in the later rounds: seed 1 draws the
// weakest survivor at every stage, and 1 and 2 can only meet in the final.
function seedOrder(size: number): number[] {
  let order = [0];
  while (order.length < size) {
    const next: number[] = [];
    const pairSum = order.length * 2 - 1;
    for (const s of order) {
      next.push(s);
      next.push(pairSum - s);
    }
    order = next;
  }
  return order;
}

// Build the bracket from the field. Players are seeded by level (strongest first, ties to
// the lower agent id so the draw is deterministic), then placed into the standard slots. A
// field short of the next power of two gets byes: a null opponent auto-advances.
export function buildBracket(players: Seedable[]): Bracket {
  const seeded = [...players].sort((a, b) => b.level - a.level || a.agentId.localeCompare(b.agentId));
  let size = 1;
  while (size < seeded.length) size *= 2;
  size = Math.max(2, size);

  const order = seedOrder(size);
  const slots: (string | null)[] = order.map((seed) => seeded[seed]?.agentId ?? null);

  const rounds: BracketMatch[][] = [];
  const first: BracketMatch[] = [];
  for (let i = 0; i < size / 2; i++) {
    const a = slots[i * 2] ?? null;
    const b = slots[i * 2 + 1] ?? null;
    const winner = a !== null && b === null ? a : b !== null && a === null ? b : null;
    first.push({ round: 0, index: i, a, b, winner });
  }
  rounds.push(first);

  let count = size / 2;
  let round = 1;
  while (count > 1) {
    count /= 2;
    const matches: BracketMatch[] = [];
    for (let i = 0; i < count; i++) matches.push({ round, index: i, a: null, b: null, winner: null });
    rounds.push(matches);
    round += 1;
  }

  // Feed any bye winners forward so the first real match is correctly seeded.
  for (let r = 0; r < rounds.length - 1; r++) {
    for (const m of rounds[r]!) {
      if (m.winner !== null) feedForward(rounds, r, m.index, m.winner);
    }
  }
  return { size, rounds };
}

function feedForward(rounds: BracketMatch[][], round: number, index: number, winner: string): void {
  const next = rounds[round + 1];
  if (!next) return;
  const slot = next[Math.floor(index / 2)]!;
  if (index % 2 === 0) slot.a = winner;
  else slot.b = winner;
}

/** The next match ready to play (both sides known, no winner yet), or null when it is over. */
export function nextMatch(bracket: Bracket): BracketMatch | null {
  for (const round of bracket.rounds) {
    for (const m of round) {
      if (m.winner === null && m.a !== null && m.b !== null) return m;
    }
  }
  return null;
}

/** Record a result and advance the winner into the next round. */
export function recordResult(bracket: Bracket, round: number, index: number, winner: string): void {
  const m = bracket.rounds[round]?.[index];
  if (!m) return;
  m.winner = winner;
  feedForward(bracket.rounds, round, index, winner);
}

export function isComplete(bracket: Bracket): boolean {
  const final = bracket.rounds[bracket.rounds.length - 1]?.[0];
  return Boolean(final && final.winner !== null);
}

export function champion(bracket: Bracket): string | null {
  return bracket.rounds[bracket.rounds.length - 1]?.[0]?.winner ?? null;
}

// Final placement for every agent: 1 is the champion, 2 the runner-up, and the rest tie on
// the round they went out in, so semifinal losers share 3rd and quarterfinal losers share
// 5th. The pot is winner-take-all on chain, so this drives the podium and the standings
// rather than the money -- but it is the honest ranking of how far each agent actually got.
export function placements(bracket: Bracket): { agentId: string; place: number }[] {
  const out: { agentId: string; place: number }[] = [];
  const champ = champion(bracket);
  if (champ !== null) out.push({ agentId: champ, place: 1 });

  for (let r = 0; r < bracket.rounds.length; r++) {
    // Losers of round r share the place just below the number of players who got past it.
    const survivors = bracket.size / Math.pow(2, r + 1);
    const place = survivors + 1;
    for (const m of bracket.rounds[r]!) {
      if (m.winner === null) continue;
      const loser = m.a === m.winner ? m.b : m.a;
      if (loser !== null) out.push({ agentId: loser, place });
    }
  }
  return out.sort((a, b) => a.place - b.place);
}

/** "Final" / "Semifinal" / "Quarterfinal", read from the tail of the bracket. */
export function roundName(round: number, totalRounds: number): string {
  const fromEnd = totalRounds - 1 - round;
  if (fromEnd === 0) return "Final";
  if (fromEnd === 1) return "Semifinal";
  if (fromEnd === 2) return "Quarterfinal";
  return `Round ${round + 1}`;
}
