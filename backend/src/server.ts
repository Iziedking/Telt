import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { config, memoryConfigured, reasonConfigured, suiConfigured } from "./config/index.js";
import { reasonMode } from "./reason/client.js";

// Minimal boot server. It exists so the dockerized build has a runnable entry
// point and a health probe; the full read API and WS live feed (api/index.ts) land
// in Day 2. No secrets are ever returned here, only whether each piece is wired.

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

app.get("/status", (c) =>
  c.json({
    network: config.sui.network,
    reasonMode: reasonMode(),
    reasonConfigured: reasonConfigured(),
    suiConfigured: suiConfigured(),
    memoryConfigured: memoryConfigured(),
    arenaPackage: config.arena.packageId || null,
    avowPackage: config.avow.packageId,
  }),
);

serve({ fetch: app.fetch, port: config.server.port });
console.log(`telt backend listening on :${config.server.port} (reason: ${reasonMode()})`);
