// The feed message shapes, mirrored from the backend (coordinator/ws.ts). The arena
// reads these off the /ws socket and renders them live.

export interface MatchPayload {
  matchId: string;
  tableId: string;
  buyin: number;
  agents: { seat: string; name: string; level: number; agentId: string; platform?: boolean }[];
}

export interface MovePayload {
  matchId: string;
  tableId: string;
  handIndex: number;
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
  blobId: string | null;
  evidenceHash: string | null;
  anchorDigest: string | null;
  withinMandate: boolean | null;
}

export interface HandPayload {
  matchId: string;
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

export interface SettledPayload {
  matchId: string;
  tableId: string;
  winnerOwner: string;
  amount: number;
  digest: string;
}

// --- Solver feed (the quiz game) ---
export interface SolverMatchPayload {
  matchId: string;
  puzzleCount: number;
  webGrounded: boolean;
  agents: { seat: string; name: string; level: number; agentId: string; platform?: boolean }[];
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
}

export type FeedMessage =
  | { type: "status"; payload: { matchId?: string; status: string; detail?: string } }
  | { type: "match"; payload: MatchPayload }
  | { type: "move"; payload: MovePayload }
  | { type: "verify"; payload: { matchId: string; hashMatches: boolean; amountMatches: boolean; withinMandate: boolean } }
  | { type: "hand"; payload: HandPayload }
  | { type: "intel"; payload: IntelPayload }
  | { type: "settled"; payload: SettledPayload }
  | { type: "solverMatch"; payload: SolverMatchPayload }
  | { type: "puzzle"; payload: PuzzlePayload }
  | { type: "answer"; payload: AnswerPayload }
  | { type: "puzzleResult"; payload: PuzzleResultPayload }
  | { type: "solverSettled"; payload: SolverSettledPayload };

export interface MoveVerification {
  hashMatches: boolean;
  amountMatches: boolean;
  withinMandate: boolean;
  blobId: string;
  txDigest: string | null;
}

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8787";
export const WS_URL = (process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8787").replace(/^http/, "ws") + "/ws";

// Turn a raw wallet or chain error into something a person can act on. Falls back to a
// trimmed version of the original message.
export function prettyError(e: unknown): string {
  const raw = String((e as { message?: string })?.message ?? e ?? "");
  const m = raw.toLowerCase();
  if (/reject|denied|cancel|user.*declin/.test(m)) return "You cancelled the request.";
  if (/insufficient|no valid gas|gas|balance/.test(m)) return "Not enough SUI for gas. Top up and try again.";
  if (/name.*taken|taken.*name|enametaken/.test(m)) return "That name is taken. Pick another.";
  if (/already.*join|ealreadyjoined/.test(m)) return "That agent has already joined this contest.";
  if (/full|efull/.test(m)) return "This contest is already full.";
  if (/badlevel|level.*band|ebadlevel/.test(m)) return "Your agent's tier is outside this contest's band.";
  if (/notregistered|not.*register|enotregistered/.test(m)) return "Register your agent for the arena first.";
  if (/underpaid|eunderpaid/.test(m)) return "Not enough tUSDC for the entry. Claim from the faucet.";
  if (/fetch failed|network|timeout|econn/.test(m)) return "Network hiccup. Give it a moment and retry.";
  return raw ? raw.slice(0, 120) : "Something went wrong.";
}
