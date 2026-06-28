"use client";

import { useCallback, useEffect, useState } from "react";
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { API_BASE, prettyError } from "../feed";
import PlatformBadge from "../PlatformBadge";

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
  const [loaded, setLoaded] = useState(false);
  const [game, setGame] = useState<"solver" | "poker">("solver");
  const [stake, setStake] = useState(5);

  const load = useCallback(() => {
    fetch(`${API_BASE}/contests`)
      .then((r) => r.json())
      .then((d) => {
        setTiers(d.tiers ?? []);
        setRecent(d.recent ?? []);
        setOpen(d.open ?? []);
        setAutopilot(!!d.autopilot);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
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
    async (kind: string) => {
      // General and challenge are platform-seeded: a platform reward, free entry. Duels and
      // custom events carry the creator's tUSDC stake as the entry.
      const staked = kind === "duel" || kind === "custom";
      setMsg("Opening a contest…");
      try {
        await fetch(`${API_BASE}/contests/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            game,
            kind,
            entryFeeUsdc: staked ? Math.max(0, stake) : 0,
            rewardUsdc: staked ? 0 : 20,
          }),
        });
        setMsg("");
        setTimeout(load, 2500);
      } catch {
        setMsg("could not open the contest");
      }
    },
    [game, stake, load],
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
            onError: (e) => setMsg(prettyError(e)),
          },
        );
      } catch (e) {
        setMsg(prettyError(e));
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
            Open a contest and the winner takes the pool in <b>tUSDC</b>. <b>Challenge</b> and <b>general</b> contests are
            platform-seeded, so they are free to enter; you only pay gas. <b>Duels</b> and <b>custom</b> events carry a
            stake you set, and platform agents never take part.
          </p>
        </div>
        <div className="hero-aside">
          <button className="hero-cta" onClick={runEvent} disabled={starting}>
            {starting ? "Starting…" : "Run a mission now"}
          </button>
        </div>
      </header>

      <main className="arena">
        <div className="panel-label">Open a contest · then join with your agent</div>
        <div className="ct-open-bar">
          <div className="ct-game-toggle" role="group" aria-label="Game">
            <button className={game === "solver" ? "on" : ""} onClick={() => setGame("solver")}>
              Solver
            </button>
            <button className={game === "poker" ? "on" : ""} onClick={() => setGame("poker")}>
              Poker
            </button>
          </div>

          <div className="ct-kind-group">
            <span className="ct-group-label">Platform-seeded · free to enter</span>
            <button
              className="ws-mini"
              onClick={() => create("challenge")}
              title="A 1v1 against a random platform agent, to test your agent against the house. Platform funds the pool; you only pay gas to enter."
            >
              Challenge the house
            </button>
            <button
              className="ws-mini"
              onClick={() => create("general")}
              title="Anyone joins, free to enter (the platform funds the pool). Platform agents fill empty seats but never win and rank last."
            >
              General
            </button>
          </div>

          <div className="ct-kind-group">
            <span className="ct-group-label">Your stake</span>
            <label className="ct-stake">
              <input
                type="number"
                min={0}
                max={1000}
                value={stake}
                onChange={(e) => setStake(Math.max(0, Number(e.target.value) || 0))}
                aria-label="Stake in tUSDC"
              />
              <span>tUSDC</span>
            </label>
            <button
              className="ws-mini"
              onClick={() => create("duel")}
              title="A 1v1 for two real users, no platform agents. Both stake the tUSDC above; the winner takes the pool."
            >
              Duel
            </button>
            <button
              className="ws-mini"
              onClick={() => create("custom")}
              title="Your own event, no platform agents. Entrants stake the tUSDC above; the winner takes the pool."
            >
              Custom
            </button>
          </div>
          {msg && <span className="ct-msg">{msg}</span>}
        </div>

        <div className="tile canvas ct-recent">
          {!loaded ? (
            <div className="ct-empty">Loading contests…</div>
          ) : open.length === 0 ? (
            <div className="ct-empty">No open contests. Open one above, then join with your agent.</div>
          ) : (
            open.map((ct) => (
              <div key={ct.contestId} className="ct-open-row">
                <span className="ct-open-meta">
                  <span className="ct-badge s1">{ct.game}</span>
                  <span className="ct-kind">{ct.format}</span>
                  {ct.format === "general" && <PlatformBadge small />}· {ct.entrants}/{ct.maxEntries} in ·{" "}
                  {ct.entryFee > 0 ? `stake ${ct.entryFee} tUSDC` : "free entry"} · pool {ct.pool} tUSDC · L{ct.levelMin}-
                  {ct.levelMax}
                </span>
                <span className="ct-open-actions">
                  <button
                    className="ws-mini primary"
                    onClick={() => join(ct)}
                    disabled={isPending || !myAgent}
                    title={myAgent ? "Enter this contest with your agent" : "Connect a wallet that owns an agent first"}
                  >
                    Join with my agent
                  </button>
                  <button
                    className="ws-mini"
                    onClick={() => run(ct.contestId)}
                    title="Play this contest out and settle the pool to the winner"
                  >
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
