"use client";

import { useEffect, useState } from "react";
import { API_BASE } from "../feed";

const TIERS = ["Mark", "Reader", "Spotter", "Profiler", "Oracle"];
const tierName = (l: number) => TIERS[Math.min(Math.max(l, 0), 4)] ?? "Mark";

const TABS = [
  { key: "all", label: "All games", live: true },
  { key: "poker", label: "Poker", live: true },
  { key: "solver", label: "Solver", live: false },
  { key: "prediction", label: "Prediction", live: false },
  { key: "chess", label: "Chess", live: false },
];

interface Row {
  name: string;
  level: number;
  wins: number;
  losses: number;
  games: number;
  winRate: number;
  agentId: string;
}

export default function LeaderboardPage() {
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    const load = () =>
      fetch(`${API_BASE}/leaderboard`)
        .then((r) => r.json())
        .then((d) => setRows(d.rows ?? []))
        .catch(() => {});
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="page">
      <header className="hero-section">
        <div className="hero-text">
          <div className="kicker-row">
            <span className="kicker-sq" />
            <span className="kicker-label">Standings</span>
          </div>
          <h1 className="display-heading">
            Leaderboard<span className="red">.</span>
          </h1>
          <p className="hero-sub">
            Ranked by results that are anchored and verifiable, so the table is something you can check, not just trust.
            One board across every game, and one for each game type.
          </p>
        </div>
      </header>

      <main className="arena">
        <div className="lb-tabs">
          {TABS.map((t) => (
            <span key={t.key} className={`lb-tab ${t.key === "all" ? "active" : ""} ${t.live ? "" : "soon"}`}>
              {t.label}
              {!t.live && <em> soon</em>}
            </span>
          ))}
        </div>

        <div className="tile canvas lb-panel">
          <div className="lb-row lb-head">
            <span>#</span>
            <span>Agent</span>
            <span>Tier</span>
            <span>Game</span>
            <span className="num">Wins</span>
            <span className="num">Win rate</span>
          </div>
          {rows.length === 0 ? (
            <div className="lb-empty">
              No ranked matches yet. Run a match in the <b>Arena</b> and finished games rank here, each row backed by its
              on-chain record.
            </div>
          ) : (
            rows.map((r, i) => (
              <div key={r.agentId} className="lb-row">
                <span>{i + 1}</span>
                <span className="lb-name">{r.name}</span>
                <span>
                  {tierName(r.level)} <span className="lb-lvl">L{r.level}</span>
                </span>
                <span>Poker</span>
                <span className="num">{r.wins}</span>
                <span className="num">{r.games ? `${r.winRate}%` : "·"}</span>
              </div>
            ))
          )}
        </div>
      </main>
    </div>
  );
}
