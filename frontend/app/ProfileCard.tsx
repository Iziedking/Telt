"use client";

import { useCallback, useEffect, useState } from "react";
import { useCurrentAccount, useSignAndExecuteTransaction } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { API_BASE } from "./feed";

// The profile: your agent's name, avatar, and record. The name is editable but scarce, so
// renaming is rate limited on chain (at most three in a lifetime, one every 30 days), and
// unique across the arena. The avatar is generated from the agent id for now.
const COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RENAMES = 3;
const PALETTE = ["#A8E0C2", "#C7C9F2", "#BFE0F2", "#F1E7CE", "#E8352B"];
function avatarColor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

interface Agent {
  agentId: string;
  name: string;
  level: number;
  wins: number;
  losses: number;
  renameCount: number;
  lastRenameMs: number;
}

export default function ProfileCard() {
  const account = useCurrentAccount();
  const { mutate: signAndExecute, isPending } = useSignAndExecuteTransaction();
  const [pkg, setPkg] = useState("");
  const [registry, setRegistry] = useState("");
  const [agent, setAgent] = useState<Agent | null>(null);
  const [newName, setNewName] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/status`)
      .then((r) => r.json())
      .then((d) => {
        setPkg(d.arenaPackage || "");
        setRegistry(d.arenaNameRegistry || "");
      })
      .catch(() => {});
  }, []);

  const load = useCallback(() => {
    if (!account) {
      setAgent(null);
      return;
    }
    fetch(`${API_BASE}/agents?owner=${account.address}`)
      .then((r) => r.json())
      .then((d) => {
        const a: Agent | null = (d.agents ?? [])[0] ?? null;
        setAgent(a);
        setNewName(a?.name ?? "");
      })
      .catch(() => {});
  }, [account]);
  useEffect(() => {
    load();
  }, [load]);

  const renamesLeft = agent ? Math.max(0, MAX_RENAMES - agent.renameCount) : 0;
  const cooldownLeftMs = agent ? Math.max(0, agent.lastRenameMs + COOLDOWN_MS - Date.now()) : 0;
  const canRename = !!agent && renamesLeft > 0 && cooldownLeftMs === 0;

  const save = useCallback(async () => {
    if (!agent || !pkg || !registry) return;
    const wanted = newName.trim();
    if (!wanted || wanted.toLowerCase() === agent.name.toLowerCase()) {
      setMsg("Pick a new name.");
      return;
    }
    setBusy(true);
    setMsg("Checking the name…");
    try {
      const avail = await fetch(`${API_BASE}/name-available?name=${encodeURIComponent(wanted)}`).then((r) => r.json());
      if (avail.available === false) {
        setMsg(`"${wanted}" is taken. Names are unique, pick another.`);
        setBusy(false);
        return;
      }
      const tx = new Transaction();
      tx.moveCall({
        target: `${pkg}::registry::rename`,
        arguments: [
          tx.object(agent.agentId),
          tx.object(registry),
          tx.pure.vector("u8", Array.from(new TextEncoder().encode(wanted))),
          tx.object("0x6"),
        ],
      });
      signAndExecute(
        { transaction: tx },
        {
          onSuccess: () => {
            setMsg("Name updated.");
            setBusy(false);
            setTimeout(load, 2500);
          },
          onError: (e) => {
            setMsg(e.message || "rename failed");
            setBusy(false);
          },
        },
      );
    } catch (e) {
      setMsg((e as Error).message || "rename failed");
      setBusy(false);
    }
  }, [agent, pkg, registry, newName, signAndExecute, load]);

  if (!account) {
    return (
      <div className="tile peri ws-card">
        <div className="kicker">Profile</div>
        <div className="ws-empty">
          <p>Connect a wallet to set your agent's name and avatar and see its record.</p>
        </div>
      </div>
    );
  }
  if (!agent) {
    return (
      <div className="tile peri ws-card">
        <div className="kicker">Profile</div>
        <div className="ws-empty">
          <p>No agent yet. Claim one in Your agent, then set up its profile here.</p>
        </div>
      </div>
    );
  }

  const days = Math.ceil(cooldownLeftMs / (24 * 60 * 60 * 1000));
  return (
    <div className="tile peri ws-card">
      <div className="kicker">Profile</div>
      <div className="pf-head">
        <span className="pf-avatar" style={{ background: avatarColor(agent.agentId) }}>
          {agent.name.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <div className="pf-name">{agent.name}</div>
          <div className="pf-rec">
            {agent.wins}W · {agent.losses}L
          </div>
        </div>
      </div>
      <div className="pf-rename">
        <input
          className="ws-input"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          maxLength={24}
          disabled={!canRename}
          aria-label="Agent name"
        />
        <button className="ws-mini primary" onClick={save} disabled={!canRename || busy || isPending}>
          {busy ? "Saving…" : "Save name"}
        </button>
      </div>
      <div className="pf-note">
        {renamesLeft === 0
          ? "No name changes left."
          : cooldownLeftMs > 0
            ? `Next name change in ${days} day${days === 1 ? "" : "s"}.`
            : `${renamesLeft} name change${renamesLeft === 1 ? "" : "s"} left, one every 30 days. Names are unique.`}
      </div>
      {msg && <div className="ws-faucet-msg">{msg}</div>}
    </div>
  );
}
