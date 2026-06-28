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

  useEffect(() => {
    fetch(`${API_BASE}/status`)
      .then((r) => r.json())
      .then((d) => setPkg(d.arenaPackage || ""))
      .catch(() => {});
  }, []);

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
    try {
      const r = await fetch(`${API_BASE}/faucet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: account.address }),
      });
      const d = await r.json();
      if (d.ok) {
        setMsg(`Claimed ${d.amount} tUSDC. ${d.remaining} claim${d.remaining === 1 ? "" : "s"} left this week.`);
        setTimeout(() => balQ.refetch(), 2500);
      } else {
        setMsg(d.error || "faucet failed");
      }
    } catch {
      setMsg("faucet unreachable");
    } finally {
      setBusy(false);
    }
  }, [account, balQ]);

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
        className="hero-cta ws-faucet-btn"
        onClick={claim}
        disabled={busy}
        title="The platform mints 25 tUSDC straight to your wallet. No signature or gas. Twice a week."
      >
        {busy ? "Claiming…" : "Claim 25 tUSDC"}
      </button>
      {msg && <div className="ws-faucet-msg">{msg}</div>}
    </div>
  );
}
