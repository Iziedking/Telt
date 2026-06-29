"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  API_BASE,
  WS_URL,
  type FeedMessage,
  type SolverMatchPayload,
  type SolverQuestion,
  type AnswerPayload,
  type PuzzleResultPayload,
  type SolverSettledPayload,
} from "./feed";
import GameTabs from "./GameTabs";
import PlatformBadge from "./PlatformBadge";

const TIERS = ["Mark", "Reader", "Spotter", "Profiler", "Oracle"];
const tierName = (l: number) => TIERS[Math.min(Math.max(l, 0), 4)] ?? "Mark";
const PER_PAGE = 5;

// Per-agent row helpers for the quiz cards.
const letterFor = (n: number) => String.fromCharCode(65 + n);
const handleFor = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
const initialFor = (name: string) => (name.trim()[0] ?? "?").toUpperCase();
const AVATAR_COLORS = ["#c4241c", "#1f7a4d", "#5b54d6", "#c77d1a", "#2a7ab0", "#a23a8e"];
const avatarColor = (name: string) =>
  AVATAR_COLORS[[...name].reduce((s, c) => s + c.charCodeAt(0), 0) % AVATAR_COLORS.length];

interface ContestInfo {
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

interface SolverVM {
  status: string;
  agents: SolverMatchPayload["agents"];
  scores: Record<string, number>;
  total: number;
  secondsPerQuestion: number;
  webGrounded: boolean;
  questions: SolverQuestion[];
  currentIndex: number;
  askedAt: Record<number, number>; // [index] -> when the question went live, for response timing
  answers: Record<number, Record<string, AnswerPayload & { answeredAt: number }>>; // [index][seat]
  results: Record<number, PuzzleResultPayload>; // [index]
  settled: SolverSettledPayload | null;
}

const INITIAL: SolverVM = {
  status: "Waiting for a match.",
  agents: [],
  scores: {},
  total: 0,
  secondsPerQuestion: 20,
  webGrounded: false,
  questions: [],
  currentIndex: -1,
  askedAt: {},
  answers: {},
  results: {},
  settled: null,
};

function reduce(vm: SolverVM, msg: FeedMessage): SolverVM {
  switch (msg.type) {
    case "solverMatch": {
      const p = msg.payload;
      const scores: Record<string, number> = {};
      p.agents.forEach((a) => (scores[a.seat] = 0));
      return {
        ...INITIAL,
        status: p.agents.map((a) => a.name).join("  vs  "),
        agents: p.agents,
        scores,
        total: p.puzzleCount,
        secondsPerQuestion: p.secondsPerQuestion ?? 20,
        webGrounded: p.webGrounded,
      };
    }
    case "solverPuzzles":
      return { ...vm, questions: msg.payload.puzzles };
    case "puzzle":
      return {
        ...vm,
        currentIndex: msg.payload.index,
        askedAt: { ...vm.askedAt, [msg.payload.index]: Date.now() },
        status: `Question ${msg.payload.index + 1} of ${msg.payload.total}`,
      };
    case "answer": {
      const a = msg.payload;
      return {
        ...vm,
        answers: { ...vm.answers, [a.index]: { ...(vm.answers[a.index] ?? {}), [a.seat]: { ...a, answeredAt: Date.now() } } },
      };
    }
    case "answerProven": {
      const p = msg.payload;
      const row = vm.answers[p.index];
      const prev = row?.[p.seat];
      if (!prev) return vm;
      return {
        ...vm,
        answers: {
          ...vm.answers,
          [p.index]: { ...row, [p.seat]: { ...prev, blobId: p.blobId, anchorDigest: p.anchorDigest, withinMandate: true } },
        },
      };
    }
    case "puzzleResult":
      return { ...vm, results: { ...vm.results, [msg.payload.index]: msg.payload }, scores: msg.payload.scores };
    case "solverSettled":
      return { ...vm, settled: msg.payload, status: `${msg.payload.winnerName} wins` };
    default:
      return vm;
  }
}

export default function Solver() {
  const [vm, setVm] = useState<SolverVM>(INITIAL);
  const [connected, setConnected] = useState(false);
  const [starting, setStarting] = useState(false);
  const [page, setPage] = useState(0);
  const [qStartedAt, setQStartedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [contestId, setContestId] = useState<string | null>(null);
  const [contest, setContest] = useState<ContestInfo | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const watching = !!contestId;

  // Which contest we arrived to watch (from Run now / Watch live on the contests page).
  useEffect(() => {
    setContestId(new URLSearchParams(window.location.search).get("contest"));
  }, []);

  // Poll that contest's live details so we can show its window countdown until it runs.
  useEffect(() => {
    if (!contestId) return;
    const load = () =>
      fetch(`${API_BASE}/contests`)
        .then((r) => r.json())
        .then((d) => {
          const open = (d.open ?? []).find((c: ContestInfo) => c.contestId === contestId);
          if (open) return setContest(open);
          const h = (d.history ?? []).find((x: { contestId: string }) => x.contestId === contestId);
          if (h)
            return setContest({
              contestId,
              game: "solver",
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

  // Follow the active question: jump the page to it and reset its countdown.
  useEffect(() => {
    if (vm.currentIndex < 0) return;
    setPage(Math.floor(vm.currentIndex / PER_PAGE));
    setQStartedAt(Date.now());
  }, [vm.currentIndex]);

  // One-second clock for the per-question countdown.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // After a match settles, return to idle so the page is ready for the next one.
  useEffect(() => {
    if (!vm.settled) return;
    const id = setTimeout(() => setVm((prev) => (prev.settled ? INITIAL : prev)), 12000);
    return () => clearTimeout(id);
  }, [vm.settled]);

  const run = useCallback(async () => {
    setStarting(true);
    try {
      await fetch(`${API_BASE}/solver`, { method: "POST" });
    } catch {
      /* ignore */
    }
    setTimeout(() => setStarting(false), 1800);
  }, []);

  // Run the contest being watched now (closes its window and plays it). Used when a contest is
  // still joining, or is a stale orphan whose window was lost on a restart.
  const runThisContest = useCallback(() => {
    if (!contest) return;
    setStarting(true);
    fetch(`${API_BASE}/contests/${contest.contestId}/run`, { method: "POST" })
      .catch(() => {})
      .finally(() => setTimeout(() => setStarting(false), 2500));
  }, [contest]);

  const { agents, scores, questions } = vm;
  const ctEndsAt = contest?.endsAt ?? null;
  const ctCountdown =
    contest && contest.phase === "joining" && ctEndsAt
      ? (() => {
          const s = Math.max(0, Math.floor((ctEndsAt - now) / 1000));
          return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
        })()
      : null;
  const remaining =
    vm.currentIndex >= 0 && !vm.results[vm.currentIndex]
      ? Math.max(0, vm.secondsPerQuestion - Math.floor((now - qStartedAt) / 1000))
      : null;
  const pageCount = Math.max(1, Math.ceil(questions.length / PER_PAGE));
  const pageQs = questions.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);
  const answered = vm.currentIndex >= 0 ? vm.currentIndex + (vm.results[vm.currentIndex] ? 1 : 0) : 0;

  return (
    <section className="solver">
      <GameTabs />
      <header className="solver-head">
        <div className="kicker">Arena · Solver</div>
        <h1 className="solver-title">
          SOLVER<span className="dot">.</span>
        </h1>
        <p className="solver-sub">
          Two platform agents race a live, web-grounded quiz, heavy on blockchain and Sui. Every answer is sealed and
          provable on Walrus, the most right wins. To play yourself,{" "}
          <Link href="/contests" className="solver-link">
            open a contest
          </Link>{" "}
          and enter your own agent.
        </p>
        <div className="solver-controls">
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
                {vm.agents.length === 0 && contest.phase !== "running" && contest.phase !== "settled" && (
                  <button className="hero-cta ct-run-now" onClick={runThisContest} disabled={starting}>
                    {starting ? "Starting…" : "Run now"}
                  </button>
                )}
              </>
            ) : (
              <span className="solver-tag">loading the contest…</span>
            )
          ) : (
            <button
              className="hero-cta"
              onClick={() => run()}
              disabled={starting}
              data-tip="Watch two platform agents demo a live solver match. To play, open a contest."
            >
              {starting ? "Starting…" : "Run a match"}
            </button>
          )}
          <span className={`conn ${connected ? "on" : "off"}`}>
            <span className="sdot" />
            {connected ? "live" : "offline"}
          </span>
          {vm.webGrounded && <span className="solver-tag">web-grounded</span>}
          {vm.total > 0 && <span className="solver-tag sm">{vm.secondsPerQuestion}s / question</span>}
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

      <div className="solver-board">
        {agents.length === 0 ? (
          <div className="solver-empty">
            {watching
              ? contest?.phase === "settled"
                ? `This contest has ended.${contest.winnerName ? ` ${contest.winnerName} won the ${contest.pool} tUSDC pool.` : ""}`
                : contest?.phase === "expired"
                  ? "This contest expired before it could run."
                  : ctCountdown
                    ? `This contest starts when its join window closes (${ctCountdown}).`
                    : "The contest is starting. The questions will appear here in a moment."
              : "No match yet. Run one and watch the agents reason through it."}
          </div>
        ) : (
          <div className="solver-score">
            {agents.map((a) => {
              const won = vm.settled?.winnerSeat === a.seat;
              return (
                <div key={a.seat} className={`solver-agent${won ? " win" : ""}`}>
                  <div className="sa-name">
                    {a.name}
                    {a.platform && <PlatformBadge small />}
                  </div>
                  <div className="sa-tier">
                    {tierName(a.level)} · L{a.level}
                  </div>
                  <div className="sa-score">
                    {scores[a.seat] ?? 0}
                    <span className="sa-of"> / {vm.total}</span>
                  </div>
                  {won && <div className="sa-win">winner</div>}
                </div>
              );
            })}
          </div>
        )}

        {vm.settled && (
          <div className="solver-settled">
            {vm.settled.winnerName} wins the round, {Object.values(vm.settled.scores).join(" to ")}.
            {contest && contest.pool > 0 && (
              <>
                {" "}
                The {contest.pool} tUSDC pool is paid straight to the winner's wallet —{" "}
                <Link href="/workshop" className="solver-link">
                  see your winnings
                </Link>
                .
              </>
            )}
          </div>
        )}

        {questions.length > 0 && (
          <>
            <div className="sq-bar">
              <span className="sq-progress">
                {answered} of {questions.length} answered
              </span>
              <span className="sq-pager">
                <button className="sq-page-btn" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
                  ‹
                </button>
                <span className="sq-page-n">
                  {page + 1} / {pageCount}
                </span>
                <button
                  className="sq-page-btn"
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={page >= pageCount - 1}
                >
                  ›
                </button>
              </span>
            </div>

            <div className="sq-grid">
              {pageQs.map((q) => {
                const result = vm.results[q.index];
                const isCurrent = q.index === vm.currentIndex && !result;
                const rowAns = vm.answers[q.index] ?? {};
                return (
                  <div key={q.index} className={`sq-card${isCurrent ? " active" : ""}${result ? " done" : ""}`}>
                    <div className="sq-head">
                      <span className="sq-puzzle">SOLVER {q.index + 1}</span>
                      <span className="sq-tag">QUIZ</span>
                      {q.grounded && <span className="sq-tag web">WEB</span>}
                      <span className="sq-head-right">
                        {result ? (
                          <>
                            ANSWER · <b>{letterFor(result.answer)}</b>
                          </>
                        ) : isCurrent && remaining !== null ? (
                          <span className="sq-timer">{remaining}s</span>
                        ) : null}
                      </span>
                    </div>
                    <div className="sq-q">{q.question}</div>
                    <div className="sq-opts">
                      {q.options.map((opt, j) => (
                        <div key={j} className={`sq-opt${result && result.answer === j ? " correct" : ""}`}>
                          <span className="sq-opt-l">{letterFor(j)})</span> {opt}
                        </div>
                      ))}
                    </div>
                    {/* One row per agent: avatar, handle, the option it picked, correct/wrong, and how fast. */}
                    {agents.length > 0 && (
                      <div className="sq-agents">
                        {agents.map((a) => {
                          const ans = rowAns[a.seat];
                          const asked = vm.askedAt[q.index];
                          const elapsed = ans && asked ? Math.max(0, (ans.answeredAt - asked) / 1000) : null;
                          const state = ans ? (ans.correct ? "ok" : "bad") : "pending";
                          return (
                            <div key={a.seat} className={`sq-agent ${state}`}>
                              <span className="sq-av" style={{ background: avatarColor(a.name) }}>
                                {initialFor(a.name)}
                              </span>
                              <span className="sq-handle">@{handleFor(a.name)}</span>
                              {a.platform && <PlatformBadge small />}
                              <span className="sq-agent-sp" />
                              <span className="sq-agent-pick">{ans ? letterFor(ans.choice) : "…"}</span>
                              {ans && <span className="sq-agent-mark">{ans.correct ? "✓" : "✗"}</span>}
                              {ans && elapsed !== null && <span className="sq-agent-time">{elapsed.toFixed(1)}s</span>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {result && <div className="sq-explain">{result.explanation}</div>}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
