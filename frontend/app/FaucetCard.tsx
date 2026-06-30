"use client";

import { useCallback, useEffect, useState } from "react";
import { useCurrentAccount, useSuiClientQuery } from "@mysten/dapp-kit";
import { API_BASE } from "./feed";

// The tUSDC balance and faucet, in the Workshop. The faucet drips a little, twice a week,
// so winning contests is what actually grows a balance.
export default function FaucetCard() {
  const account = useCurrentAccount();
  const [pkg, setPkg] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  // remaining claims this week (null = not yet loaded); retryAt = when the cap resets (ms).
  const [remaining, setRemaining] = useState<number | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/status`)
      .then((r) => r.json())
      .then((d) => setPkg(d.arenaPackage || ""))
      .catch(() => {});
  }, []);

  // Load the durable claim status for this wallet, so the button stays disabled after the weekly
  // cap is hit (it does not re-open on a refresh or a backend restart; the cap lives in the DB).
  const loadStatus = useCallback(() => {
    if (!account) return;
    fetch(`${API_BASE}/faucet/status?address=${account.address}`)
      .then((r) => r.json())
      .then((d) => {
        if (typeof d.remaining === "number") setRemaining(d.remaining);
        setRetryAt(d.retryAt ?? null);
      })
      .catch(() => {});
  }, [account]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const capped = remaining !== null && remaining <= 0;
  const resetText = retryAt ? new Date(retryAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";

  const coinType = pkg ? `${pkg}::test_usdc::TEST_USDC` : "";
  const enabled = !!(account && coinType);
  const balQ = useSuiClientQuery(
    "getBalance",
    { owner: account?.address ?? "0x0", coinType: coinType || "0x2::sui::SUI" },
    { enabled },
  );
  const balance = enabled && balQ.data ? Number(balQ.data.totalBalance) / 1e6 : 0;

  const claim = useCallback(async () => {
    if (!account) return;
    setBusy(true);
    setMsg("");
    // Never hang on "Claiming…": abort the request if the mint takes too long, so the button
    // always returns to a usable state.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 95_000);
    try {
      const r = await fetch(`${API_BASE}/faucet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: account.address }),
        signal: ac.signal,
      });
      const d = await r.json();
      if (d.ok) {
        if (typeof d.remaining === "number") setRemaining(d.remaining);
        setMsg(`Claimed ${d.amount} tUSDC. ${d.remaining} claim${d.remaining === 1 ? "" : "s"} left this week.`);
        setTimeout(() => {
          balQ.refetch();
          loadStatus();
        }, 2500);
      } else {
        setMsg(d.error || "faucet failed");
        loadStatus(); // a 429 (cap hit) should immediately lock the button
      }
    } catch (e) {
      setMsg((e as Error).name === "AbortError" ? "The mint is taking a while. Check your balance, or try again." : "faucet unreachable");
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }
  }, [account, balQ, loadStatus]);

  if (!account) {
    return (
      <div className="tile felt ws-card">
        <div className="kicker">tUSDC balance</div>
        <div className="ws-empty">
          <p>Connect a wallet to see your tUSDC and claim from the faucet.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="tile felt ws-card">
      <div className="kicker">tUSDC balance</div>
      <div className="ws-balance">
        <span className="ws-balance-n">{balance.toLocaleString()}</span>
        <span className="ws-balance-u">tUSDC</span>
      </div>
      <p className="ws-faucet-note">
        The in-app currency for contest entries and duels. The faucet drips a little, twice a week, so winning is what
        grows your balance.
      </p>
      <button
        className={`hero-cta ws-faucet-btn${capped ? " done" : ""}`}
        onClick={claim}
        disabled={busy || capped}
        title="The platform mints 25 tUSDC straight to your wallet. No signature or gas. Twice a week."
      >
        {capped ? "Weekly limit reached" : busy ? "Claiming…" : "Claim 25 tUSDC"}
      </button>
      {msg ? (
        <div className="ws-faucet-msg">{msg}</div>
      ) : capped && resetText ? (
        <div className="ws-faucet-msg">Both claims used this week. Resets {resetText}.</div>
      ) : remaining !== null ? (
        <div className="ws-faucet-msg">{remaining} of 2 claims left this week.</div>
      ) : null}
    </div>
  );
}
