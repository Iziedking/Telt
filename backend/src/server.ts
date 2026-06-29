import { startServer } from "./api/index.js";
import { startAutopilot, autopilotEnabled } from "./coordinator/autopilot.js";
import { startSweeper } from "./coordinator/sweeper.js";

// Boot the read API and the WS live feed. The match itself is driven by the coordinator
// (src/coordinator/table.ts), kicked off via `npm run match` or the HTTP triggers. When
// the autopilot is enabled, the platform also runs contests on a schedule on its own.
startServer();

// Always run the sweeper: it settles any contest whose join window has closed.
startSweeper();

if (autopilotEnabled()) startAutopilot();
