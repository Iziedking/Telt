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
    // TreasuryCap<TEST_USDC>, held by the coordinator, used to mint the exact upgrade
    // cost in TestUSDC inside the upgrade transaction.
    testUsdcCap: process.env.ARENA_TESTUSDC_CAP ?? "",
    // The shared NameRegistry that enforces unique agent names.
    nameRegistry: process.env.ARENA_NAME_REGISTRY ?? "",
  },
  avow: {
    packageId: optional("AVOW_PACKAGE_ID", AVOW_PACKAGE_ID_DEFAULT),
  },
  reason: {
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
    model: optional("ANTHROPIC_MODEL", "claude-haiku-4-5"),
    callTimeoutMs: Number(optional("REASON_TIMEOUT_MS", "60000")),
    // OpenRouter (OpenAI-compatible) powers the cheaper lower tiers. A tier's strength
    // comes from its model: the ladder climbs from a small cheap model at level 0 to
    // Claude Haiku at level 4. Each is overridable in .env (TIER0_MODEL..TIER4_MODEL).
    openrouterKey: process.env.OPENROUTER_API_KEY ?? "",
    openrouterModel: optional("LLM_MODEL", "google/gemini-2.5-flash"),
    tierModels: [
      { provider: "openrouter" as const, model: optional("TIER0_MODEL", "meta-llama/llama-3.2-1b-instruct") },
      { provider: "openrouter" as const, model: optional("TIER1_MODEL", "meta-llama/llama-3.2-3b-instruct") },
      { provider: "openrouter" as const, model: optional("TIER2_MODEL", "meta-llama/llama-3.1-8b-instruct") },
      { provider: "openrouter" as const, model: optional("TIER3_MODEL", "openai/gpt-4o-mini") },
      { provider: "anthropic" as const, model: optional("TIER4_MODEL", optional("ANTHROPIC_MODEL", "claude-haiku-4-5")) },
    ],
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
  autopilot: {
    // When on, the platform runs contests on a schedule to keep the arena busy.
    enabled: optional("AUTOPILOT_ENABLED", "off").toLowerCase() === "on",
    intervalMs: Number(optional("AUTOPILOT_INTERVAL_MS", "3600000")), // default hourly
  },
};

export function suiConfigured(): boolean {
  return Boolean(config.sui.privateKey);
}

export function reasonConfigured(): boolean {
  return Boolean(config.reason.anthropicKey || config.reason.openrouterKey);
}

export function memoryConfigured(): boolean {
  return Boolean(config.memory.privateKey && config.memory.accountId);
}
