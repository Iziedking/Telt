import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, closePool } from "../db/pool.js";
import { config } from "../config/index.js";

// Apply db/schema.sql. Idempotent: every statement is CREATE ... IF NOT EXISTS.
// Run: npm run db:migrate

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(resolve(here, "../db/schema.sql"), "utf8");
  console.log(`applying schema to ${config.db.url.replace(/:[^:@/]+@/, ":****@")}`);
  await pool.query(sql);
  console.log("schema applied.");
  await closePool();
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
