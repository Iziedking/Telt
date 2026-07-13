"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { API_BASE, prettyError } from "../feed";
import PlatformBadge from "../PlatformBadge";
import { SuiscanLink } from "../suiscan";

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
  endsAt: number | null;
  phase: "joining" | "running" | "expired";
  difficulty: string | null;
}
interface HistoryItem {
  contestId: string;
  winner: string;
  platform?: boolean;
  prize: number;
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

// Whole seconds until a deadline, clamped at zero; mm:ss formatted.
function countdown(endsAt: number | null, now: number): string {
  if (!endsAt) return "";
  const s = Math.max(0, Math.floor((endsAt - now) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
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

// The four kinds of contest, described in the only terms that matter before you click: who you are
// playing, and where the money comes from and goes. These were previously four bare buttons whose
// explanation lived in a hover tooltip, which meant that in practice nobody knew what any of them
// did.
const KINDS: { id: string; name: string; who: string; pays: string; staked: boolean; window: boolean }[] = [
  {
    id: "challenge",
    name: "Challenge the house",
    who: "Your agent, against one of ours.",
    pays: "Free to enter. The platform puts up the prize; beat us and it is yours.",
    staked: false,
    window: false,
  },
  {
    id: "general",
    name: "General",
    who: "Open to everyone. Our agents fill any empty seats.",
    pays: "Free to enter, platform-funded prize. House agents play but can never win it.",
    staked: false,
    window: false,
  },
  {
    id: "duel",
    name: "Duel",
    who: "You against one other real player. No house agents.",
    pays: "You both stake. Winner takes the pool. You set how long it stays open for them.",
    staked: true,
    window: true,
  },
  {
    id: "custom",
    name: "Custom",
    who: "Your own event. Real players only, up to eight.",
    pays: "Entrants stake. Winner takes the pool. You set how long it stays open.",
    staked: true,
    window: true,
  },
];

export default function ContestsPage() {
  const account = useCurrentAccount();
  const suiClient = useSuiClient();
  const router = useRouter();
  const { mutate: signAndExecute, isPending } = useSignAndExecuteTransaction();
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [recent, setRecent] = useState<RecentMission[]>([]);
  const [open, setOpen] = useState<OpenContest[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [autopilot, setAutopilot] = useState(false);
  const [pkg, setPkg] = useState("");
  const [myAgent, setMyAgent] = useState<{ agentId: string; name: string } | null>(null);
  const [msg, setMsg] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [game, setGame] = useState<"solver" | "poker">("solver");
  // How long a custom event stays open for entries. The platform's own contests use a short demo
  // window; a creator's event needs long enough that somebody can actually turn up.
  const [joinMinutes, setJoinMinutes] = useState(10);
  // Which kind is currently being opened on chain, so the buttons can say so and lock.
  const [pending, setPending] = useState("");
  const [stake, setStake] = useState(5);
  const [watch, setWatch] = useState<{ href: string; label: string } | null>(null);
  const [tab, setTab] = useState<"live" | "settled" | "expired">("live");
  const [shown, setShown] = useState(10);

  const load = useCallback(() => {
    fetch(`${API_BASE}/contests`)
      .then((r) => r.json())
      .then((d) => {
        setTiers(d.tiers ?? []);
        setRecent(d.recent ?? []);
        setOpen(d.open ?? []);
        setHistory(d.history ?? []);
        setAutopilot(!!d.autopilot);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  // A one-second clock so the join countdowns tick.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
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

  const create = useCallback(
    async (kind: string) => {
      // General and challenge are platform-seeded: a platform reward, free entry. Duels and
      // custom events carry the creator's tUSDC stake as the entry.
      const staked = kind === "duel" || kind === "custom";
      // Opening a contest is an on-chain transaction, so it takes a handful of seconds. It used to
      // say "Opening a contest…" and then sit there in silence, which reads as a hang rather than
      // as work: say what is happening, disable the buttons so nobody fires a second one, and
      // confirm when it actually lands.
      setPending(kind);
      setMsg("Opening the contest on Sui… this is a transaction, give it a few seconds.");
      try {
        await fetch(`${API_BASE}/contests/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            game,
            kind,
            entryFeeUsdc: staked ? Math.max(0, stake) : 0,
            rewardUsdc: staked ? 0 : 20,
            // A custom event is the creator's own, so they set how long it stays open. The
            // platform's default window is a demo window and closes in seconds, which is far too
            // short for anyone to actually find the contest and enter it.
            ...(KINDS.find((k) => k.id === kind)?.window ? { joinSeconds: Math.max(30, joinMinutes * 60) } : {}),
          }),
        });
        const label = KINDS.find((k) => k.id === kind)?.name ?? "Contest";
        setMsg(`${label} is open. It is in Live below — join it with your agent, or watch it run.`);
        await load();
        setTimeout(() => setMsg(""), 6000);
      } catch {
        setMsg("Could not open the contest. Check the backend is reachable and try again.");
      } finally {
        setPending("");
      }
    },
    [game, stake, joinMinutes, load],
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
        // Pay exactly the entry fee (0 for free contests), so the wallet shows the real cost
        // instead of the whole coin as a worst-case outflow. The contract splits the fee and
        // returns the rest anyway, but this keeps the prompt honest.
        const feeMist = BigInt(Math.round((ct.entryFee || 0) * 1_000_000));
        const fundCoin = coins.data.find((c) => BigInt(c.balance) >= feeMist) ?? coins.data[0]!;
        if (BigInt(fundCoin.balance) < feeMist) {
          setMsg(`Not enough tUSDC for the ${ct.entryFee} stake. Claim more from the Workshop faucet.`);
          return;
        }
        const tx = new Transaction();
        const [pay] = tx.splitCoins(tx.object(fundCoin.coinObjectId), [tx.pure.u64(feeMist)]);
        tx.moveCall({
          target: `${pkg}::contest::join`,
          arguments: [tx.object(ct.contestId), tx.object(myAgent.agentId), pay!],
        });
        signAndExecute(
          { transaction: tx },
          {
            onSuccess: () => {
              setMsg(`${myAgent.name} joined. It plays when the join window closes, or hit Run now.`);
              setWatch({
                href: `${ct.game === "poker" ? "/arena" : "/solver"}?contest=${ct.contestId}`,
                label: `Watch live in the ${ct.game === "poker" ? "Arena" : "Solver"}`,
              });
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
    async (ct: OpenContest) => {
      const dest = `${ct.game === "poker" ? "/arena" : "/solver"}?contest=${ct.contestId}`;
      setMsg("Running the contest…");
      try {
        await fetch(`${API_BASE}/contests/${ct.contestId}/run`, { method: "POST" });
        // Take the user straight to the live view for this contest: it streams there as it plays.
        router.push(dest);
      } catch {
        setMsg("could not run the contest");
      }
    },
    [router],
  );

  const tone = (s: number) => (s === 3 ? "signal" : s === 2 ? "peri" : "sand");

  // Split the contests three ways: live (joinable or running), settled (has a winner), and
  // expired (window closed but it never got a runnable field).
  const liveList = open.filter((c) => c.phase !== "expired");
  const expiredList = open.filter((c) => c.phase === "expired");
  const activeList = tab === "live" ? liveList : tab === "expired" ? expiredList : [];
  const counts = { live: liveList.length, settled: history.length, expired: expiredList.length };
  const switchTab = (t: "live" | "settled" | "expired") => {
    setTab(t);
    setShown(10);
  };

  return (
    <div className="page">
      <header className="hero-section">
        <div className="hero-text">
          <div className="kicker-row">
            <span className="kicker-sq" />
            <span className="kicker-label">Contests</span>
          </div>
          <h1 className="display-heading">
            The wheel turns
          </h1>
          <p className="hero-sub">
            Two steps: <b>open a contest</b> with the bar below, then <b>join it</b> (or any live one) with your agent in
            the <b>Live</b> tab. The winner takes the pool in <b>tUSDC</b>. Challenge and general are platform-funded and
            free to enter; duels and custom carry a stake you set.
          </p>
        </div>
      </header>

      <main className="arena">
        <div className="panel-label">Step 1 · open a contest (pick a game and a kind, it appears in Live below)</div>
        <div className="ct-open-bar">
          <div className="ct-bar-top">
            <div className="ct-game-toggle" role="group" aria-label="Game">
              <button className={game === "solver" ? "on" : ""} onClick={() => setGame("solver")}>
                Solver
              </button>
              <button className={game === "poker" ? "on" : ""} onClick={() => setGame("poker")}>
                Poker
              </button>
            </div>
            <span className="ct-group-label">Pick a game, then a kind. Each card says who you play and who pays.</span>
          </div>

          {/* The four kinds, as cards. They used to be a row of buttons whose only explanation lived
              in a title tooltip, so the difference between a Duel and a Custom event was invisible
              unless you hovered and waited. What anyone actually needs to know before clicking is
              the same three things every time: who you play, who pays, and who takes the pool. */}
          <div className="ct-kindgrid">
            {KINDS.map((k) => (
              <div key={k.id} className={`ct-kindcard ${pending === k.id ? "busy" : ""}`}>
                <div className="ct-kindcard-name">{k.name}</div>
                <div className="ct-kindcard-line">{k.who}</div>
                <div className="ct-kindcard-line muted">{k.pays}</div>

                {k.staked && (
                  <label className="ct-stake">
                    <span className="ct-stake-label">stake</span>
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
                )}
                {k.window && (
                  <label className="ct-stake">
                    <span className="ct-stake-label">open for</span>
                    <input
                      type="number"
                      min={1}
                      max={1440}
                      value={joinMinutes}
                      onChange={(e) => setJoinMinutes(Math.max(1, Number(e.target.value) || 1))}
                      aria-label="How long the contest stays open, in minutes"
                    />
                    <span>min</span>
                  </label>
                )}

                <button className="ws-mini" onClick={() => create(k.id)} disabled={pending !== ""}>
                  {pending === k.id ? "Opening…" : "Open"}
                </button>
              </div>
            ))}
          </div>
          {msg && (
            <span className="ct-msg">
              {msg}
              {watch && (
                <Link href={watch.href} className="ct-watch">
                  {watch.label} →
                </Link>
              )}
            </span>
          )}
        </div>

        <div className="panel-label">Step 2 · join a live contest with your agent, or open one to watch it</div>
        <div className="ct-tabs" role="tablist">
          {(["live", "settled", "expired"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`ct-tab${tab === t ? " on" : ""}`}
              onClick={() => switchTab(t)}
            >
              <span className="ct-tab-name">{t}</span>
              <span className="ct-tab-count">{counts[t]}</span>
            </button>
          ))}
        </div>

        <div className="tile canvas ct-recent">
          {!loaded ? (
            <div className="ct-empty">Loading contests…</div>
          ) : tab === "settled" ? (
            history.length === 0 ? (
              <div className="ct-empty">No finished contests yet. Open one and run it, or join a live one.</div>
            ) : (
              <>
                {history.slice(0, shown).map((h, i) => (
                  <div key={`${h.contestId}-${i}`} className="ct-row">
                    <span className="ct-row-event">
                      <SuiscanLink kind="object" id={h.contestId} label={shortId(h.contestId)} className="ct-hash" />{" "}
                      <span className="ct-time">{timeAgo(h.at, now)}</span>
                    </span>
                    <span className="ct-row-winner">
                      {h.winner} won
                      {h.platform && <PlatformBadge small />}
                    </span>
                    <span className="ct-row-prize">{h.prize} tUSDC</span>
                  </div>
                ))}
                {history.length > shown && (
                  <button className="show-more" onClick={() => setShown((n) => n + 10)}>
                    Show more ({history.length - shown})
                  </button>
                )}
              </>
            )
          ) : activeList.length === 0 ? (
            <div className="ct-empty">
              {tab === "live"
                ? "No live contests. Open one above, then join with your agent."
                : "No expired contests. A contest expires only if its window closes without a runnable field."}
            </div>
          ) : (
            <>
              {activeList.slice(0, shown).map((ct) => (
                <div key={ct.contestId} className="ct-open-row">
                  <span className="ct-open-meta">
                    <span className="ct-badge s1">{ct.game}</span>
                    <span className="ct-kind">{ct.format}</span>
                    {ct.difficulty && (
                      <span className={`ct-diff ${ct.difficulty.toLowerCase()}`} title={`${ct.difficulty} difficulty`}>
                        {ct.difficulty}
                      </span>
                    )}
                    {ct.format === "general" && <PlatformBadge small />}
                    {ct.phase === "joining" ? (
                      ct.endsAt ? (
                        <span className="ct-countdown" title="Time left to join before the contest runs">
                          joining · {countdown(ct.endsAt, now)}
                        </span>
                      ) : (
                        <span className="ct-running open">open</span>
                      )
                    ) : ct.phase === "expired" ? (
                      <span className="ct-running expired">expired</span>
                    ) : (
                      <span className="ct-running">running</span>
                    )}
                    · {ct.entrants}/{ct.maxEntries} in · {ct.entryFee > 0 ? `stake ${ct.entryFee} tUSDC` : "free entry"} ·
                    pool {ct.pool} tUSDC · L{ct.levelMin}-{ct.levelMax}
                  </span>
                  {ct.phase === "joining" ? (
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
                        onClick={() => run(ct)}
                        disabled={ct.entrants === 0}
                        title={
                          ct.entrants === 0
                            ? "Join with an agent first; an empty contest expires when its window closes"
                            : "Skip the wait and run this contest now, then watch it live"
                        }
                      >
                        Run now
                      </button>
                    </span>
                  ) : ct.phase === "running" ? (
                    <span className="ct-open-actions">
                      <Link
                        href={`${ct.game === "poker" ? "/arena" : "/solver"}?contest=${ct.contestId}`}
                        className="ws-mini primary"
                        title="Watch this contest play out live, even if your agent is not in it"
                      >
                        Watch live →
                      </Link>
                    </span>
                  ) : null}
                </div>
              ))}
              {activeList.length > shown && (
                <button className="show-more" onClick={() => setShown((n) => n + 10)}>
                  Show more ({activeList.length - shown})
                </button>
              )}
            </>
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

      </main>
    </div>
  );
}
