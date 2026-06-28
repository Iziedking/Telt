import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { config, memoryConfigured, reasonConfigured, suiConfigured } from "../config/index.js";
import { reasonMode } from "../reason/client.js";
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
import { runAutopilotCycle, recentContests, difficultyTiers, autopilotEnabled } from "../coordinator/autopilot.js";
import { query } from "../db/pool.js";

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
  let agents: { agentId: string; name: string; level: number }[];
  try {
    agents = loadRoster().agents;
  } catch {
    return c.json({ game: "poker", rows: [] });
  }
  const rows = await Promise.all(
    agents.map(async (a) => {
      try {
        const o = (await sui.getObject({ id: a.agentId, options: { showContent: true } })) as any;
        const f = o.data?.content?.fields ?? {};
        const wins = Number(f.wins ?? 0);
        const losses = Number(f.losses ?? 0);
        const games = wins + losses;
        return {
          name: String(f.name ?? a.name),
          level: Number(f.level ?? a.level),
          wins,
          losses,
          games,
          winRate: games ? Math.round((100 * wins) / games) : 0,
          agentId: a.agentId,
        };
      } catch {
        return { name: a.name, level: a.level, wins: 0, losses: 0, games: 0, winRate: 0, agentId: a.agentId };
      }
    }),
  );
  rows.sort((x, y) => y.wins - x.wins || y.winRate - x.winRate || y.level - x.level);
  return c.json({ game: "poker", rows });
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
      .map((s) => ({
        contestId: s.contestId,
        game: s.game === 1 ? "solver" : "poker",
        format: s.format === CONTEST_FORMAT.duel ? "duel" : "general",
        entryFee: Number(s.entryFee) / 1_000_000,
        pool: Number(s.pool) / 1_000_000,
        entrants: s.entrants.length,
        maxEntries: s.maxEntries,
        levelMin: s.levelMin,
        levelMax: s.levelMax,
      }));
  } catch {
    /* leave open empty on read failure */
  }
  return c.json({ autopilot: autopilotEnabled(), tiers: difficultyTiers(), recent: recentContests(), open });
});

// Open a contest for agents to join. A general contest lets platform agents fill it; a duel
// stays platform-free. Optionally seed a tUSDC reward into the pool.
app.post("/contests/create", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const game = b.game === "solver" ? 1 : 0;
  const format = b.format === "duel" ? CONTEST_FORMAT.duel : CONTEST_FORMAT.multi;
  const levelMin = Math.max(0, Math.min(4, Number(b.levelMin ?? 0)));
  const levelMax = Math.max(levelMin, Math.min(4, Number(b.levelMax ?? 4)));
  const entryFeeUsdc = BigInt(Math.max(0, Number(b.entryFeeUsdc ?? 0))) * 1_000_000n;
  const rewardUsdc = BigInt(Math.max(0, Number(b.rewardUsdc ?? 0))) * 1_000_000n;
  const maxEntries = Math.max(2, Math.min(8, Number(b.maxEntries ?? 2)));
  try {
    const { contestId } = await createContest({ game, format, levelMin, levelMax, entryFeeUsdc, maxEntries });
    if (rewardUsdc > 0n) await fundContest(contestId, rewardUsdc);
    return c.json({ ok: true, contestId });
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
