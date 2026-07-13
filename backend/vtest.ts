import "dotenv/config";
import "./src/chain/rpcShim.js";
import { loadRoster, avowFor } from "./src/coordinator/roster.js";
import { verifyLatestForMandate } from "./src/avow/anchorMove.js";

(async () => {
  for (const a of loadRoster().agents) {
    const av = avowFor(a);
    try {
      const vr = await verifyLatestForMandate(av.mandateId);
      if (!vr) { console.log(`  ${a.name.padEnd(9)} : no anchored records yet`); continue; }
      const green = vr.hashMatches && vr.amountMatches && vr.withinMandate;
      console.log(
        `  ${a.name.padEnd(9)} : ${green ? "ALL GREEN" : "MIXED"}  ` +
        `evidence-unaltered=${vr.hashMatches}  amount-reconciles=${vr.amountMatches}  within-mandate=${vr.withinMandate}`,
      );
    } catch (e) { console.log(`  ${a.name.padEnd(9)} : FAILED -> ${(e as Error).message.slice(0, 70)}`); }
  }
})().then(() => process.exit(0)).catch((e) => { console.error("  FAILED:", e.message); process.exit(1); });
