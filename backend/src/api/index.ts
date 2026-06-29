import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { config, memoryConfigured, reasonConfigured, suiConfigured } from "../config/index.js";
import { reasonMode, probeProvider } from "../reason/client.js";
import { firecrawlUsage } from "../solver/sources.js";
import { attachWebSocket } from "../coordinator/ws.js";
import { intelRoutes } from "../intel/market.js";
import {
  agentMandateId,
  faucetMintUsdc,
  sui,
  createMandateAndAccess,
  coordinatorAddress,
  createContest,
  fundContest,
  readContests,
  CONTEST_FORMAT,
} from "../chain/sui.js";
import { loadRoster } from "../coordinator/roster.js";
import { verifyByBlob } from "../avow/anchorMove.js";
import { playMatch } from "../coordinator/table.js";
import { playSolverMatch } from "../coordinator/solverMatch.js";
import { provisionAgentEntry, type Participant } from "../coordinator/provision.js";
import { runContest } from "../coordinator/runContest.js";
import {
  customContests,
  challengeContests,
  openContestWindow,
  closeContestWindow,
  contestEndsAt,
  contestDifficulty,
} from "../coordinator/contestKinds.js";
import { runAutopilotCycle, recentContests, difficultyTiers, autopilotEnabled } from "../coordinator/autopilot.js";
import { query, dbAvailable } from "../db/pool.js";

// The read API and the WS live feed. Routes are intentionally thin: health, a status
// probe that never leaks secrets, and read-back of matches and moves for the frontend.
// The live action streams over /ws (see coordinator/ws.ts). Ported and trimmed from
// Zerun's api/index.ts.

export const app = new Hono();

// The frontend dev server runs on another port, so allow cross-origin reads.
app.use("*", cors());

// The intel marketplace 402 quote endpoint.
intelRoutes(app);

app.get("/health", (c) => c.json({ ok: true }));

// The verify reveal: do the real check on demand for one anchored move (by Walrus blob
// id), or the agent's latest. Never trusts a cached flag.
app.get("/verify/agent/:agentId", async (c) => {
  const agentId = c.req.param("agentId");
  const blob = c.req.query("blob");
  try {
    const mandateId = await agentMandateId(agentId);
    const v = await verifyByBlob(mandateId, blob);
    if (!v) return c.json({ error: "no anchored record found" }, 404);
    return c.json(v);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

// Kick a demo match in the background; the live action streams over /ws. The underdog
// (seat A) buys intel before the second hand by default.
let running = false;
app.post("/match", (c) => {
  if (running) return c.json({ started: false, reason: "a match is already running" });
  running = true;
  // ?with=<agentId> seats the caller's own agent against the top platform agent.
  const withAgent = c.req.query("with") || "";
  void (async () => {
    if (/^0x[0-9a-f]{1,64}$/.test(withAgent)) {
      const roster = loadRoster().agents;
      const opponent = roster[roster.length - 1]!;
      const me = await provisionAgentEntry(withAgent, "A");
      const participants: Participant[] = [me, { ...opponent, key: "B" }];
      await playMatch({ participants });
    } else {
      await playMatch({ intel: { buyerSeat: "A", beforeHand: 1 } });
    }
  })()
    .catch((e) => console.error("match failed:", (e as Error).message))
    .finally(() => {
      running = false;
    });
  return c.json({ started: true, withAgent: withAgent || null });
});

// Kick a solver match in the background: live puzzles, both agents answer, anchored on
// Walrus, scored, recorded. Progress streams over /ws. ?puzzles=N sets the count.
let solverRunning = false;
app.post("/solver", (c) => {
  if (solverRunning) return c.json({ started: false, reason: "a solver match is already running" });
  solverRunning = true;
  const puzzles = Math.max(1, Math.min(20, Number(c.req.query("puzzles") ?? "10")));
  // ?with=<agentId> seats the caller's own agent against the top platform agent, so a user
  // can test their agent against the house. Without it, two platform agents play.
  const withAgent = c.req.query("with") || "";
  void (async () => {
    let participants: Participant[] | undefined;
    if (/^0x[0-9a-f]{1,64}$/.test(withAgent)) {
      const roster = loadRoster().agents;
      const opponent = roster[roster.length - 1]!; // the strongest platform agent: a real test
      const me = await provisionAgentEntry(withAgent, "A");
      participants = [me, { ...opponent, key: "B" }];
    }
    await playSolverMatch({ puzzles, participants });
  })()
    .catch((e) => console.error("solver match failed:", (e as Error).message))
    .finally(() => {
      solverRunning = false;
    });
  return c.json({ started: true, puzzles, withAgent: withAgent || null });
});

// Run a specific contest: seat its entrants (adding platform house fillers for general
// contests, never for duels), play the game, and settle the pool to the winner.
app.post("/contests/:id/run", (c) => {
  const id = c.req.param("id");
  if (!/^0x[0-9a-f]{1,64}$/.test(id)) return c.json({ error: "invalid contest id" }, 400);
  // Run now closes the join window first, so the match starts from a closed window (no agent
  // answers while a countdown is still showing).
  closeContestWindow(id);
  void runContest(id).catch((e) => console.error("contest run failed:", (e as Error).message));
  return c.json({ started: true, contestId: id });
});

// tUSDC faucet: a modest drip, claimable twice a week per wallet. Kept small on purpose so
// tUSDC stays scarce and winning contests is what actually grows a balance. (In-memory rate
// limit; a restart resets it. Move to the DB for a persistent limit later.)
const FAUCET_CLAIM_USDC = 25;
const FAUCET_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const FAUCET_MAX_CLAIMS = 2;
const faucetClaims = new Map<string, number[]>();
app.post("/faucet", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const address = String(body.address ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{1,64}$/.test(address)) return c.json({ error: "invalid address" }, 400);
  const now = Date.now();
  const claims = (faucetClaims.get(address) ?? []).filter((t) => now - t < FAUCET_WINDOW_MS);
  if (claims.length >= FAUCET_MAX_CLAIMS) {
    return c.json({ error: "faucet limit reached: twice a week", retryAt: claims[0]! + FAUCET_WINDOW_MS, remaining: 0 }, 429);
  }
  try {
    const digest = await faucetMintUsdc(address, BigInt(FAUCET_CLAIM_USDC) * 1_000_000n);
    claims.push(now);
    faucetClaims.set(address, claims);
    return c.json({ ok: true, address, amount: FAUCET_CLAIM_USDC, digest, remaining: FAUCET_MAX_CLAIMS - claims.length });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

// Run one autopilot event now: open a contest, seat the agents, play, settle the pool.
// Runs in the background; progress streams over /ws and the console.
app.post("/autopilot/run", (c) => {
  void runAutopilotCycle().catch((e) => console.error("autopilot:", (e as Error).message));
  return c.json({ started: true });
});

// The agents a wallet owns. Agent objects are shared, so we read the AgentClaimed events
// for this owner and then the live state of each agent.
app.get("/agents", async (c) => {
  const owner = (c.req.query("owner") || "").toLowerCase();
  if (!/^0x[0-9a-f]{1,64}$/.test(owner)) return c.json({ agents: [] });
  try {
    const ev = await sui.queryEvents({
      query: { MoveEventType: `${config.arena.packageId}::registry::AgentClaimed` },
      limit: 50,
      order: "descending",
    });
    const mine = ev.data.filter((e: any) => String(e.parsedJson?.owner).toLowerCase() === owner);
    const agents = await Promise.all(
      mine.map(async (e: any) => {
        const id = e.parsedJson.agent as string;
        const o = (await sui.getObject({ id, options: { showContent: true } })) as any;
        const f = o.data?.content?.fields ?? {};
        return {
          agentId: id,
          name: String(f.name ?? "agent"),
          level: Number(f.level ?? 0),
          wins: Number(f.wins ?? 0),
          losses: Number(f.losses ?? 0),
          registered: Boolean(f.registered),
          renameCount: Number(f.rename_count ?? 0),
          lastRenameMs: Number(f.last_rename_ms ?? 0),
        };
      }),
    );
    return c.json({ agents });
  } catch (e) {
    return c.json({ agents: [], error: (e as Error).message });
  }
});

// Is a name free? Best-effort hint for the UI (the contract enforces uniqueness on chain).
// Reads claimed names from the AgentClaimed events and compares case-insensitively.
app.get("/name-available", async (c) => {
  const name = (c.req.query("name") || "").trim().toLowerCase();
  if (!name) return c.json({ available: false });
  try {
    const ev = await sui.queryEvents({
      query: { MoveEventType: `${config.arena.packageId}::registry::AgentClaimed` },
      limit: 200,
      order: "descending",
    });
    const taken = new Set<string>();
    for (const e of ev.data) {
      const id = (e as any).parsedJson?.agent as string | undefined;
      if (!id) continue;
      const o = (await sui.getObject({ id, options: { showContent: true } })) as any;
      const n = String(o.data?.content?.fields?.name ?? "").toLowerCase();
      if (n) taken.add(n);
    }
    return c.json({ available: !taken.has(name) });
  } catch (e) {
    return c.json({ available: true, error: (e as Error).message });
  }
});

// Provision an Avow mandate so a wallet can claim its own agent. Mandate creation needs
// the Avow SDK and the coordinator key, so the backend does it; the user then signs the
// claim with their wallet, owning the agent. (The coordinator stays the anchoring agent.)
app.post("/provision-mandate", async (c) => {
  try {
    const m = await createMandateAndAccess({
      agent: coordinatorAddress(),
      perMoveCap: 1_000_000_000n,
      dailyCap: 1_000_000_000_000n,
      expiryEpoch: 100000n,
      restrictTargets: false,
    });
    return c.json({ mandateId: m.mandateId });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

// Leaderboard: rank the registered agents by their on-chain record. Wins and losses are
// recorded against each Agent at settlement, so the table is backed by real results.
app.get("/leaderboard", async (c) => {
  const platformIds = new Set<string>();
  try {
    for (const a of loadRoster().agents) platformIds.add(a.agentId);
  } catch {
    /* roster not set up yet */
  }
  let rows: {
    name: string;
    level: number;
    wins: number;
    losses: number;
    games: number;
    winRate: number;
    agentId: string;
    platform: boolean;
  }[] = [];
  try {
    const ev = await sui.queryEvents({
      query: { MoveEventType: `${config.arena.packageId}::registry::AgentClaimed` },
      limit: 60,
      order: "descending",
    });
    const ids = [...new Set(ev.data.map((e) => String((e as any).parsedJson?.agent)).filter(Boolean))];
    const objs = ids.length ? ((await sui.multiGetObjects({ ids, options: { showContent: true } })) as any[]) : [];
    rows = objs
      .map((o) => {
        const id = o.data?.objectId;
        const f = o.data?.content?.fields;
        if (!id || !f) return null;
        const wins = Number(f.wins ?? 0);
        const losses = Number(f.losses ?? 0);
        const games = wins + losses;
        return {
          name: String(f.name ?? "agent"),
          level: Number(f.level ?? 0),
          wins,
          losses,
          games,
          winRate: games ? Math.round((100 * wins) / games) : 0,
          agentId: id,
          platform: platformIds.has(id),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  } catch {
    rows = [];
  }
  // Real agents rank first by record; platform (house) agents always come after, never
  // ahead of a real competitor no matter how they performed.
  rows.sort(
    (x, y) =>
      Number(x.platform) - Number(y.platform) || y.wins - x.wins || y.winRate - x.winRate || y.level - x.level,
  );
  return c.json({ rows });
});

// A wallet's winnings: contests it won. Pools are paid out on settlement, so this is a paid
// history with a running total, read live from on-chain ContestSettled events filtered to the
// owner address.
app.get("/winnings", async (c) => {
  const owner = (c.req.query("owner") || "").toLowerCase();
  if (!owner) return c.json({ rows: [], total: 0 });
  let rows: unknown[] = [];
  let total = 0;
  try {
    const sev = await sui.queryEvents({
      query: { MoveEventType: `${config.arena.packageId}::contest::ContestSettled` },
      limit: 50,
      order: "descending",
    });
    const mine = sev.data.filter((e) => String((e as any).parsedJson?.owner || "").toLowerCase() === owner);
    const winnerIds = [...new Set(mine.map((e) => String((e as any).parsedJson?.winner)).filter(Boolean))];
    const objs = winnerIds.length ? ((await sui.multiGetObjects({ ids: winnerIds, options: { showContent: true } })) as any[]) : [];
    const nameById = new Map<string, string>();
    for (const o of objs) {
      const id = o.data?.objectId;
      const nm = o.data?.content?.fields?.name;
      if (id && nm) nameById.set(id, String(nm));
    }
    rows = mine.map((e) => {
      const p = (e as any).parsedJson ?? {};
      const prize = Number(p.prize ?? 0) / 1_000_000;
      total += prize;
      return {
        contestId: String(p.contest),
        agent: nameById.get(String(p.winner)) ?? "your agent",
        prize,
        at: Number((e as any).timestampMs ?? 0),
      };
    });
  } catch {
    /* leave empty on read failure */
  }
  return c.json({ rows, total });
});

// Admin health check, gated by the in-memory ADMIN_TOKEN. One call surfaces whether each
// backend dependency is alive (the model gateway / Conduit, RPC, DB, coordinator funds) and
// flags contests that are stuck, so problems are easy to spot.
const WAL_TYPE = "0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL";
const ANCHOR_WAL_COST = 1_418_067;
app.get("/admin/diagnostics", async (c) => {
  const token = c.req.header("x-admin-token") || c.req.query("token") || "";
  if (!config.admin.token || token !== config.admin.token) return c.json({ error: "unauthorized" }, 401);

  const pkg = config.arena.packageId;
  const conduitOn = Boolean(config.reason.conduitKey);

  // Model gateways: probe the primary (Conduit when configured) and OpenRouter directly.
  const [primaryProbe, openrouterProbe] = await Promise.all([probeProvider("anthropic"), probeProvider("openrouter")]);
  const providers = {
    primary: conduitOn ? "conduit" : config.reason.anthropicKey ? "anthropic" : "openrouter",
    conduit: { ...primaryProbe, label: conduitOn ? "conduit" : "anthropic", baseUrl: conduitOn ? config.reason.conduitBaseUrl : null },
    openrouter: openrouterProbe,
    mode: reasonMode(),
  };

  // Coordinator funds: SUI for gas, WAL for anchoring, tUSDC for pools.
  let coordinator: Record<string, unknown> = { address: "", error: "not read" };
  try {
    const addr = coordinatorAddress();
    const all = await sui.getAllBalances({ owner: addr });
    const bal = (suffix: string) => Number(all.find((b) => b.coinType.endsWith(suffix))?.totalBalance ?? 0);
    const wal = bal("::wal::WAL");
    coordinator = {
      address: addr,
      sui: bal("::sui::SUI") / 1e9,
      wal,
      walEnoughForAnchor: wal >= ANCHOR_WAL_COST,
      anchorsLeft: Math.floor(wal / ANCHOR_WAL_COST),
      tusdc: bal("::test_usdc::TEST_USDC") / 1e6,
    };
  } catch (e) {
    coordinator = { address: "", error: (e as Error).message.slice(0, 200) };
  }

  // Sui RPC reachability + latency.
  let rpc: Record<string, unknown> = { ok: false };
  try {
    const t0 = Date.now();
    const ck = await sui.getChainIdentifier();
    rpc = { ok: true, latencyMs: Date.now() - t0, chain: ck, url: config.sui.rpcOverride || `default ${config.sui.network}` };
  } catch (e) {
    rpc = { ok: false, error: (e as Error).message.slice(0, 200) };
  }

  // DB (optional).
  let db: Record<string, unknown> = { available: dbAvailable() };
  try {
    await query("select 1");
    db = { available: true, ok: true };
  } catch (e) {
    db = { available: false, ok: false, error: (e as Error).message.slice(0, 120) || "unreachable" };
  }

  // Contests: how many are open, by phase, plus a list to spot stuck ones.
  let contests: Record<string, unknown> = { error: "not read" };
  try {
    const ev = await sui.queryEvents({
      query: { MoveEventType: `${pkg}::contest::ContestCreated` },
      limit: 40,
      order: "descending",
    });
    const ids = [...new Set(ev.data.map((e) => String((e as any).parsedJson?.contest)).filter(Boolean))];
    const states = (await readContests(ids)).filter((s) => s.status === 0);
    const now = Date.now();
    const list = states.map((s) => {
      const endsAt = contestEndsAt(s.contestId);
      const real = s.entrants.filter((e) => !e.isHouse).length;
      const isDuel = s.format === CONTEST_FORMAT.duel;
      let phase: string;
      if (endsAt === null) phase = "expired";
      else if (now < endsAt) phase = "joining";
      else {
        const ready = isDuel
          ? challengeContests.has(s.contestId)
            ? real >= 1
            : real >= 2
          : customContests.has(s.contestId)
            ? real >= 2
            : real >= 1;
        phase = ready ? "running" : "expired";
      }
      return {
        id: `${s.contestId.slice(0, 8)}…${s.contestId.slice(-4)}`,
        game: s.game === 1 ? "solver" : "poker",
        entrants: s.entrants.length,
        real,
        pool: Number(s.pool) / 1_000_000,
        windowMs: endsAt ? endsAt - now : null,
        phase,
      };
    });
    const byPhase = { joining: 0, running: 0, expired: 0 } as Record<string, number>;
    list.forEach((x) => (byPhase[x.phase] = (byPhase[x.phase] ?? 0) + 1));
    contests = { open: list.length, byPhase, list };
  } catch (e) {
    contests = { error: (e as Error).message.slice(0, 200) };
  }

  const overallOk =
    (providers.conduit.ok || providers.openrouter.ok) && (rpc as { ok: boolean }).ok && !(coordinator as { error?: string }).error;

  return c.json({
    ok: overallOk,
    at: Date.now(),
    providers,
    coordinator,
    rpc,
    db,
    contests,
    autopilot: { enabled: autopilotEnabled(), windows: config.autopilot.windows },
    firecrawl: { configured: Boolean(config.solver.firecrawlKey), ...firecrawlUsage() },
    features: {
      avow: Boolean(config.avow.packageId),
      memory: memoryConfigured(),
      solverExa: Boolean(config.solver.exaKey),
      solverFirecrawl: Boolean(config.solver.firecrawlKey),
      arenaConfigured: Boolean(config.arena.packageId),
    },
  });
});

// The Contests view: the difficulty tiers, recent finished missions, and the contests that
// are open right now for an agent to join. Open contests are read live from chain (any
// ContestCreated that is still status open).
app.get("/contests", async (c) => {
  let open: unknown[] = [];
  try {
    const ev = await sui.queryEvents({
      query: { MoveEventType: `${config.arena.packageId}::contest::ContestCreated` },
      limit: 20,
      order: "descending",
    });
    const ids = [...new Set(ev.data.map((e) => String((e as any).parsedJson?.contest)).filter(Boolean))];
    const states = await readContests(ids);
    open = states
      // Open, and not a stuck legacy contest already full of house-only seats (those can
      // never settle, since a house agent cannot win).
      .filter((s) => s.status === 0 && !(s.entrants.length >= s.maxEntries && s.entrants.length > 0 && s.entrants.every((e) => e.isHouse)))
      .map((s) => {
        // Three states: joining (window still open), running (window closed and the field can
        // play it out), or expired (its time has passed without a runnable field). A contest
        // whose window was lost on a restart counts as expired, so stale events never linger
        // on Live.
        const endsAt = contestEndsAt(s.contestId);
        const real = s.entrants.filter((e) => !e.isHouse).length;
        const isDuel = s.format === CONTEST_FORMAT.duel;
        let phase: "joining" | "running" | "expired";
        if (endsAt === null) {
          phase = "expired";
        } else if (Date.now() < endsAt) {
          phase = "joining";
        } else {
          const ready = isDuel
            ? challengeContests.has(s.contestId)
              ? real >= 1
              : real >= 2
            : customContests.has(s.contestId)
              ? real >= 2
              : real >= 1;
          phase = ready ? "running" : "expired";
        }
        return {
          contestId: s.contestId,
          game: s.game === 1 ? "solver" : "poker",
          format: isDuel
            ? challengeContests.has(s.contestId)
              ? "challenge"
              : "duel"
            : customContests.has(s.contestId)
              ? "custom"
              : "general",
          entryFee: Number(s.entryFee) / 1_000_000,
          pool: Number(s.pool) / 1_000_000,
          entrants: s.entrants.length,
          maxEntries: s.maxEntries,
          levelMin: s.levelMin,
          levelMax: s.levelMax,
          endsAt,
          phase,
          difficulty: contestDifficulty.get(s.contestId) ?? null,
        };
      });
  } catch {
    /* leave open empty on read failure */
  }

  // Event history: recently settled contests, newest first.
  let history: unknown[] = [];
  try {
    const sev = await sui.queryEvents({
      query: { MoveEventType: `${config.arena.packageId}::contest::ContestSettled` },
      limit: 15,
      order: "descending",
    });
    const winnerIds = [...new Set(sev.data.map((e) => String((e as any).parsedJson?.winner)).filter(Boolean))];
    const objs = winnerIds.length ? ((await sui.multiGetObjects({ ids: winnerIds, options: { showContent: true } })) as any[]) : [];
    const nameById = new Map<string, string>();
    for (const o of objs) {
      const id = o.data?.objectId;
      const nm = o.data?.content?.fields?.name;
      if (id && nm) nameById.set(id, String(nm));
    }
    const platformIds = new Set<string>();
    try {
      for (const a of loadRoster().agents) platformIds.add(a.agentId);
    } catch {
      /* ignore */
    }
    history = sev.data.map((e) => {
      const p = (e as any).parsedJson ?? {};
      const winnerId = String(p.winner);
      return {
        contestId: String(p.contest),
        winner: nameById.get(winnerId) ?? "agent",
        platform: platformIds.has(winnerId),
        prize: Number(p.prize ?? 0) / 1_000_000,
        at: Number((e as any).timestampMs ?? 0),
      };
    });
  } catch {
    /* leave history empty on read failure */
  }

  return c.json({
    autopilot: autopilotEnabled(),
    tiers: difficultyTiers(),
    recent: recentContests(),
    open,
    history,
  });
});

// Open a contest, keyed by kind:
//   - challenge: a duel against a random platform agent.
//   - duel: a 1v1 for two real agents, no platform agents.
//   - general: multi-entry, platform agents fill the empty seats (they never win).
//   - custom: multi-entry, a creator's event with no platform agents.
app.post("/contests/create", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const kind = ["challenge", "duel", "general", "custom"].includes(b.kind) ? b.kind : "general";
  const game = b.game === "solver" ? 1 : 0;
  const isDuel = kind === "challenge" || kind === "duel";
  const format = isDuel ? CONTEST_FORMAT.duel : CONTEST_FORMAT.multi;
  const levelMin = Math.max(0, Math.min(4, Number(b.levelMin ?? 0)));
  const levelMax = Math.max(levelMin, Math.min(4, Number(b.levelMax ?? 4)));
  const entryFeeUsdc = BigInt(Math.max(0, Number(b.entryFeeUsdc ?? 0))) * 1_000_000n;
  const rewardUsdc = BigInt(Math.max(0, Number(b.rewardUsdc ?? 0))) * 1_000_000n;
  const maxEntries = isDuel ? 2 : Math.max(2, Math.min(8, Number(b.maxEntries ?? 4)));
  try {
    const { contestId } = await createContest({ game, format, levelMin, levelMax, entryFeeUsdc, maxEntries });
    if (rewardUsdc > 0n) await fundContest(contestId, rewardUsdc);
    if (kind === "custom") customContests.add(contestId);
    if (kind === "challenge") challengeContests.add(contestId);
    openContestWindow(contestId);
    return c.json({ ok: true, contestId, kind });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

app.get("/status", (c) =>
  c.json({
    network: config.sui.network,
    reasonMode: reasonMode(),
    reasonConfigured: reasonConfigured(),
    suiConfigured: suiConfigured(),
    memoryConfigured: memoryConfigured(),
    arenaPackage: config.arena.packageId || null,
    arenaTreasury: config.arena.treasuryObject || null,
    arenaNameRegistry: config.arena.nameRegistry || null,
    avowPackage: config.avow.packageId,
  }),
);

// Recent matches (one row per table), newest first. Empty when the DB is unreachable.
app.get("/matches", async (c) => {
  try {
    const { rows } = await query(
      `select table_id,
              count(*)            as hands,
              max(created_at)     as last_hand,
              sum(pot)            as total_pot
         from hands
        group by table_id
        order by last_hand desc
        limit 50`,
    );
    return c.json(rows);
  } catch {
    return c.json([]);
  }
});

// Every move of a table in order, with its Avow anchor (the verify badge fields).
app.get("/match/:tableId/moves", async (c) => {
  const tableId = c.req.param("tableId");
  try {
    const { rows } = await query(
      `select m.hand_id, m.street, m.seat, m.agent_id, m.action, m.amount, m.rationale,
              m.samples, m.blob_id, m.evidence_hash, m.anchor_digest, m.within_mandate, m.created_at
         from moves m
        where m.table_id = $1
        order by m.id asc`,
      [tableId],
    );
    return c.json(rows);
  } catch {
    return c.json([]);
  }
});

export function startServer(): Server {
  const server = serve({ fetch: app.fetch, port: config.server.port }) as Server;
  attachWebSocket(server);
  console.log(`telt backend listening on :${config.server.port} (reason: ${reasonMode()})`);
  return server;
}
