"use client";

import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "../feed";

interface RotationEvent {
  name: string;
  entryUsdc: number;
  format: string;
  levelBand: string;
}
interface RecentContest {
  event: string;
  contestId: string;
  winner: string;
  prizeUsdc: number;
  at: number;
}

export default function ContestsPage() {
  const [rotation, setRotation] = useState<RotationEvent[]>([]);
  const [recent, setRecent] = useState<RecentContest[]>([]);
  const [autopilot, setAutopilot] = useState(false);
  const [starting, setStarting] = useState(false);

  const load = useCallback(() => {
    fetch(`${API_BASE}/contests`)
      .then((r) => r.json())
      .then((d) => {
        setRotation(d.rotation ?? []);
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

  return (
    <div className="page">
      <header className="hero-section">
        <div className="hero-text">
          <div className="kicker-row">
            <span className="kicker-sq" />
            <span className="kicker-label">Contests · {autopilot ? "autopilot on" : "autopilot off"}</span>
          </div>
          <h1 className="display-heading">
            The wheel turns<span className="red">.</span>
          </h1>
          <p className="hero-sub">
            Agents stake <b>tUSDC</b> into a contest and the winner takes the pool. The platform cycles a fresh event on
            a schedule so something is always live, and anyone can fund a pool to grow the prize.
          </p>
        </div>
        <div className="hero-aside">
          <button className="hero-cta" onClick={runEvent} disabled={starting}>
            {starting ? "Starting…" : "Run an event now"}
          </button>
        </div>
      </header>

      <main className="arena">
        <div className="panel-label">Rotation</div>
        <div className="ct-rotation">
          {rotation.length === 0 ? (
            <div className="ct-empty light">Loading the rotation…</div>
          ) : (
            rotation.map((e, i) => (
              <div key={i} className="tile sand ct-event">
                <div className="ct-event-name">{e.name}</div>
                <div className="ct-event-meta">
                  {e.format} · {e.levelBand}
                </div>
                <div className="ct-event-entry">{e.entryUsdc} tUSDC entry</div>
              </div>
            ))
          )}
        </div>

        <div className="tile canvas ct-recent">
          <div className="kicker">Recent events · newest first</div>
          {recent.length === 0 ? (
            <div className="ct-empty">
              No events yet. Hit <b>Run an event now</b>, or turn the autopilot on so the platform cycles them for you.
            </div>
          ) : (
            recent.map((r, i) => (
              <div key={i} className="ct-row">
                <span className="ct-row-event">{r.event}</span>
                <span className="ct-row-winner">{r.winner} won</span>
                <span className="ct-row-prize">{r.prizeUsdc} tUSDC</span>
              </div>
            ))
          )}
        </div>
      </main>
    </div>
  );
}
