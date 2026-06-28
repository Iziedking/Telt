"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  API_BASE,
  WS_URL,
  type FeedMessage,
  type SolverMatchPayload,
  type PuzzlePayload,
  type AnswerPayload,
  type PuzzleResultPayload,
  type SolverSettledPayload,
} from "./feed";
import GameTabs from "./GameTabs";

const TIERS = ["Mark", "Reader", "Spotter", "Profiler", "Oracle"];
const tierName = (l: number) => TIERS[Math.min(Math.max(l, 0), 4)] ?? "Mark";

interface SolverVM {
  status: string;
  agents: SolverMatchPayload["agents"];
  scores: Record<string, number>;
  total: number;
  webGrounded: boolean;
  puzzle: PuzzlePayload | null;
  answers: Record<string, AnswerPayload>; // by seat, for the current puzzle
  result: PuzzleResultPayload | null; // the reveal for the current puzzle
  settled: SolverSettledPayload | null;
}

const INITIAL: SolverVM = {
  status: "Waiting for a match.",
  agents: [],
  scores: {},
  total: 0,
  webGrounded: false,
  puzzle: null,
  answers: {},
  result: null,
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
        status: `${p.agents.map((a) => a.name).join("  vs  ")}`,
        agents: p.agents,
        scores,
        total: p.puzzleCount,
        webGrounded: p.webGrounded,
      };
    }
    case "puzzle":
      return { ...vm, puzzle: msg.payload, answers: {}, result: null, status: `Question ${msg.payload.index + 1} of ${msg.payload.total}` };
    case "answer":
      return { ...vm, answers: { ...vm.answers, [msg.payload.seat]: msg.payload } };
    case "puzzleResult":
      return { ...vm, result: msg.payload, scores: msg.payload.scores };
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

  const run = useCallback(async () => {
    setStarting(true);
    try {
      await fetch(`${API_BASE}/solver?puzzles=10`, { method: "POST" });
    } catch {
      /* ignore */
    }
    setTimeout(() => setStarting(false), 1800);
  }, []);

  const { puzzle, result, answers, agents, scores } = vm;
  const answeredBy = (j: number) => agents.filter((a) => answers[a.seat]?.choice === j);

  return (
    <section className="solver">
      <GameTabs />
      <header className="solver-head">
        <div className="kicker">Arena · Solver</div>
        <h1 className="solver-title">
          SOLVER<span className="dot">.</span>
        </h1>
        <p className="solver-sub">
          Run a match to watch two platform agents answer live, web-grounded quizzes, every answer sealed and provable
          on Walrus. To play yourself, open a contest and enter your own agent.
        </p>
        <div className="solver-controls">
          <button
            className="hero-cta"
            onClick={() => run()}
            disabled={starting}
            title="Watch two platform agents demo a live solver match"
          >
            {starting ? "Starting…" : "Run a match"}
          </button>
          <span className={`conn ${connected ? "on" : "off"}`}>
            <span className="sdot" />
            {connected ? "live" : "offline"}
          </span>
          {vm.webGrounded && <span className="solver-tag">web-grounded</span>}
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
                  <div className="sa-name">{a.name}</div>
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

        {puzzle && (
          <div className="solver-puzzle">
            <div className="sp-top">
              <span className="sp-topic">{puzzle.topic}</span>
              {puzzle.grounded && <span className="solver-tag sm">web</span>}
              <span className="sp-count">
                {puzzle.index + 1} / {puzzle.total}
              </span>
            </div>
            <div className="sp-q">{puzzle.question}</div>
            <div className="sp-options">
              {puzzle.options.map((opt, j) => {
                const isAnswer = result?.answer === j;
                const pickers = answeredBy(j);
                const cls = result ? (isAnswer ? "correct" : pickers.length ? "wrong" : "") : pickers.length ? "picked" : "";
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

            <div className="sp-rationales">
              {agents.map((a) => {
                const ans = answers[a.seat];
                if (!ans) return null;
                return (
                  <div key={a.seat} className="sp-rat">
                    <span className="sp-rat-name">{a.name}</span>
                    {result && (
                      <span className={`sp-verdict ${ans.correct ? "ok" : "no"}`}>{ans.correct ? "correct" : "wrong"}</span>
                    )}
                    {ans.blobId && <span className="sp-anchor" title={`anchored on Walrus${ans.anchorDigest ? `\n${ans.anchorDigest}` : ""}`}>proven</span>}
                    <span className="sp-rat-why">{ans.rationale}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {vm.settled && (
          <div className="solver-settled">
            {vm.settled.winnerName} wins the round, {Object.values(vm.settled.scores).join(" to ")}.
          </div>
        )}
      </div>
    </section>
  );
}
