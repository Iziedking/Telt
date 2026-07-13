import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  coordinatorAddress,
  claimAgent,
  registerForArena,
  upgradeAgent,
  claimTreasury,
  createMandateAndAccess,
} from "../chain/sui.js";
import { nextLevelCostMist } from "../reason/levels.js";

// One-time setup for a demo match. For each agent it creates an Avow mandate (the
// agent address is the coordinator, who signs every anchor), creates the evidence
// access, claims a registry Agent linked to that mandate, registers it for arena
// play, and levels it up to its target tier by paying the on-chain ladder. The two
// agents are deliberately different levels so the demo shows the tier difference.
//
// Both agents are owned and operated by the coordinator wallet for the demo, so a
// single funded key drives the whole match. Each agent's evidence is still sealed to
// a distinct user identity, so per-agent intel stays separable for the Day 3 economy.
// Run: npm run setup:agents

// The house field. Calypso and Maverick stay FIRST and keep their keys: a standalone match takes
// the first two of this list, so the headline duel is still the untrained underdog against the
// Oracle. The six behind them exist so a CHAMPIONSHIP can fill: an eight-seat bracket with one
// real entrant needs seven house agents to play against, and a bracket seeded by level is only
// worth watching if the levels actually spread. Rerunning setup:agents mints any that are missing.
//
// The spread is deliberate. Two at the top so the final can be a genuine L4 v L4; a thick middle,
// because that is where a bought dossier changes a decision; and a floor of Marks for the top
// seeds to draw in round one.
const ROSTER = [
  { key: "A" as const, name: "Calypso", level: 0 }, // Mark, the untrained underdog
  { key: "B" as const, name: "Maverick", level: 4 }, // Oracle, the top tier
  { key: "A" as const, name: "Kestrel", level: 4 }, // the other Oracle: a real final is possible
  { key: "B" as const, name: "Vesper", level: 3 }, // Profiler
  { key: "A" as const, name: "Onyx", level: 3 }, // Profiler
  { key: "B" as const, name: "Halcyon", level: 2 }, // Spotter
  { key: "A" as const, name: "Rook", level: 1 }, // Reader
  { key: "B" as const, name: "Pike", level: 0 }, // Mark
];

const PER_MOVE_CAP = 1_000_000_000n; // generous: chips committed never approach this
const DAILY_CAP = 1_000_000_000_000n;
const EXPIRY_EPOCH = 100000n; // safely far in the future on testnet

// The load-balanced testnet RPC can hand back a stale gas-coin version when transactions
// fire in quick succession. Each call here builds a fresh transaction, so retrying it
// re-selects gas and clears the race.
async function retry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const m = String((e as Error).message || "");
      if (/unavailable for consumption|not available|rebuilt because object|reserved/i.test(m) && i < tries - 1) {
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  throw last;
}

interface StoredAgent {
  key: "A" | "B";
  name: string;
  level: number;
  agentId: string;
  mandateId: string;
  accessId: string;
  capId: string;
  userAddr: string;
  userSecret: string;
}

// Agents already minted, by name. This script used to rebuild the whole roster from scratch and
// overwrite agents.json, which was harmless when the roster was two throwaway demo agents and is
// NOT harmless now: Calypso and Maverick have real anchored histories on chain, and those records
// are keyed to their agent and mandate ids. Minting fresh ones would orphan every dossier the
// intel market can sell and every row on the leaderboard. So keep what exists and only mint what
// is missing, which also makes this safe to re-run when the roster grows again.
function existingAgents(): StoredAgent[] {
  const file = resolve(dirname(fileURLToPath(import.meta.url)), "../../runtime/agents.json");
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { agents: StoredAgent[] }).agents ?? [];
  } catch {
    return [];
  }
}

async function main() {
  console.log(`coordinator: ${coordinatorAddress()}`);
  const kept = existingAgents();
  const agents: StoredAgent[] = [...kept];
  const have = new Set(kept.map((a) => a.name));
  if (kept.length) console.log(`keeping ${kept.length} existing: ${kept.map((a) => a.name).join(", ")}`);

  for (const a of ROSTER) {
    if (have.has(a.name)) {
      console.log(`\n${a.name} already exists, keeping its agent and mandate`);
      continue;
    }
    console.log(`\n${a.name} (level ${a.level})...`);
    // A distinct sealing identity per agent, for per-agent intel separation. The
    // secret is kept so the agent can decrypt intel re-sealed to it via the per-user
    // Seal tier. These are throwaway testnet keys held only in gitignored runtime.
    const userKp = Ed25519Keypair.generate();
    const userAddr = userKp.getPublicKey().toSuiAddress();
    const userSecret = userKp.getSecretKey();

    const mandate = await createMandateAndAccess({
      agent: coordinatorAddress(),
      perMoveCap: PER_MOVE_CAP,
      dailyCap: DAILY_CAP,
      expiryEpoch: EXPIRY_EPOCH,
      restrictTargets: false,
    });
    console.log(`  mandate ${mandate.mandateId}`);

    const { agentId } = await retry(() => claimAgent(a.name, mandate.mandateId));
    console.log(`  agent   ${agentId}`);
    await retry(() => registerForArena(agentId));
    console.log(`  registered for arena`);

    for (let lvl = 0; lvl < a.level; lvl++) {
      const cost = nextLevelCostMist(lvl);
      if (cost) {
        await retry(() => upgradeAgent(agentId, cost));
        // Sweep the fee back to the coordinator so the next (pricier) upgrade is affordable;
        // the peak balance needed is the largest single step, not the cumulative ladder.
        await retry(() => claimTreasury());
        console.log(`  upgraded to level ${lvl + 1} (paid ${Number(cost) / 1e9} SUI, swept back)`);
      }
    }

    agents.push({
      key: a.key,
      name: a.name,
      level: a.level,
      agentId,
      mandateId: mandate.mandateId,
      accessId: mandate.accessId,
      capId: mandate.capId,
      userAddr,
      userSecret,
    });
  }

  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../runtime");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, "agents.json");
  writeFileSync(file, JSON.stringify({ coordinator: coordinatorAddress(), agents }, null, 2));
  console.log(`\nwrote ${file}`);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
