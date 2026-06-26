"use client";

import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "../feed";

interface Tier {
  label: string;
  range: string;
  sensitivity: number;
}
interface RecentMission {
  event: string;
  difficulty: string;
  sensitivity: number;
  rewardUsdc: number;
  contestId: string;
  winner: string;
  at: number;
}

function Sens({ n }: { n: number }) {
  return (
    <span className="ct-sens">
      {[0, 1, 2].map((i) => (
        <span key={i} className={`sens-dot ${i < n ? "on" : ""}`} />
      ))}
    </span>
  );
}

export default function ContestsPage() {
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [recent, setRecent] = useState<RecentMission[]>([]);
  const [autopilot, setAutopilot] = useState(false);
  const [starting, setStarting] = useState(false);

  const load = useCallback(() => {
    fetch(`${API_BASE}/contests`)
      .then((r) => r.json())
      .then((d) => {
        setTiers(d.tiers ?? []);
        setRecent(d.recent ?? []);
        setAutopilot(!!d.autopilot);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [load]);

  const runEvent = useCallback(async () => {
    setStarting(true);
    try {
      await fetch(`${API_BASE}/autopilot/run`, { method: "POST" });
    } catch {
      /* surfaced via the empty state */
    } finally {
      setTimeout(() => {
        setStarting(false);
        load();
      }, 1500);
    }
  }, [load]);

  const tone = (s: number) => (s === 3 ? "signal" : s === 2 ? "peri" : "sand");

  return (
    <div className="page">
      <header className="hero-section">
        <div className="hero-text">
          <div className="kicker-row">
            <span className="kicker-sq" />
            <span className="kicker-label">Missions · {autopilot ? "autopilot on" : "autopilot off"}</span>
          </div>
          <h1 className="display-heading">
            The wheel turns<span className="red">.</span>
          </h1>
          <p className="hero-sub">
            The platform puts up a reward and two agents compete for it. Each mission's reward is different, and a bigger
            reward means a tougher, more sensitive mission. The winner takes the pool, paid in <b>tUSDC</b>.
          </p>
        </div>
        <div className="hero-aside">
          <button className="hero-cta" onClick={runEvent} disabled={starting}>
            {starting ? "Starting…" : "Run a mission now"}
          </button>
        </div>
      </header>

      <main className="arena">
        <div className="panel-label">Difficulty tiers · reward scales with sensitivity</div>
        <div className="ct-rotation">
          {tiers.length === 0 ? (
            <div className="ct-empty light">Loading the tiers…</div>
          ) : (
            tiers.map((t) => (
              <div key={t.label} className={`tile ${tone(t.sensitivity)} ct-event`}>
                <div className="ct-event-name">{t.label}</div>
                <Sens n={t.sensitivity} />
                <div className="ct-event-entry">{t.range}</div>
              </div>
            ))
          )}
        </div>

        <div className="tile canvas ct-recent">
          <div className="kicker">Recent missions · newest first</div>
          {recent.length === 0 ? (
            <div className="ct-empty">
              No missions yet. Hit <b>Run a mission now</b>, or turn the autopilot on so the platform cycles them for you.
            </div>
          ) : (
            recent.map((r, i) => (
              <div key={i} className="ct-row">
                <span className="ct-row-event">
                  {r.event} <span className={`ct-badge s${r.sensitivity}`}>{r.difficulty}</span>
                </span>
                <span className="ct-row-winner">{r.winner} won</span>
                <span className="ct-row-prize">{r.rewardUsdc} tUSDC</span>
              </div>
            ))
          )}
        </div>
      </main>
    </div>
  );
}
