import { callModel, reasonMode } from "../reason/client.js";

// Prove one Claude Haiku call returns the right shape. Run: npm run reason:check

async function main() {
  console.log(`reason mode: ${reasonMode()}`);
  const res = await callModel({
    systemPrompt:
      "You are a heads-up poker agent. Reply with ONLY a JSON object: " +
      '{"action":"fold|check|call|raise","size":<number>,"rationale":"<short>"}.',
    userPrompt:
      "You hold As Ks. Board is empty (preflop). You are the big blind facing a min-raise. " +
      "Pot is 30, your stack is 1000. What do you do?",
    maxTokens: 200,
    temperature: 0.6,
  });

  console.log("---");
  console.log(`source:   ${res.source}`);
  console.log(`provider: ${res.provider}`);
  console.log(`model:    ${res.model}`);
  console.log(`chatID:   ${res.chatID}`);
  console.log(`verified: ${res.verified}`);
  console.log(`latency:  ${res.latencyMs}ms`);
  console.log(`text:     ${res.text}`);

  try {
    const parsed = JSON.parse(res.text);
    console.log("parsed OK:", parsed);
  } catch {
    console.warn("note: text did not parse as JSON (the runner tolerates this with extraction).");
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
