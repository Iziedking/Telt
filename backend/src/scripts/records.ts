import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { listRecords } from "avow-sdk";
import { sui } from "../chain/sui.js";

// Read back the Avow track record for each agent in runtime/agents.json: how many
// moves anchored, and the public fields of the latest. Read-only, no gas.
// Run: npm run records

async function main() {
  const file = resolve(dirname(fileURLToPath(import.meta.url)), "../../runtime/agents.json");
  const { agents } = JSON.parse(readFileSync(file, "utf8")) as {
    agents: Array<{ name: string; mandateId: string }>;
  };

  for (const a of agents) {
    const records = await listRecords(sui, a.mandateId, 50);
    console.log(`\n${a.name}: ${records.length} anchored move(s)`);
    const latest = records[0];
    if (latest) {
      console.log(`  latest: ${latest.actionType} amount=${latest.amount} within=${latest.withinMandate}`);
      console.log(`  blob:   ${latest.blobId}`);
      console.log(`  hash:   ${latest.evidenceHashHex}`);
      console.log(`  tx:     ${latest.txDigest}`);
    }
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
