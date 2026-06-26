import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load the shared root .env first (where the coordinator key and Avow settings
// live), then an optional backend-local .env that can override for development.
const here = dirname(fileURLToPath(import.meta.url));
const rootEnv = resolve(here, "../../../.env");
const localEnv = resolve(here, "../../.env");
if (existsSync(rootEnv)) loadEnv({ path: rootEnv });
if (existsSync(localEnv)) loadEnv({ path: localEnv, override: true });

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

// The Avow testnet package id. Never redeployed; the arena points at this.
const AVOW_PACKAGE_ID_DEFAULT =
  "0x4f3e25d7858a70ce4f1a437a3f91f24700407f52c68bb93775522d752841a3ee";

export const config = {
  sui: {
    network: optional("SUI_NETWORK", "testnet"),
    // The coordinator wallet signs settlements, intel delivery, and Avow anchors.
    privateKey: process.env.SUI_PRIVATE_KEY ?? "",
    rpcOverride: process.env.AVOW_SUI_RPC ?? "",
  },
  arena: {
    packageId: process.env.ARENA_PACKAGE_ID ?? "",
    coordinatorCap: process.env.ARENA_COORDINATOR_CAP ?? "",
    // The shared Treasury object that upgrade/buy_intel route fees through.
    treasuryObject: process.env.ARENA_TREASURY_OBJECT ?? "",
    // The address those fees land at (the Treasury object's `addr`).
    treasury: process.env.ARENA_TREASURY ?? "",
    // SUI is the demo stake and fee asset, so we drop a token dependency.
    stakeAsset: optional("STAKE_ASSET", "SUI"),
  },
  avow: {
    packageId: optional("AVOW_PACKAGE_ID", AVOW_PACKAGE_ID_DEFAULT),
  },
  reason: {
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
    model: optional("ANTHROPIC_MODEL", "claude-haiku-4-5"),
    callTimeoutMs: Number(optional("REASON_TIMEOUT_MS", "60000")),
  },
  memory: {
    // MemWal (memory.walrus.xyz). Without these, Avow memory is a no-op and we
    // pass intel in-context for the demo.
    privateKey: process.env.MEMWAL_PRIVATE_KEY ?? "",
    accountId: process.env.MEMWAL_ACCOUNT_ID ?? "",
  },
  db: {
    url: optional("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/telt"),
  },
  server: {
    port: Number(optional("PORT", "8787")),
  },
};

export function suiConfigured(): boolean {
  return Boolean(config.sui.privateKey);
}

export function reasonConfigured(): boolean {
  return Boolean(config.reason.anthropicKey);
}

export function memoryConfigured(): boolean {
  return Boolean(config.memory.privateKey && config.memory.accountId);
}
