import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";

// Broadcasts the live arena feed to every connected client. Small JSON envelopes
// tagged by type, so the frontend can show each move the moment it lands, with its
// Avow provenance (the "verifiable on Walrus" badge). Ported and trimmed from Zerun's
// coordinator/ws.ts.

export interface MovePayload {
  matchId: string;
  tableId: string;
  handIndex: number;
  // Unique per move, so a late "moveProven" can update the right move.
  moveKey: string;
  street: string;
  board: string[];
  pot: number;
  seat: string;
  agentName: string;
  agentId: string;
  level: number;
  action: string;
  size: number;
  amount: number;
  rationale: string;
  samples: number;
  agreement: number;
  // The engine's half of the decision, shown next to the agent's reasoning. `equity` is the
  // hand's win probability; `candidates` is the priced shortlist the agent was allowed to choose
  // from, and `chose` is which one it took. Together these are the honest picture of an agent's
  // decision: the arithmetic it was given, and the judgment it applied on top.
  equity: number;
  candidates: { action: string; size: number; ev: number; label: string }[];
  chose: number;
  // Avow anchor for this move, the verify badge.
  blobId: string | null;
  evidenceHash: string | null;
  anchorDigest: string | null;
  withinMandate: boolean | null;
  // The mandate the move was anchored under; verify uses it (a user's agent is anchored under a
  // coordinator-provisioned mandate, not its registered one).
  mandateId: string | null;
}

// A move's proof landing after the move was already shown live.
export interface MoveProvenPayload {
  matchId: string;
  moveKey: string;
  blobId: string;
  evidenceHash: string;
  anchorDigest: string;
  mandateId: string;
}

export interface HandPayload {
  matchId: string;
  tableId: string;
  handIndex: number;
  board: string[];
  pot: number;
  winnerSeat: string;
  reason: string;
  descr?: Record<string, string>;
  stacks: Record<string, number>;
}

export interface IntelPayload {
  matchId: string;
  buyerSeat: string;
  targetAgentId: string;
  amount: number;
  payDigest: string;
  dossierDigest: string | null;
  summary: string;
}

export interface MatchPayload {
  matchId: string;
  tableId: string;
  buyin: number;
  agents: { seat: string; name: string; level: number; agentId: string; platform?: boolean }[];
}

// --- Championship feed (the single-elimination bracket) ---
// One envelope carries the whole tournament: who is seated, the draw, which match is on the
// table right now, and the podium once it is done. The room can render every state from this
// alone, and a spectator who joins mid-bracket gets the full picture from the replay buffer.
export interface BracketSeat {
  agentId: string;
  name: string;
  level: number;
  isHouse: boolean;
  /** 1 is the top seed. Seeded by level, so the strongest agents meet last. */
  seed: number;
}

export interface BracketMatchView {
  round: number;
  index: number;
  a: string | null;
  b: string | null;
  winner: string | null;
  /** True for the match currently being played at the table. */
  live: boolean;
}

export interface BracketSnapshot {
  contestId: string;
  status: "lobby" | "playing" | "complete";
  /** Padded to a power of two; a short field gets byes. */
  size: number;
  capacity: number;
  filled: number;
  rounds: BracketMatchView[][];
  seats: BracketSeat[];
  currentMatch: { round: number; index: number; label: string } | null;
  champion: string | null;
  /** Final standings, once complete: 1 champion, 2 runner-up, semifinalists share 3rd. */
  placements: { agentId: string; place: number }[];
}

// --- Solver feed (the quiz game) ---
export interface SolverMatchPayload {
  matchId: string;
  puzzleCount: number;
  secondsPerQuestion?: number;
  webGrounded: boolean;
  agents: { seat: string; name: string; level: number; agentId: string; platform?: boolean }[];
}
export interface SolverPuzzlesPayload {
  matchId: string;
  puzzles: { index: number; topic: string; question: string; options: string[]; grounded: boolean }[];
}
export interface PuzzlePayload {
  matchId: string;
  index: number;
  total: number;
  topic: string;
  question: string;
  options: string[];
  grounded: boolean;
}
export interface AnswerPayload {
  matchId: string;
  index: number;
  seat: string;
  agentName: string;
  agentId: string;
  level: number;
  choice: number;
  correct: boolean;
  rationale: string;
  samples: number;
  agreement: number;
  // Avow anchor for this answer, the verify badge.
  blobId: string | null;
  evidenceHash: string | null;
  anchorDigest: string | null;
  withinMandate: boolean | null;
}
export interface PuzzleResultPayload {
  matchId: string;
  index: number;
  answer: number;
  explanation: string;
  sources: string[];
  scores: Record<string, number>;
}
export interface SolverSettledPayload {
  matchId: string;
  winnerSeat: string;
  winnerName: string;
  scores: Record<string, number>;
  /** How a tie was broken ("sudden death" | "tier" | "split"), or null when the score decided it. */
  tiebreak?: string | null;
  /** True for a genuine dead heat: nobody won and the pool was split equally. */
  tie?: boolean;
}

export type FeedMessage =
  | { type: "status"; payload: { matchId?: string; status: string; detail?: string } }
  | { type: "match"; payload: MatchPayload }
  | { type: "move"; payload: MovePayload }
  | { type: "moveProven"; payload: MoveProvenPayload }
  | { type: "verify"; payload: { matchId: string; anchorDigest: string; hashMatches: boolean; amountMatches: boolean; withinMandate: boolean; blobId: string } }
  | { type: "hand"; payload: HandPayload }
  | { type: "intel"; payload: IntelPayload }
  | { type: "settled"; payload: { matchId: string; tableId: string; winnerOwner: string; amount: number; digest: string } }
  | { type: "bracket"; payload: BracketSnapshot }
  | { type: "solverMatch"; payload: SolverMatchPayload }
  | { type: "solverPuzzles"; payload: SolverPuzzlesPayload }
  | { type: "puzzle"; payload: PuzzlePayload }
  | { type: "answer"; payload: AnswerPayload }
  | {
      type: "answerProven";
      payload: { matchId: string; index: number; seat: string; blobId: string; anchorDigest: string };
    }
  | { type: "puzzleResult"; payload: PuzzleResultPayload }
  | { type: "solverSettled"; payload: SolverSettledPayload };

let wss: WebSocketServer | null = null;

// Buffer of the current match's events, so a client that connects late or refreshes mid-match can
// rebuild the live view (or see the settled result) instead of an empty "waiting" table. Cleared
// when a new match starts, so a reconnect never replays a finished match ahead of the live one.
const MAX_BUFFER = 600;
let recent: string[] = [];

// The bracket outlives the match. A championship plays seven matches, and each one resets the
// buffer above -- so without this, a spectator who joined during the semifinal would be handed a
// live table with no idea it belonged to a tournament. The latest snapshot is kept aside and
// replayed FIRST, so a late arrival gets the bracket, then the match inside it.
let latestBracket: string | null = null;

export function attachWebSocket(server: Server): void {
  wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket: WebSocket) => {
    socket.send(JSON.stringify({ type: "status", payload: { status: "connected" } }));
    // Catch the new client up: the tournament it is in, then the match in progress.
    if (latestBracket && socket.readyState === WebSocket.OPEN) socket.send(latestBracket);
    for (const data of recent) {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    }
  });
}

export function broadcast(message: FeedMessage): void {
  const data = JSON.stringify(message);
  if (message.type === "bracket") {
    latestBracket = data;
    // A completed bracket is the end of the tournament: stop replaying it to the next arrival,
    // or a fresh standalone match would open under a stale podium.
    if (message.payload.status === "complete") {
      // keep it for this broadcast, drop it from future replays once the pool is settled
      setTimeout(() => {
        if (latestBracket === data) latestBracket = null;
      }, 5 * 60_000);
    }
  }
  // A new match resets the replay buffer; everything else appends to it.
  if (message.type === "match" || message.type === "solverMatch") recent = [];
  recent.push(data);
  if (recent.length > MAX_BUFFER) recent.shift();
  if (!wss) return;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}
