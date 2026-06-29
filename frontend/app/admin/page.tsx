"use client";

import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "../feed";

// Backend health check, gated by the in-memory admin token. One screen to see whether the
// model gateway (Conduit), RPC, DB, and coordinator funds are healthy, and to spot stuck
// contests. Read-only; the token is kept in localStorage for convenience.

interface Probe {
  ok: boolean;
  configured?: boolean;
  label?: string;
  latencyMs?: number;
  error?: string;
}
interface Diag {
  ok: boolean;
  at: number;
  providers: { primary: string; conduit: Probe; openrouter: Probe; mode: string };
  coordinator: { address?: string; sui?: number; wal?: number; walEnoughForAnchor?: boolean; anchorsLeft?: number; tusdc?: number; error?: string };
  rpc: { ok: boolean; latencyMs?: number; chain?: string; url?: string; error?: string };
  db: { available?: boolean; ok?: boolean; error?: string };
  contests: { open?: number; byPhase?: Record<string, number>; list?: { id: string; game: string; entrants: number; real: number; pool: number; windowMs: number | null; phase: string }[]; error?: string };
  autopilot: { enabled: boolean; windows: number[][] };
  features: Record<string, boolean>;
}

function Dot({ ok }: { ok: boolean }) {
  return <span className={`adm-dot ${ok ? "ok" : "bad"}`} />;
}
function Row({ ok, label }: { ok?: boolean; label: string }) {
  return (
    <div className="adm-row">
      {ok !== undefined && <Dot ok={ok} />}
      <span>{label}</span>
    </div>
  );
}

export default function AdminPage() {
  const [token, setToken] = useState("");
  const [data, setData] = useState<Diag | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    try {
      setToken(localStorage.getItem("telt-admin-token") || "");
    } catch {
      /* ignore */
    }
  }, []);

  const load = useCallback(async (t: string) => {
    if (!t) return;
    setLoading(true);
    setErr("");
    try {
      const r = await fetch(`${API_BASE}/admin/diagnostics?token=${encodeURIComponent(t)}`);
      if (r.status === 401) {
        setErr("Unauthorized — check the admin token (ADMIN_TOKEN in the backend .env).");
        setData(null);
        return;
      }
      setData((await r.json()) as Diag);
    } catch {
      setErr("Could not reach the backend.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    load(token);
    const id = setInterval(() => load(token), 10000);
    return () => clearInterval(id);
  }, [token, load]);

  const submit = () => {
    try {
      localStorage.setItem("telt-admin-token", token);
    } catch {
      /* ignore */
    }
    load(token);
  };

  return (
    <div className="adm">
      <header className="adm-head">
        <div>
          <div className="adm-kicker">Telt · backend health</div>
          {data && (
            <div className={`adm-overall ${data.ok ? "ok" : "bad"}`}>
              <Dot ok={data.ok} /> {data.ok ? "All systems healthy" : "Issues detected"}
              <span className="adm-time">checked {new Date(data.at).toLocaleTimeString()}{loading ? " · refreshing…" : ""}</span>
            </div>
          )}
        </div>
        <div className="adm-auth">
          <input
            type="password"
            placeholder="admin token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button onClick={submit}>Check</button>
        </div>
      </header>

      {err && <div className="adm-err">{err}</div>}
      {!data && !err && <div className="adm-empty">Enter the admin token to run a health check.</div>}

      {data && (
        <div className="adm-grid">
          <div className="adm-card">
            <h2>Model gateway</h2>
            <Row label={`Primary: ${data.providers.primary} · mode ${data.providers.mode}`} />
            <Row
              ok={data.providers.conduit.ok}
              label={`${data.providers.conduit.label ?? "primary"}: ${
                !data.providers.conduit.configured
                  ? "no key"
                  : data.providers.conduit.ok
                    ? `responding (${data.providers.conduit.latencyMs}ms)`
                    : data.providers.conduit.error || "down"
              }`}
            />
            <Row
              ok={data.providers.openrouter.ok}
              label={`openrouter: ${
                !data.providers.openrouter.configured
                  ? "no key"
                  : data.providers.openrouter.ok
                    ? `responding (${data.providers.openrouter.latencyMs}ms)`
                    : data.providers.openrouter.error || "down"
              }`}
            />
          </div>

          <div className="adm-card">
            <h2>Coordinator funds</h2>
            {data.coordinator.error ? (
              <Row ok={false} label={data.coordinator.error} />
            ) : (
              <>
                <Row ok={(data.coordinator.sui ?? 0) > 0.1} label={`SUI: ${data.coordinator.sui}`} />
                <Row
                  ok={!!data.coordinator.walEnoughForAnchor}
                  label={`WAL: ${data.coordinator.wal} (${data.coordinator.anchorsLeft} anchors left)`}
                />
                <Row label={`tUSDC: ${data.coordinator.tusdc}`} />
                <div className="adm-sub">{data.coordinator.address}</div>
              </>
            )}
          </div>

          <div className="adm-card">
            <h2>Infrastructure</h2>
            <Row ok={data.rpc.ok} label={`Sui RPC: ${data.rpc.ok ? `OK (${data.rpc.latencyMs}ms)` : data.rpc.error || "down"}`} />
            <Row
              ok={!!data.db.ok}
              label={`Database: ${data.db.ok ? "OK" : data.db.error || "unreachable (optional)"}`}
            />
            <Row ok={data.autopilot.enabled} label={`Autopilot: ${data.autopilot.enabled ? "on" : "off"}`} />
          </div>

          <div className="adm-card">
            <h2>Features</h2>
            {Object.entries(data.features).map(([k, v]) => (
              <Row key={k} ok={v} label={k} />
            ))}
          </div>

          <div className="adm-card adm-wide">
            <h2>
              Contests · {data.contests.open ?? 0} open
              {data.contests.byPhase && (
                <span className="adm-sub">
                  {"  "}joining {data.contests.byPhase.joining ?? 0} · running {data.contests.byPhase.running ?? 0} ·
                  expired {data.contests.byPhase.expired ?? 0}
                </span>
              )}
            </h2>
            {data.contests.error ? (
              <Row ok={false} label={data.contests.error} />
            ) : (data.contests.list?.length ?? 0) === 0 ? (
              <div className="adm-sub">No open contests.</div>
            ) : (
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>id</th>
                    <th>game</th>
                    <th>phase</th>
                    <th>entrants</th>
                    <th>pool</th>
                    <th>window</th>
                  </tr>
                </thead>
                <tbody>
                  {data.contests.list!.map((ct) => (
                    <tr key={ct.id} className={ct.phase === "expired" ? "adm-stuck" : ""}>
                      <td>{ct.id}</td>
                      <td>{ct.game}</td>
                      <td>{ct.phase}</td>
                      <td>
                        {ct.real}/{ct.entrants}
                      </td>
                      <td>{ct.pool}</td>
                      <td>{ct.windowMs === null ? "none" : `${Math.max(0, Math.round(ct.windowMs / 1000))}s`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
