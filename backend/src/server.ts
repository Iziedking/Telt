import { startServer } from "./api/index.js";
import { startAutopilot, autopilotEnabled } from "./coordinator/autopilot.js";
import { config } from "./config/index.js";

// Boot the read API and the WS live feed. The match itself is driven by the coordinator
// (src/coordinator/table.ts), kicked off via `npm run match` or the HTTP triggers. When
// the autopilot is enabled, the platform also runs contests on a schedule on its own.
startServer();

if (autopilotEnabled()) startAutopilot(config.autopilot.intervalMs);
