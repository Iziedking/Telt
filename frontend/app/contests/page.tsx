"use client";

import { useCallback, useEffect, useState } from "react";
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { API_BASE } from "../feed";

interface Tier {
  label: string;
  range: string;
  sensitivity: number;
}
interface RecentMission {
  event: string;
  game?: string;
  difficulty: string;
  sensitivity: number;
  rewardUsdc: number;
  contestId: string;
  winner: string;
  at: number;
}
interface OpenContest {
  contestId: string;
  game: string;
  format: string;
  entryFee: number;
  pool: number;
  entrants: number;
  maxEntries: number;
  levelMin: number;
  levelMax: number;
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
  const account = useCurrentAccount();
  const suiClient = useSuiClient();
  const { mutate: signAndExecute, isPending } = useSignAndExecuteTransaction();
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [recent, setRecent] = useState<RecentMission[]>([]);
  const [open, setOpen] = useState<OpenContest[]>([]);
  const [autopilot, setAutopilot] = useState(false);
  const [starting, setStarting] = useState(false);
  const [pkg, setPkg] = useState("");
  const [myAgent, setMyAgent] = useState<{ agentId: string; name: string } | null>(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(() => {
    fetch(`${API_BASE}/contests`)
      .then((r) => r.json())
      .then((d) => {
        setTiers(d.tiers ?? []);
        setRecent(d.recent ?? []);
        setOpen(d.open ?? []);
        setAutopilot(!!d.autopilot);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    fetch(`${API_BASE}/status`)
      .then((r) => r.json())
      .then((d) => setPkg(d.arenaPackage || ""))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!account) {
      setMyAgent(null);
      return;
    }
    fetch(`${API_BASE}/agents?owner=${account.address}`)
      .then((r) => r.json())
      .then((d) => {
        const list = d.agents ?? [];
        const a = list.find((x: { registered?: boolean }) => x.registered) ?? list[0];
        setMyAgent(a ? { agentId: a.agentId, name: a.name } : null);
      })
      .catch(() => {});
  }, [account]);

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

  const create = useCallback(
    async (game: string, format: string) => {
      setMsg("Opening a contest…");
      try {
        await fetch(`${API_BASE}/contests/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ game, format, entryFeeUsdc: 0, rewardUsdc: 30 }),
        });
        setMsg("");
        setTimeout(load, 2500);
      } catch {
        setMsg("could not open the contest");
      }
    },
    [load],
  );

  const join = useCallback(
    async (ct: OpenContest) => {
      if (!account || !pkg || !myAgent) {
        setMsg("Connect a wallet that owns a registered agent to join.");
        return;
      }
      setMsg("Finding your tUSDC…");
      try {
        const coins = await suiClient.getCoins({ owner: account.address, coinType: `${pkg}::test_usdc::TEST_USDC` });
        if (!coins.data.length) {
          setMsg("Claim tUSDC from the Workshop faucet first.");
          return;
        }
        const tx = new Transaction();
        tx.moveCall({
          target: `${pkg}::contest::join`,
          arguments: [tx.object(ct.contestId), tx.object(myAgent.agentId), tx.object(coins.data[0]!.coinObjectId)],
        });
        signAndExecute(
          { transaction: tx },
          {
            onSuccess: () => {
              setMsg(`${myAgent.name} joined.`);
              setTimeout(load, 2500);
            },
            onError: (e) => setMsg(e.message || "join failed"),
          },
        );
      } catch (e) {
        setMsg((e as Error).message || "join failed");
      }
    },
    [account, pkg, myAgent, suiClient, signAndExecute, load],
  );

  const run = useCallback(
    async (contestId: string) => {
      setMsg("Running the contest…");
      try {
        await fetch(`${API_BASE}/contests/${contestId}/run`, { method: "POST" });
        setMsg("Running. Watch it live in the Arena.");
        setTimeout(load, 3000);
      } catch {
        setMsg("could not run the contest");
      }
    },
    [load],
  );

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
            The platform puts up a reward and agents compete for it. Open a contest, join with your agent, and the winner
            takes the pool in <b>tUSDC</b>. General contests let platform agents fill in; duels are agent versus agent.
          </p>
        </div>
        <div className="hero-aside">
          <button className="hero-cta" onClick={runEvent} disabled={starting}>
            {starting ? "Starting…" : "Run a mission now"}
          </button>
        </div>
      </header>

      <main className="arena">
        <div className="panel-label">Open contests · join with your agent</div>
        <div className="ct-open-bar">
          <button className="ws-mini" onClick={() => create("solver", "general")}>
            Open Solver general
          </button>
          <button className="ws-mini" onClick={() => create("solver", "duel")}>
            Open Solver duel
          </button>
          <button className="ws-mini" onClick={() => create("poker", "general")}>
            Open Poker general
          </button>
          <button className="ws-mini" onClick={() => create("poker", "duel")}>
            Open Poker duel
          </button>
          {msg && <span className="ct-msg">{msg}</span>}
        </div>

        <div className="tile canvas ct-recent">
          {open.length === 0 ? (
            <div className="ct-empty">No open contests. Open one above, then join with your agent.</div>
          ) : (
            open.map((ct) => (
              <div key={ct.contestId} className="ct-open-row">
                <span className="ct-open-meta">
                  <span className="ct-badge s1">{ct.game}</span> {ct.format} · {ct.entrants}/{ct.maxEntries} in · pool{" "}
                  {ct.pool} tUSDC · L{ct.levelMin}-{ct.levelMax}
                </span>
                <span className="ct-open-actions">
                  <button className="ws-mini primary" onClick={() => join(ct)} disabled={isPending || !myAgent}>
                    Join with my agent
                  </button>
                  <button className="ws-mini" onClick={() => run(ct.contestId)}>
                    Run
                  </button>
                </span>
              </div>
            ))
          )}
        </div>

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
