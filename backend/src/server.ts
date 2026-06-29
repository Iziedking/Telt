import { startServer } from "./api/index.js";
import { startAutopilot, autopilotEnabled } from "./coordinator/autopilot.js";
import { startSweeper } from "./coordinator/sweeper.js";

// A coordinator side effect (a Walrus anchor running low on WAL, an RPC blip) must never take
// the whole server down. Log stray failures and keep serving; matches still play and settle.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason instanceof Error ? reason.message : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err instanceof Error ? err.message : err);
});

// Boot the read API and the WS live feed. The match itself is driven by the coordinator
// (src/coordinator/table.ts), kicked off via `npm run match` or the HTTP triggers. When
// the autopilot is enabled, the platform also runs contests on a schedule on its own.
startServer();

// Always run the sweeper: it settles any contest whose join window has closed.
startSweeper();

if (autopilotEnabled()) startAutopilot();
