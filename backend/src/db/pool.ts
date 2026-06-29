import pg from "pg";
import { config } from "../config/index.js";

// One shared pool for the whole process. Queries are small and short-lived. The database is
// optional for the demo (the leaderboard and history read from chain; hands and moves are
// just persisted for analytics), so when it is unreachable we degrade gracefully: log it
// once, then short-circuit so a match never spams the log or waits on a dead socket.
const pool = new pg.Pool({ connectionString: config.db.url, max: 8 });

let dbDown = false;

function isConnError(e: unknown): boolean {
  const err = e as { code?: string };
  const code = err?.code ?? "";
  return /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EHOSTUNREACH/.test(code) || code === "57P03";
}

export function dbAvailable(): boolean {
  return !dbDown;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  if (dbDown) throw new Error("database unavailable");
  try {
    return await pool.query<T>(text, params as never[]);
  } catch (e) {
    if (isConnError(e)) {
      dbDown = true;
      console.warn("[db] unreachable; persistence disabled for this session (matches still run and settle on chain)");
    }
    throw e;
  }
}

// Best-effort write: run a query, swallow any error. The database being down is not fatal to
// a match, and query() already logs the outage once, so this stays quiet.
export async function persist(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    /* persistence is optional; the outage is logged once by query() */
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

export { pool };
