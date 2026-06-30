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
import { play as sound } from "./sound";
import PlatformBadge from "./PlatformBadge";

const TIERS = ["Mark", "Reader", "Spotter", "Profiler", "Oracle"];
const tierName = (l: number) => TIERS[Math.min(Math.max(l, 0), 4)] ?? "Mark";
const PER_PAGE = 6;

const letterFor = (n: number) => String.fromCharCode(65 + n);

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
    case "puzzle": {
      const p = msg.payload;
      // Append late questions (sudden-death tie-breakers arrive after the initial set) so they
      // show in the grid and count toward the total.
      const questions =
        p.index >= vm.questions.length
          ? [...vm.questions, { index: p.index, topic: p.topic, question: p.question, options: p.options, grounded: p.grounded }]
          : vm.questions;
      return {
        ...vm,
        questions,
        total: Math.max(vm.total, questions.length),
        currentIndex: p.index,
        askedAt: { ...vm.askedAt, [p.index]: Date.now() },
        status: `Question ${p.index + 1} of ${p.total}`,
      };
    }
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
        // Game audio: a ding per answer, a clap + celebration (pausing the music) when it settles.
        if (msg.type === "answer") sound("solver");
        else if (msg.type === "solverSettled") sound("win", { pauseMusic: true });
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

  // Keep the finished quiz on screen. A new match resets the board on its own (solverMatch),
  // so there is no timed wipe that makes the questions vanish a few seconds after they settle.

  // Persist a contest's match so a refresh keeps the quiz: the live WS feed does not replay, so
  // without this the board would go blank after reloading. Restore on load, then save on change.
  useEffect(() => {
    if (!contestId) return;
    try {
      const raw = localStorage.getItem(`solver-vm-${contestId}`);
      if (raw) setVm((cur) => (cur.questions.length === 0 && cur.agents.length === 0 ? (JSON.parse(raw) as SolverVM) : cur));
    } catch {
      /* ignore */
    }
  }, [contestId]);
  useEffect(() => {
    if (!contestId || (vm.questions.length === 0 && vm.agents.length === 0)) return;
    try {
      localStorage.setItem(`solver-vm-${contestId}`, JSON.stringify(vm));
    } catch {
      /* ignore */
    }
  }, [vm, contestId]);

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
          SOLVER
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
            {vm.settled.winnerName} wins the round, {Object.values(vm.settled.scores).join(" to ")}
            {vm.settled.tiebreak === "sudden death"
              ? ", decided in sudden death"
              : vm.settled.tiebreak === "tier"
                ? ", a dead heat awarded to the higher tier"
                : ""}
            .
            {contest && contest.pool > 0 && (
              <>
                {" "}
                The {contest.pool} tUSDC pool is paid straight to the winner's wallet.{" "}
                <Link href="/workshop" className="solver-link">
                  See your winnings
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
                    <div className="sq-top">
                      <span className="sq-num">Q{q.index + 1}</span>
                      <span className="sp-topic">{q.topic}</span>
                      {q.grounded && <span className="solver-tag sm">web</span>}
                      {isCurrent && remaining !== null && <span className="sq-timer">{remaining}s</span>}
                    </div>
                    <div className="sq-q">{q.question}</div>
                    <div className="sp-options">
                      {q.options.map((opt, j) => {
                        const isAnswer = result?.answer === j;
                        const someonePicked = agents.some((a) => rowAns[a.seat]?.choice === j);
                        const cls = result ? (isAnswer ? "correct" : someonePicked ? "wrong" : "") : someonePicked ? "picked" : "";
                        return (
                          <div key={j} className={`sp-opt ${cls}`}>
                            <span className="sp-letter">{letterFor(j)}</span>
                            <span className="sp-text">{opt}</span>
                            {result && isAnswer && <span className="sp-check">✓</span>}
                          </div>
                        );
                      })}
                    </div>
                    {/* Proof of what each agent picked: the option letter, and right or wrong once judged. */}
                    {agents.length > 0 && (
                      <div className="sq-picks">
                        {agents.map((a) => {
                          const ans = rowAns[a.seat];
                          const judged = !!result;
                          const correct = judged && !!ans && ans.choice === result.answer;
                          return (
                            <div key={a.seat} className={`sq-pick${judged && ans ? (correct ? " ok" : " bad") : ""}`}>
                              <span className="sq-pick-name">
                                {a.name}
                                {a.platform && <PlatformBadge small />}
                              </span>
                              <span className="sq-pick-letter">{ans ? letterFor(ans.choice) : "…"}</span>
                              {judged && ans && <span className="sq-pick-mark">{correct ? "correct" : "wrong"}</span>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {result && <div className="sp-explain">{result.explanation}</div>}
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
