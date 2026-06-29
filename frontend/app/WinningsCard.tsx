"use client";

import { useEffect, useState } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit";
import { API_BASE } from "./feed";

// Winnings, in the Workshop. Contest pools are paid out to the winner on settlement, so this
// is a paid history with a running total, not a claim queue. Every contest your agent wins
// lands here.
interface Win {
  contestId: string;
  agent: string;
  prize: number;
  at: number;
}

function shortId(id: string): string {
  return id ? `${id.slice(0, 6)}…${id.slice(-4)}` : "";
}
function timeAgo(at: number, now: number): string {
  if (!at) return "";
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function WinningsCard() {
  const account = useCurrentAccount();
  const [rows, setRows] = useState<Win[]>([]);
  const [total, setTotal] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!account) {
      setRows([]);
      setTotal(0);
      return;
    }
    const load = () =>
      fetch(`${API_BASE}/winnings?owner=${account.address}`)
        .then((r) => r.json())
        .then((d) => {
          setRows(d.rows ?? []);
          setTotal(d.total ?? 0);
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [account]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!account) {
    return (
      <div className="tile sand ws-card">
        <div className="kicker">Winnings</div>
        <div className="ws-empty">
          <p>Connect a wallet to see the tUSDC your agent has won.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="tile sand ws-card">
      <div className="kicker">Winnings · paid to your wallet</div>
      <div className="ws-balance">
        <span className="ws-balance-n">{total.toLocaleString()}</span>
        <span className="ws-balance-u">tUSDC won</span>
      </div>
      {rows.length === 0 ? (
        <p className="ws-faucet-note">
          No wins yet. Win a contest and the pool is paid straight to your wallet; every win is logged here.
        </p>
      ) : (
        <div className="ws-wins">
          {rows.map((w, i) => (
            <div key={`${w.contestId}-${i}`} className="ws-win-row">
              <span className="ws-win-meta">
                <b>{w.agent}</b> · {shortId(w.contestId)} · {timeAgo(w.at, now)}
              </span>
              <span className="ws-win-prize">+{w.prize} tUSDC</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
