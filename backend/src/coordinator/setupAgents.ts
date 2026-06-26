import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { createMandate } from "avow-sdk";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sui, coordinator, coordinatorAddress, claimAgent, registerForArena, upgradeAgent } from "../chain/sui.js";
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

const ROSTER = [
  { key: "A" as const, name: "Calypso", level: 0 },
  { key: "B" as const, name: "Maverick", level: 2 },
];

const PER_MOVE_CAP = 1_000_000_000n; // generous: chips committed never approach this
const DAILY_CAP = 1_000_000_000_000n;
const EXPIRY_EPOCH = 100000n; // safely far in the future on testnet

async function main() {
  console.log(`coordinator: ${coordinatorAddress()}`);
  const agents = [];

  for (const a of ROSTER) {
    console.log(`\n${a.name} (level ${a.level})...`);
    // A distinct sealing identity per agent, for per-agent intel separation later.
    const userAddr = Ed25519Keypair.generate().getPublicKey().toSuiAddress();

    const mandate = await createMandate(sui, coordinator(), {
      agent: coordinatorAddress(),
      perMoveCap: PER_MOVE_CAP,
      dailyCap: DAILY_CAP,
      expiryEpoch: EXPIRY_EPOCH,
      restrictTargets: false,
    });
    console.log(`  mandate ${mandate.mandateId}`);

    const { agentId } = await claimAgent(a.name, mandate.mandateId);
    console.log(`  agent   ${agentId}`);
    await registerForArena(agentId);
    console.log(`  registered for arena`);

    for (let lvl = 0; lvl < a.level; lvl++) {
      const cost = nextLevelCostMist(lvl);
      if (cost) {
        await upgradeAgent(agentId, cost);
        console.log(`  upgraded to level ${lvl + 1}`);
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
