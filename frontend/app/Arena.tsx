"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  API_BASE,
  WS_URL,
  type FeedMessage,
  type MovePayload,
  type IntelPayload,
  type SettledPayload,
  type MoveVerification,
} from "./feed";

type Seat = "A" | "B";

interface SeatView {
  name: string;
  level: number;
  agentId: string;
  chips: number | null;
  lastMove: string;
}

interface ViewModel {
  status: string;
  detail: string;
  buyin: number;
  seats: Record<Seat, SeatView>;
  board: string[];
  pot: number;
  active: Seat | null;
  handIndex: number;
  moves: MovePayload[];
  intel: IntelPayload | null;
  settled: SettledPayload | null;
}

const EMPTY_SEAT: SeatView = { name: "—", level: 0, agentId: "", chips: null, lastMove: "" };

const INITIAL: ViewModel = {
  status: "idle",
  detail: "Waiting for a match.",
  buyin: 0,
  seats: { A: { ...EMPTY_SEAT }, B: { ...EMPTY_SEAT } },
  board: [],
  pot: 0,
  active: null,
  handIndex: 0,
  moves: [],
  intel: null,
  settled: null,
};

export default function Arena() {
  const [vm, setVm] = useState<ViewModel>(INITIAL);
  const [connected, setConnected] = useState(false);
  const [starting, setStarting] = useState(false);
  const [selected, setSelected] = useState<MovePayload | null>(null);
  const [verifyState, setVerifyState] = useState<{ loading: boolean; result: MoveVerification | null; error?: string }>({
    loading: false,
    result: null,
  });
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    function connect() {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) setTimeout(connect, 1500);
      };
      ws.onmessage = (e) => {
        let msg: FeedMessage;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        setVm((prev) => reduce(prev, msg));
      };
    }
    connect();
    return () => {
      closed = true;
      wsRef.current?.close();
    };
  }, []);

  const runMatch = useCallback(async () => {
    setStarting(true);
    setVm(INITIAL);
    setSelected(null);
    setVerifyState({ loading: false, result: null });
    try {
      await fetch(`${API_BASE}/match`, { method: "POST" });
    } catch {
      // The backend may not be up; the status tile shows the idle state.
    } finally {
      setTimeout(() => setStarting(false), 2000);
    }
  }, []);

  const selectMove = useCallback(async (m: MovePayload) => {
    setSelected(m);
    if (!m.blobId || !m.agentId) {
      setVerifyState({ loading: false, result: null, error: "This move was not anchored." });
      return;
    }
    setVerifyState({ loading: true, result: null });
    try {
      const r = await fetch(`${API_BASE}/verify/agent/${m.agentId}?blob=${encodeURIComponent(m.blobId)}`);
      if (!r.ok) throw new Error(`verify failed (${r.status})`);
      const result = (await r.json()) as MoveVerification;
      setVerifyState({ loading: false, result });
    } catch (err) {
      setVerifyState({ loading: false, result: null, error: (err as Error).message });
    }
  }, []);

  const A = vm.seats.A;
  const B = vm.seats.B;
  const live = vm.status !== "idle" && !vm.settled;

  return (
    <div className="shell">
      <div className="topbar">
        <div>
          <div className="brand">
            tel<span className="tick">t</span>
          </div>
          <div className="tagline">
            Heads-up poker between AI agents on Sui. Every move and the reasoning behind it is sealed on Walrus and
            stamped on chain, replayable and provable through Avow.
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span className="muted-small">{connected ? "feed connected" : "feed offline"}</span>
          <button className="btn" onClick={runMatch} disabled={starting || live}>
            {live ? "match running" : starting ? "starting…" : "Run a match"}
          </button>
        </div>
      </div>

      <div className="frame">
        <div className="bento">
          {/* Sand hero panel */}
          <div className="tile sand hero">
            <div>
              <div className="kicker">Arena</div>
              <div className="round">
                Hand {vm.handIndex + (live ? 1 : 0)} · buy-in {fmtSui(vm.buyin)}
              </div>
              <div className="potline">
                <span className="big">{vm.pot}</span>
                <span className="muted-small">chips in the pot</span>
              </div>
            </div>
            <div className="versus">
              <span className="chip-dot dot-felt" /> <strong>{A.name}</strong> L{A.level}
              <span style={{ margin: "0 6px", color: "#6a737d" }}>vs</span>
              <span className="chip-dot dot-peri" /> <strong>{B.name}</strong> L{B.level}
            </div>
            <div>
              {live ? (
                <span className="live">
                  <span className="pulse" /> LIVE · {vm.status}
                </span>
              ) : (
                <span className="muted-small">{vm.settled ? "settled" : vm.detail}</span>
              )}
            </div>
          </div>

          {/* Felt live table, the hero */}
          <div className="tile felt table">
            <div className="kicker">Live table</div>
            <div className="board">
              {vm.board.length === 0 ? (
                <span className="muted">pre-flop</span>
              ) : (
                vm.board.map((c, i) => <Card key={c + i} c={c} />)
              )}
            </div>
            <div className="potpill">pot {vm.pot}</div>
            <div className="seatrow">
              <SeatBox seat="A" view={A} active={vm.active === "A"} />
              <SeatBox seat="B" view={B} active={vm.active === "B"} />
            </div>
          </div>
        </div>

        {/* Agent A, Agent B, Intel */}
        <div className="row3">
          <div className="tile felt">
            <div className="kicker">Agent A · level {A.level}</div>
            <div className="big">{A.chips ?? "—"}</div>
            <div className="muted-small">{A.name}</div>
            <div className="muted-small" style={{ marginTop: 8 }}>
              {A.lastMove || "no move yet"}
            </div>
          </div>

          <div className="tile peri">
            <div className="kicker">Agent B · level {B.level}</div>
            <div className="big">{B.chips ?? "—"}</div>
            <div className="muted-small">{B.name}</div>
            <div className="muted-small" style={{ marginTop: 8 }}>
              {B.lastMove || "no move yet"}
            </div>
          </div>

          <div className="tile signal">
            <div className="kicker">Intel</div>
            {vm.intel ? (
              <>
                <strong>
                  {seatName(vm, vm.intel.buyerSeat as Seat)} bought a dossier · {fmtSui(vm.intel.amount)}
                </strong>
                <div className="intel-summary">{stripMd(vm.intel.summary)}</div>
                <div className="intel-meta mono">pay {short(vm.intel.payDigest)}</div>
              </>
            ) : (
              <div className="intel-summary">
                The trailing agent can buy a dossier on its opponent, compiled from real anchored records, paid x402-style
                on Sui. The money shot lands here.
              </div>
            )}
          </div>
        </div>

        {/* Verify reveal + feed */}
        <div className="row2">
          <div className="tile sky">
            <div className="kicker">Verify reveal</div>
            {!selected ? (
              <div className="verify-empty">Click any move in the feed to verify it: evidence unaltered, amount reconciles, within mandate.</div>
            ) : (
              <VerifyPanel move={selected} state={verifyState} />
            )}
          </div>

          <div className="tile canvas">
            <div className="kicker">Feed · newest first</div>
            <div className="feed">
              {vm.moves.length === 0 && <div className="muted-small">No moves yet. Run a match.</div>}
              {[...vm.moves].reverse().map((m, i) => (
                <div
                  key={m.anchorDigest ?? m.blobId ?? i}
                  className={`move ${selected === m ? "selected" : ""}`}
                  onClick={() => selectMove(m)}
                >
                  <div className="head">
                    <span className="who">{m.agentName}</span>
                    <span className="act">
                      {m.action}
                      {m.size ? ` ${m.size}` : ""}
                    </span>
                  </div>
                  <div className="why">{m.rationale}</div>
                  {m.anchorDigest && (
                    <div className="badge" style={{ marginTop: 6 }}>
                      <span className="b-dot" /> anchored on Walrus
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {vm.settled && (
        <div style={{ marginTop: 20, textAlign: "center" }} className="muted-small">
          Settled on chain. Payout {fmtSui(vm.settled.amount)} ·{" "}
          <a className="mono" href={suiscan(vm.settled.digest)} target="_blank" rel="noreferrer">
            {short(vm.settled.digest)}
          </a>
        </div>
      )}
    </div>
  );
}

function SeatBox({ seat, view, active }: { seat: Seat; view: SeatView; active: boolean }) {
  return (
    <div className={`seat ${active ? "active" : ""}`}>
      <div className="name">{view.name}</div>
      <div className="lvl">
        Seat {seat} · level {view.level}
      </div>
      <div className="chips">{view.chips ?? "—"}</div>
      <div className="last">{view.lastMove}</div>
    </div>
  );
}

function VerifyPanel({ move, state }: { move: MovePayload; state: { loading: boolean; result: MoveVerification | null; error?: string } }) {
  const r = state.result;
  return (
    <div>
      <div className="muted-small" style={{ marginBottom: 6 }}>
        {move.agentName} · {move.action}
        {move.size ? ` ${move.size}` : ""} on the {move.street}
      </div>
      <div className="checks">
        <CheckRow label="Evidence unaltered" ok={r?.hashMatches} loading={state.loading} />
        <CheckRow label="Amount reconciles" ok={r?.amountMatches} loading={state.loading} />
        <CheckRow label="Within mandate" ok={r?.withinMandate} loading={state.loading} />
      </div>
      {state.error && <div className="muted-small" style={{ color: "#9a2b22" }}>{state.error}</div>}
      <div className="idline">
        <span className="label">Walrus blob</span>
        <span className="val mono">{r?.blobId ?? move.blobId ?? "—"}</span>
      </div>
      <div className="idline">
        <span className="label">Evidence hash</span>
        <span className="val mono">{move.evidenceHash ?? "—"}</span>
      </div>
      <div className="idline">
        <span className="label">Sui tx digest</span>
        <span className="val mono">
          {r?.txDigest ? (
            <a href={suiscan(r.txDigest)} target="_blank" rel="noreferrer">
              {r.txDigest}
            </a>
          ) : (
            move.anchorDigest ?? "—"
          )}
        </span>
      </div>
    </div>
  );
}

function CheckRow({ label, ok, loading }: { label: string; ok?: boolean; loading: boolean }) {
  const cls = loading ? "pending" : ok ? "" : "no";
  const glyph = loading ? "…" : ok ? "✓" : "✕";
  return (
    <div className="check">
      <span className={`mark ${cls}`}>{glyph}</span>
      <span>{label}</span>
    </div>
  );
}

function Card({ c }: { c: string }) {
  const rank = c.slice(0, -1);
  const suit = c.slice(-1);
  const red = suit === "h" || suit === "d";
  const sym = ({ s: "♠", h: "♥", d: "♦", c: "♣" } as Record<string, string>)[suit] ?? suit;
  return (
    <span className={`card ${red ? "red" : ""}`}>
      {rank}
      {sym}
    </span>
  );
}

// --- reducer ---

function reduce(prev: ViewModel, msg: FeedMessage): ViewModel {
  switch (msg.type) {
    case "status": {
      // The socket sends a "connected" status on open; that is not a live match.
      const status = msg.payload.status === "connected" ? "idle" : msg.payload.status;
      return { ...prev, status, detail: msg.payload.detail ?? prev.detail };
    }
    case "match": {
      const seats = { A: { ...EMPTY_SEAT }, B: { ...EMPTY_SEAT } };
      for (const a of msg.payload.agents) {
        const s = a.seat as Seat;
        seats[s] = { name: a.name, level: a.level, agentId: a.agentId, chips: null, lastMove: "" };
      }
      return { ...INITIAL, status: "seated", buyin: msg.payload.buyin, seats };
    }
    case "move": {
      const p = msg.payload;
      const seat = p.seat as Seat;
      const seats = { ...prev.seats };
      seats[seat] = {
        ...seats[seat],
        name: p.agentName,
        level: p.level,
        agentId: p.agentId,
        lastMove: `${p.action}${p.size ? " " + p.size : ""} on the ${p.street}`,
      };
      return {
        ...prev,
        status: "playing",
        board: p.board,
        pot: p.pot,
        active: seat,
        handIndex: p.handIndex,
        seats,
        moves: [...prev.moves, p].slice(-60),
      };
    }
    case "hand": {
      const seats = { ...prev.seats };
      seats.A = { ...seats.A, chips: msg.payload.stacks.A ?? seats.A.chips };
      seats.B = { ...seats.B, chips: msg.payload.stacks.B ?? seats.B.chips };
      return { ...prev, board: msg.payload.board, active: null, seats };
    }
    case "intel":
      return { ...prev, intel: msg.payload };
    case "settled":
      return { ...prev, status: "settled", settled: msg.payload, active: null };
    default:
      return prev;
  }
}

// --- helpers ---

function seatName(vm: ViewModel, seat: Seat): string {
  return vm.seats[seat]?.name ?? `Agent ${seat}`;
}
function fmtSui(mist: number): string {
  return `${(mist / 1e9).toFixed(3).replace(/\.?0+$/, "")} SUI`;
}
function short(s: string): string {
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}
function stripMd(s: string): string {
  return s.replace(/\*\*/g, "");
}
function suiscan(digest: string): string {
  return `https://suiscan.xyz/testnet/tx/${digest}`;
}
