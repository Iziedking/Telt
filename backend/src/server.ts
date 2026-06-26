import { startServer } from "./api/index.js";

// Boot the read API and the WS live feed. The match itself is driven by the
// coordinator (src/coordinator/table.ts), kicked off via `npm run match` or, later,
// an HTTP trigger. Day 2 keeps them separate so a match can run headless.
startServer();
