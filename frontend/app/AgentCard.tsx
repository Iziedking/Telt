"use client";

import { useCallback, useEffect, useState } from "react";
import { useCurrentAccount, useSignAndExecuteTransaction } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { API_BASE } from "./feed";

// Your agent, owned by the connected wallet. Claim provisions a mandate on the backend
// (Avow + coordinator key) and the wallet signs the claim, so the agent is owned on chain.
// Register and Upgrade are wallet-signed too; Upgrade pays SUI to the treasury.
const TIERS = ["Mark", "Reader", "Spotter", "Profiler", "Oracle"];
const tierName = (l: number) => TIERS[Math.min(Math.max(l, 0), 4)] ?? "Mark";
const UPGRADE_MIST = [1_000_000_000n, 2_500_000_000n, 6_000_000_000n, 15_000_000_000n];
const COST_LABEL = ["1 SUI", "2.5 SUI", "6 SUI", "15 SUI"];

interface Agent {
  agentId: string;
  name: string;
  level: number;
  wins: number;
  losses: number;
  registered: boolean;
}

export default function AgentCard() {
  const account = useCurrentAccount();
  const { mutate: signAndExecute, isPending } = useSignAndExecuteTransaction();
  const [pkg, setPkg] = useState("");
  const [treasury, setTreasury] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/status`)
      .then((r) => r.json())
      .then((d) => {
        setPkg(d.arenaPackage || "");
        setTreasury(d.arenaTreasury || "");
      })
      .catch(() => {});
  }, []);

  const load = useCallback(() => {
    if (!account) {
      setAgents([]);
      return;
    }
    fetch(`${API_BASE}/agents?owner=${account.address}`)
      .then((r) => r.json())
      .then((d) => setAgents(d.agents ?? []))
      .catch(() => {});
  }, [account]);
  useEffect(() => {
    load();
  }, [load]);

  const claim = useCallback(async () => {
    if (!account || !pkg) return;
    setBusy(true);
    setMsg("Provisioning a mandate…");
    try {
      const res = await fetch(`${API_BASE}/provision-mandate`, { method: "POST" }).then((r) => r.json());
      if (!res.mandateId) {
        setMsg(res.error || "could not provision a mandate");
        setBusy(false);
        return;
      }
      const tx = new Transaction();
      tx.moveCall({
        target: `${pkg}::registry::claim_agent`,
        arguments: [
          tx.pure.vector("u8", Array.from(new TextEncoder().encode(name.trim() || "My Agent"))),
          tx.pure.id(res.mandateId),
        ],
      });
      signAndExecute(
        { transaction: tx },
        {
          onSuccess: () => {
            setMsg("Agent claimed. It is yours on chain.");
            setBusy(false);
            setTimeout(load, 2500);
          },
          onError: (e) => {
            setMsg(e.message || "claim failed");
            setBusy(false);
          },
        },
      );
    } catch (e) {
      setMsg((e as Error).message || "claim failed");
      setBusy(false);
    }
  }, [account, pkg, name, signAndExecute, load]);

  const register = useCallback(
    (a: Agent) => {
      if (!pkg) return;
      const tx = new Transaction();
      tx.moveCall({ target: `${pkg}::registry::register_for_arena`, arguments: [tx.object(a.agentId)] });
      signAndExecute(
        { transaction: tx },
        {
          onSuccess: () => {
            setMsg(`${a.name} registered for the arena.`);
            setTimeout(load, 2500);
          },
          onError: (e) => setMsg(e.message || "register failed"),
        },
      );
    },
    [pkg, signAndExecute, load],
  );

  const upgrade = useCallback(
    (a: Agent) => {
      if (!pkg || !treasury || a.level >= 4) return;
      const cost = UPGRADE_MIST[a.level]!;
      const tx = new Transaction();
      const [pay] = tx.splitCoins(tx.gas, [tx.pure.u64(cost)]);
      tx.moveCall({
        target: `${pkg}::registry::upgrade`,
        arguments: [tx.object(a.agentId), pay, tx.object(treasury)],
      });
      signAndExecute(
        { transaction: tx },
        {
          onSuccess: () => {
            setMsg(`${a.name} upgraded to ${tierName(a.level + 1)}.`);
            setTimeout(load, 2500);
          },
          onError: (e) => setMsg(e.message || "upgrade failed"),
        },
      );
    },
    [pkg, treasury, signAndExecute, load],
  );

  if (!account) {
    return (
      <div className="tile sand ws-card">
        <div className="kicker">Your agent</div>
        <div className="ws-empty">
          <p>Connect a wallet to claim an agent, register it for the arena, and upgrade its tier.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="tile sand ws-card">
      <div className="kicker">Your agent</div>
      {agents.length === 0 ? (
        <div className="ws-claim">
          <p className="ws-empty">No agent yet. Claim one and it is yours on chain.</p>
          <input
            className="ws-input"
            placeholder="Name your agent"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={24}
          />
          <button className="hero-cta ws-faucet-btn" onClick={claim} disabled={busy || isPending}>
            {busy ? "Claiming…" : "Claim an agent"}
          </button>
        </div>
      ) : (
        agents.map((a) => (
          <div key={a.agentId} className="ws-agent">
            <div className="ws-agent-top">
              <span className="ws-agent-name">{a.name}</span>
              <span className="ws-agent-tier">
                {tierName(a.level)} · L{a.level}
              </span>
            </div>
            <div className="ws-agent-rec">
              {a.wins}W · {a.losses}L · {a.registered ? "registered" : "not registered"}
            </div>
            <div className="ws-agent-actions">
              {!a.registered && (
                <button className="ws-mini" onClick={() => register(a)} disabled={isPending}>
                  Register
                </button>
              )}
              {a.level < 4 && (
                <button className="ws-mini primary" onClick={() => upgrade(a)} disabled={isPending}>
                  Upgrade to {tierName(a.level + 1)} · {COST_LABEL[a.level]}
                </button>
              )}
            </div>
          </div>
        ))
      )}
      {msg && <div className="ws-faucet-msg">{msg}</div>}
    </div>
  );
}
