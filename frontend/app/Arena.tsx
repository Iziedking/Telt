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
import GameTabs from "./GameTabs";
import { play as sound } from "./sound";
import PlatformBadge from "./PlatformBadge";

type Seat = "A" | "B";

interface SeatView {
  name: string;
  level: number;
  agentId: string;
  platform: boolean;
  chips: number | null;
  lastMove: string;
  lastWhy: string;
  lastSamples: number;
  moves: number;
  recent: string[];
  handsWon: number;
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
  handsPlayed: number;
  moveList: MovePayload[];
  intel: IntelPayload | null;
  settled: SettledPayload | null;
}

const EMPTY_SEAT: SeatView = {
  name: "·",
  level: 0,
  agentId: "",
  platform: false,
  chips: null,
  lastMove: "",
  lastWhy: "",
  lastSamples: 0,
  moves: 0,
  recent: [],
  handsWon: 0,
};

const INITIAL: ViewModel = {
  status: "idle",
  detail: "Waiting for a match.",
  buyin: 0,
  seats: { A: { ...EMPTY_SEAT }, B: { ...EMPTY_SEAT } },
  board: [],
  pot: 0,
  active: null,
  handIndex: 0,
  handsPlayed: 0,
  moveList: [],
  intel: null,
  settled: null,
};

// What each level buys: self-consistency passes (mirrors reason/levels.ts).
const PASSES = [1, 2, 3, 4, 5];
function passesFor(level: number): number {
  return PASSES[Math.min(Math.max(level, 0), 4)] ?? 1;
}

// Telt Foundation ranks: a progression of tell-reading mastery (mirrors skills/poker.ts).
const TIERS = ["Mark", "Reader", "Spotter", "Profiler", "Oracle"];
function tierName(level: number): string {
  return TIERS[Math.min(Math.max(level, 0), 4)] ?? "Mark";
}

interface ArenaContest {
  contestId: string;
  game: string;
  format: string;
  pool: number;
  levelMin: number;
  levelMax: number;
  endsAt: number | null;
  phase: "joining" | "running" | "expired" | "settled";
  difficulty: string | null;
  winnerName?: string;
}

export default function Arena() {
  const [vm, setVm] = useState<ViewModel>(INITIAL);
  const [connected, setConnected] = useState(false);
  const [starting, setStarting] = useState(false);
  const [feedShown, setFeedShown] = useState(8);
  const [selected, setSelected] = useState<MovePayload | null>(null);
  const [verifyState, setVerifyState] = useState<{ loading: boolean; result: MoveVerification | null; error?: string }>({
    loading: false,
    result: null,
  });
  const [contestId, setContestId] = useState<string | null>(null);
  const [contest, setContest] = useState<ArenaContest | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const wsRef = useRef<WebSocket | null>(null);
  const watching = !!contestId;

  // Which contest we arrived to watch (from Run now / Watch live), and its live details.
  useEffect(() => {
    setContestId(new URLSearchParams(window.location.search).get("contest"));
  }, []);
  useEffect(() => {
    if (!contestId) return;
    const load = () =>
      fetch(`${API_BASE}/contests`)
        .then((r) => r.json())
        .then((d) => {
          const open = (d.open ?? []).find((c: ArenaContest) => c.contestId === contestId);
          if (open) return setContest(open);
          // Once settled, a contest moves to history. Show it as settled with the winner.
          const h = (d.history ?? []).find((x: { contestId: string }) => x.contestId === contestId);
          if (h)
            return setContest({
              contestId,
              game: "poker",
              format: "",
              pool: h.prize ?? 0,
              levelMin: 0,
              levelMax: 4,
              endsAt: null,
              phase: "settled",
              difficulty: null,
              winnerName: h.winner,
            });
          setContest(null);
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [contestId]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

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
        // Game audio: a beat per poker move, a clap + celebration (pausing the music) on settle.
        if (msg.type === "move") sound("poker");
        else if (msg.type === "settled") sound("win", { pauseMusic: true });
        setVm((prev) => reduce(prev, msg));
      };
    }
    connect();
    return () => {
      closed = true;
      wsRef.current?.close();
    };
  }, []);

  // Once a match settles, show the result for a beat, then return to the idle "Run a match"
  // state so the Arena is ready for the next one instead of staying stuck on the finished
  // match. A new match arriving in the meantime clears `settled` and cancels the reset.
  useEffect(() => {
    if (!vm.settled) return;
    const id = setTimeout(() => setVm((prev) => (prev.settled ? INITIAL : prev)), 12000);
    return () => clearTimeout(id);
  }, [vm.settled]);

  const runMatch = useCallback(async () => {
    setStarting(true);
    setVm(INITIAL);
    setSelected(null);
    setVerifyState({ loading: false, result: null });
    try {
      await fetch(`${API_BASE}/match`, { method: "POST" });
    } catch {
      /* backend may be down; the status tile stays idle */
    } finally {
      setTimeout(() => setStarting(false), 2000);
    }
  }, []);

  // Run the contest being watched now (closes its window and plays it). Used when a contest
  // is still joining, or is a stale orphan whose window was lost on a restart.
  const runThisContest = useCallback(() => {
    if (!contest) return;
    setStarting(true);
    fetch(`${API_BASE}/contests/${contest.contestId}/run`, { method: "POST" })
      .catch(() => {})
      .finally(() => setTimeout(() => setStarting(false), 2500));
  }, [contest]);

  const selectMove = useCallback(async (m: MovePayload) => {
    setSelected(m);
    if (!m.blobId || !m.agentId) {
      setVerifyState({ loading: false, result: null, error: "This move was not anchored." });
      return;
    }
    setVerifyState({ loading: true, result: null });
    try {
      const mandateQ = m.mandateId ? `&mandate=${encodeURIComponent(m.mandateId)}` : "";
      const r = await fetch(`${API_BASE}/verify/agent/${m.agentId}?blob=${encodeURIComponent(m.blobId)}${mandateQ}`);
      if (!r.ok) throw new Error(`verify failed (${r.status})`);
      setVerifyState({ loading: false, result: (await r.json()) as MoveVerification });
    } catch (err) {
      setVerifyState({ loading: false, result: null, error: (err as Error).message });
    }
  }, []);

  const A = vm.seats.A;
  const B = vm.seats.B;
  const live = vm.status !== "idle" && !vm.settled;
  const leader = (A.chips ?? 0) === (B.chips ?? 0) ? null : (A.chips ?? 0) > (B.chips ?? 0) ? "A" : "B";
  const ctEndsAt = contest?.endsAt ?? null;
  const ctCountdown =
    contest && contest.phase === "joining" && ctEndsAt
      ? (() => {
          const s = Math.max(0, Math.floor((ctEndsAt - now) / 1000));
          return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
        })()
      : null;

  return (
    <div className="page">
      <GameTabs />
      <header className="hero-section">
        <div className="hero-text">
          <div className="kicker-row">
            <span className="kicker-sq" />
            <span className="kicker-label">{live ? "Live · heads-up poker" : "Heads-up poker · the main event"}</span>
          </div>
          <h1 className="display-heading">
            {live ? (
              <>
                {A.name} vs {B.name}
              </>
            ) : (
              <>
                The tell, proven
              </>
            )}
          </h1>
          <p className="hero-sub">
            Every move and the reasoning behind it is sealed on <b>Walrus</b> and stamped on <b>Sui</b>, replayable and
            provable through <b>Avow</b>.
          </p>
        </div>
        <div className="hero-aside">
          <span className="chip">
            <span className={`sdot ${connected ? "" : "off"}`} />
            {connected ? "live feed" : "offline"}
          </span>
          {watching ? (
            contest ? (
              <>
                <span className="ct-watch-banner">
                  <span className="ct-badge s1">{contest.game}</span>
                  {contest.format && <span className="ct-kind">{contest.format}</span>}
                  {contest.difficulty && (
                    <span className={`ct-diff ${contest.difficulty.toLowerCase()}`}>{contest.difficulty}</span>
                  )}
                  · pool {contest.pool} tUSDC · L{contest.levelMin}-{contest.levelMax}
                  {ctCountdown ? (
                    <span className="ct-countdown">starts in {ctCountdown}</span>
                  ) : contest.phase === "settled" ? (
                    <span className="ct-running settled">settled{contest.winnerName ? ` · ${contest.winnerName} won` : ""}</span>
                  ) : contest.phase === "expired" ? (
                    <span className="ct-running expired">expired</span>
                  ) : (
                    <span className="ct-running">live</span>
                  )}
                </span>
                {!live && contest.phase !== "running" && contest.phase !== "settled" && (
                  <button className="hero-cta ct-run-now" onClick={runThisContest} disabled={starting}>
                    {starting ? "Starting…" : "Run now"}
                  </button>
                )}
              </>
            ) : (
              <span className="chip">loading the contest…</span>
            )
          ) : (
            <button
              className="hero-cta"
              onClick={() => runMatch()}
              disabled={starting || live}
              data-tip="Watch two platform agents demo a live heads-up match. To play, open a contest."
            >
              {live ? "Match running" : starting ? "Starting…" : "Run a match"}
            </button>
          )}
        </div>
      </header>

      {watching && contest && ctCountdown && (
        <div className="ct-countdown-bar">
          <span className="ct-cd-label">Join window closes in</span>
          <span className="ct-cd-time">{ctCountdown}</span>
          <button className="ct-cd-run" onClick={runThisContest} disabled={starting}>
            {starting ? "Starting…" : "Run now"}
          </button>
        </div>
      )}

      <main className="arena">
        <div className="bento" id="arena">
          {/* Sand hero panel */}
          <div className="tile sand hero">
            <div>
              <div className="kicker">Arena</div>
              <div className="round">
                Hand {live ? vm.handIndex + 1 : vm.handsPlayed} ·{" "}
                {watching && contest ? `pool ${contest.pool} tUSDC` : `buy-in ${fmtSui(vm.buyin)}`} · {vm.handsPlayed}{" "}
                played
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
            <div className="agent-foot" style={{ marginTop: 8 }}>
              <Stat k="A hands won" v={A.handsWon} />
              <Stat k="B hands won" v={B.handsWon} />
              <Stat k="leader" v={leader ? vm.seats[leader].name : "·"} />
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
          <div className="tile felt table" id="table">
            <div className="kicker">Live table</div>
            <div className="board">
              {vm.board.length === 0 ? (
                <span className="muted">{live ? "pre-flop" : "no hand in play"}</span>
              ) : (
                vm.board.map((c, i) => <Card key={c + i} c={c} />)
              )}
            </div>
            <div className="potpill">pot {vm.pot}</div>
            <div className="seatrow">
              <SeatBox seat="A" view={A} active={vm.active === "A"} live={live} />
              <SeatBox seat="B" view={B} active={vm.active === "B"} live={live} />
            </div>
          </div>
        </div>

        {/* Agent A, Agent B, Intel */}
        <div className="row3" id="intel">
          <AgentTile tone="felt" seat="A" view={A} />
          <AgentTile tone="peri" seat="B" view={B} />

          <div className="tile signal">
            <div className="kicker">Intel</div>
            {vm.intel ? (
              <>
                <strong>
                  {seatName(vm, vm.intel.buyerSeat as Seat)} bought a dossier · {fmtSui(vm.intel.amount)}
                </strong>
                <div className="intel-summary">{stripMd(vm.intel.summary)}</div>
                {/* The x402 micropayment, on Sui: the proof that the intel was paid for, made
                    prominent because it is the whole point. */}
                <a
                  className="x402-proof"
                  href={suiscan(vm.intel.payDigest)}
                  target="_blank"
                  rel="noreferrer"
                  title="The x402 micropayment for this dossier, settled on Sui"
                >
                  <span className="x402-tag">x402 · paid on Sui</span>
                  <span className="x402-digest mono">{short(vm.intel.payDigest)} ↗</span>
                </a>
                {vm.intel.dossierDigest && (
                  <a
                    className="x402-proof alt"
                    href={suiscan(vm.intel.dossierDigest)}
                    target="_blank"
                    rel="noreferrer"
                    title="The dossier delivery, anchored on Sui"
                  >
                    <span className="x402-tag">dossier anchored</span>
                    <span className="x402-digest mono">{short(vm.intel.dossierDigest)} ↗</span>
                  </a>
                )}
              </>
            ) : (
              <>
                <div style={{ marginTop: 4 }}>
                  <IntelCoin />
                </div>
                <div className="intel-summary" style={{ maxHeight: "none" }}>
                  The trailing agent can buy a dossier on its opponent, compiled from real anchored records and paid
                  x402-style on Sui. The dossier loads into its next decisions. The money shot lands here.
                </div>
              </>
            )}
          </div>
        </div>

        {/* Verify reveal + feed */}
        <div className="row2" id="verify">
          <div className="tile sky">
            <div className="kicker">Verify reveal</div>
            {!selected ? (
              <div className="verify-empty">
                Click any move in the feed to verify it: evidence unaltered, amount reconciles, within mandate. The
                Walrus blob id and Sui tx digest appear in mono underneath.
              </div>
            ) : (
              <VerifyPanel move={selected} state={verifyState} />
            )}
          </div>

          <div className="tile canvas" id="feed">
            <div className="kicker">Feed · newest first</div>
            <div className="feed">
              {vm.intel && (
                <div className="move intel-feed">
                  <div className="head">
                    <span className="who">{seatName(vm, vm.intel.buyerSeat as Seat)}</span>
                    <span className="act">bought intel · {fmtSui(vm.intel.amount)}</span>
                  </div>
                  <div className="why">{stripMd(vm.intel.summary)}</div>
                  <a
                    className="badge x402"
                    href={suiscan(vm.intel.payDigest)}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    title="The x402 micropayment for this dossier, on Sui"
                  >
                    <span className="b-dot" /> x402 paid · {short(vm.intel.payDigest)}
                  </a>
                </div>
              )}
              {vm.moveList.length === 0 && !vm.intel && <div className="muted-small">No moves yet. Run a match.</div>}
              {[...vm.moveList]
                .reverse()
                .slice(0, feedShown)
                .map((m, i) => (
                  <div
                    key={m.moveKey ?? m.anchorDigest ?? i}
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
                      <a
                        className="badge"
                        style={{ marginTop: 6 }}
                        href={suiscan(m.anchorDigest)}
                        target="_blank"
                        rel="noreferrer"
                        title="View the anchor transaction on Suiscan"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span className="b-dot" /> anchored on Walrus
                      </a>
                    )}
                  </div>
                ))}
              {vm.moveList.length > feedShown && (
                <button className="show-more" onClick={() => setFeedShown((n) => n + 8)}>
                  Show more ({vm.moveList.length - feedShown})
                </button>
              )}
            </div>
          </div>
        </div>
      </main>

      {vm.settled && (
        <div className="footnote">
          Settled on chain. Payout {fmtSui(vm.settled.amount)} ·{" "}
          <a className="mono" href={suiscan(vm.settled.digest)} target="_blank" rel="noreferrer">
            {short(vm.settled.digest)}
          </a>
        </div>
      )}
    </div>
  );
}

function AgentTile({ tone, seat, view }: { tone: "felt" | "peri"; seat: Seat; view: SeatView }) {
  const passes = passesFor(view.level);
  return (
    <div className={`tile ${tone} agent`}>
      <div className="agent-head">
        <span className="avatar">
          <ChipFace fill={tone === "felt" ? "#A8E0C2" : "#C7C9F2"} />
        </span>
        <div>
          <div className="agent-name">
            {view.name}
            {view.platform && <PlatformBadge small />}
          </div>
          <div className="agent-perk">
            {tierName(view.level)} · level {view.level}
          </div>
        </div>
      </div>

      <div className="agent-chips">
        <span className="n">{view.chips ?? "·"}</span>
        <span className="muted-small">chips</span>
      </div>

      <div className="passes">
        <span className="label">reasoning</span>
        {Array.from({ length: 5 }).map((_, i) => (
          <span key={i} className={`pass-dot ${i < passes ? "on" : ""}`} />
        ))}
        <span className="muted-small" style={{ marginLeft: 4 }}>
          {passes} {passes === 1 ? "pass" : "passes"}
        </span>
      </div>

      <div>
        <div className="agent-last">{view.lastMove || "no move yet"}</div>
        <div className="agent-why">{view.lastWhy}</div>
      </div>

      {view.recent.length > 0 && (
        <div className="recent">
          {view.recent.map((a, i) => (
            <span key={i} className="pill">
              {a}
            </span>
          ))}
        </div>
      )}

      <div className="agent-foot">
        <Stat k="moves" v={view.moves} />
        <Stat k="hands won" v={view.handsWon} />
        <Stat k="last passes" v={view.lastSamples || "·"} />
      </div>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string | number }) {
  return (
    <div className="stat">
      <div className="v">{v}</div>
      <div className="k">{k}</div>
    </div>
  );
}

function SeatBox({ seat, view, active, live }: { seat: Seat; view: SeatView; active: boolean; live: boolean }) {
  return (
    <div className={`seat ${active ? "active" : ""}`}>
      {live && (
        <div className="holes">
          <span className="cardback" />
          <span className="cardback" />
        </div>
      )}
      <div className="name">{view.name}</div>
      <div className="lvl">
        Seat {seat} · {tierName(view.level)} L{view.level}
      </div>
      <div className="chips">{view.chips ?? "·"}</div>
      <div className="last">{view.lastMove}</div>
    </div>
  );
}

function VerifyPanel({
  move,
  state,
}: {
  move: MovePayload;
  state: { loading: boolean; result: MoveVerification | null; error?: string };
}) {
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
        <span className="val mono">{r?.blobId ?? move.blobId ?? "·"}</span>
      </div>
      <div className="idline">
        <span className="label">Evidence hash</span>
        <span className="val mono">{move.evidenceHash ?? "·"}</span>
      </div>
      <div className="idline">
        <span className="label">Sui tx digest</span>
        <span className="val mono">
          {r?.txDigest ? (
            <a href={suiscan(r.txDigest)} target="_blank" rel="noreferrer">
              {r.txDigest}
            </a>
          ) : move.anchorDigest ? (
            <a href={suiscan(move.anchorDigest)} target="_blank" rel="noreferrer">
              {move.anchorDigest}
            </a>
          ) : (
            "·"
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

// A small cartoon chip-character: the chip says poker, the check says provable.
function ChipFace({ fill }: { fill: string }) {
  return (
    <svg viewBox="0 0 64 64" width="46" height="46" aria-hidden>
      <circle cx="32" cy="32" r="29" fill={fill} stroke="#14181F" strokeWidth="3" strokeDasharray="7 5" />
      <circle cx="32" cy="32" r="21" fill={fill} stroke="#14181F" strokeWidth="2" />
      <circle cx="26" cy="29" r="2.6" fill="#14181F" />
      <circle cx="38" cy="29" r="2.6" fill="#14181F" />
      <path d="M25 37 l5 5 l10 -11" fill="none" stroke="#c4241c" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IntelCoin() {
  return (
    <svg viewBox="0 0 64 64" width="40" height="40" aria-hidden>
      <circle cx="32" cy="32" r="28" fill="#fff" stroke="#14181F" strokeWidth="3" />
      <text x="32" y="42" textAnchor="middle" fontSize="30" fontWeight="800" fill="#c4241c" fontFamily="var(--font-display)">
        ?
      </text>
    </svg>
  );
}

// --- reducer ---

function reduce(prev: ViewModel, msg: FeedMessage): ViewModel {
  switch (msg.type) {
    case "status": {
      const status = msg.payload.status === "connected" ? "idle" : msg.payload.status;
      return { ...prev, status, detail: msg.payload.detail ?? prev.detail };
    }
    case "match": {
      const seats = { A: { ...EMPTY_SEAT }, B: { ...EMPTY_SEAT } };
      for (const a of msg.payload.agents) {
        const s = a.seat as Seat;
        seats[s] = { ...EMPTY_SEAT, name: a.name, level: a.level, agentId: a.agentId, platform: !!a.platform };
      }
      return { ...INITIAL, status: "seated", buyin: msg.payload.buyin, seats };
    }
    case "move": {
      const p = msg.payload;
      const seat = p.seat as Seat;
      const cur = prev.seats[seat];
      const seats = { ...prev.seats };
      seats[seat] = {
        ...cur,
        name: p.agentName,
        level: p.level,
        agentId: p.agentId,
        lastMove: `${p.action}${p.size ? " " + p.size : ""} on the ${p.street}`,
        lastWhy: p.rationale,
        lastSamples: p.samples,
        moves: cur.moves + 1,
        recent: [...cur.recent, p.action].slice(-5),
      };
      return {
        ...prev,
        status: "playing",
        board: p.board,
        pot: p.pot,
        active: seat,
        handIndex: p.handIndex,
        seats,
        moveList: [...prev.moveList, p].slice(-80),
      };
    }
    case "moveProven": {
      // A move's proof landed after it was shown live: fill in its anchor so the verify
      // badge lights up.
      const p = msg.payload;
      return {
        ...prev,
        moveList: prev.moveList.map((m) =>
          m.moveKey === p.moveKey
            ? { ...m, blobId: p.blobId, evidenceHash: p.evidenceHash, anchorDigest: p.anchorDigest, withinMandate: true, mandateId: p.mandateId ?? m.mandateId }
            : m,
        ),
      };
    }
    case "hand": {
      const seats = { ...prev.seats };
      seats.A = { ...seats.A, chips: msg.payload.stacks.A ?? seats.A.chips };
      seats.B = { ...seats.B, chips: msg.payload.stacks.B ?? seats.B.chips };
      const w = msg.payload.winnerSeat;
      if (w === "A" || w === "B") seats[w] = { ...seats[w], handsWon: seats[w].handsWon + 1 };
      return { ...prev, board: msg.payload.board, active: null, handsPlayed: prev.handsPlayed + 1, seats };
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
