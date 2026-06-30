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

export function attachWebSocket(server: Server): void {
  wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket: WebSocket) => {
    socket.send(JSON.stringify({ type: "status", payload: { status: "connected" } }));
    // Catch the new client up on the match in progress (or the last one's result).
    for (const data of recent) {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    }
  });
}

export function broadcast(message: FeedMessage): void {
  const data = JSON.stringify(message);
  // A new match resets the replay buffer; everything else appends to it.
  if (message.type === "match" || message.type === "solverMatch") recent = [];
  recent.push(data);
  if (recent.length > MAX_BUFFER) recent.shift();
  if (!wss) return;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}
