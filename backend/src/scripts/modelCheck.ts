import { planForLevel, MAX_LEVEL } from "../reason/levels.js";
import { callModel } from "../reason/client.js";
import { pokerTierName } from "../skills/poker.js";

// Ping every tier's model once to confirm it resolves and responds. Strength comes from
// the model behind each tier, so this is the wiring check: cheap OpenRouter models for the
// low tiers, Claude Haiku for the top.

async function main() {
  for (let l = 0; l <= MAX_LEVEL; l++) {
    const plan = planForLevel(l);
    const label = `L${l} ${pokerTierName(l).padEnd(9)} ${plan.provider}/${plan.model}`;
    try {
      const r = await callModel({
        systemPrompt: "Reply with only the word OK.",
        userPrompt: "Say OK.",
        maxTokens: 16,
        temperature: 0,
        provider: plan.provider,
        model: plan.model,
      });
      console.log(`${label}  ->  ${r.source}  "${r.text.slice(0, 40).replace(/\n/g, " ")}"  ${r.latencyMs}ms`);
    } catch (e) {
      console.log(`${label}  ->  FAILED: ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
