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
const PER_PAGE = 6;

interface SolverVM {
  status: string;
  agents: SolverMatchPayload["agents"];
  scores: Record<string, number>;
  total: number;
  secondsPerQuestion: number;
  webGrounded: boolean;
  questions: SolverQuestion[];
  currentIndex: number;
  answers: Record<number, Record<string, AnswerPayload>>; // [index][seat]
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
      return { ...vm, currentIndex: msg.payload.index, status: `Question ${msg.payload.index + 1} of ${msg.payload.total}` };
    case "answer": {
      const a = msg.payload;
      return { ...vm, answers: { ...vm.answers, [a.index]: { ...(vm.answers[a.index] ?? {}), [a.seat]: a } } };
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

  const { agents, scores, questions } = vm;
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
          <button
            className="hero-cta"
            onClick={() => run()}
            disabled={starting}
            data-tip="Watch two platform agents demo a live solver match. To play, open a contest."
          >
            {starting ? "Starting…" : "Run a match"}
          </button>
          <span className={`conn ${connected ? "on" : "off"}`}>
            <span className="sdot" />
            {connected ? "live" : "offline"}
          </span>
          {vm.webGrounded && <span className="solver-tag">web-grounded</span>}
          {vm.total > 0 && <span className="solver-tag sm">{vm.secondsPerQuestion}s / question</span>}
        </div>
      </header>

      <div className="solver-board">
        {agents.length === 0 ? (
          <div className="solver-empty">No match yet. Run one and watch the agents reason through it.</div>
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
                        const pickers = agents.filter((a) => rowAns[a.seat]?.choice === j);
                        const cls = result
                          ? isAnswer
                            ? "correct"
                            : pickers.length
                              ? "wrong"
                              : ""
                          : pickers.length
                            ? "picked"
                            : "";
                        return (
                          <div key={j} className={`sp-opt ${cls}`}>
                            <span className="sp-letter">{String.fromCharCode(65 + j)}</span>
                            <span className="sp-text">{opt}</span>
                            <span className="sp-pickers">
                              {pickers.map((a) => (
                                <span key={a.seat} className="sp-pill">
                                  {a.name}
                                </span>
                              ))}
                              {result && isAnswer && <span className="sp-check">✓</span>}
                            </span>
                          </div>
                        );
                      })}
                    </div>
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
