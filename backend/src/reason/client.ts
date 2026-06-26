import Anthropic from "@anthropic-ai/sdk";
import { config, reasonConfigured } from "../config/index.js";

// The single seam every agent answer passes through. In Telt an agent does not
// "think" anywhere except here. This was 0G Compute in Zerun; it is now a Claude
// Haiku call. The CallParams and CallResult shapes are kept identical to the
// Zerun seam so nothing downstream changes. Verification no longer happens at the
// model layer (it meant 0G TEE before, so `verified` is null here); proof now
// lives at the Avow anchor on the move layer.

export type ReasonSource = "anthropic" | "offline-dev";

export interface CallParams {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
}

export interface CallResult {
  text: string;
  source: ReasonSource;
  provider: string;
  model: string;
  /// Anthropic message id, kept for traceability in the move record.
  chatID: string | null;
  /// Model-layer verification verdict. Always null now: proof moved to the Avow
  /// anchor. Kept on the interface so the downstream Zerun shape is unchanged.
  verified: boolean | null;
  latencyMs: number;
}

function resolveMode(): ReasonSource {
  const forced = (process.env.REASON_MODE ?? "").toLowerCase();
  if (forced === "anthropic") return "anthropic";
  if (forced === "stub" || forced === "offline-dev") return "offline-dev";
  return reasonConfigured() ? "anthropic" : "offline-dev";
}

export function reasonMode(): ReasonSource {
  return resolveMode();
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (client) return client;
  client = new Anthropic({
    apiKey: config.reason.anthropicKey,
    timeout: config.reason.callTimeoutMs,
  });
  return client;
}

export async function callModel(params: CallParams): Promise<CallResult> {
  const mode = resolveMode();

  if (mode === "anthropic") {
    const model = config.reason.model;
    const t0 = Date.now();
    const message = await getClient().messages.create({
      model,
      max_tokens: params.maxTokens,
      temperature: params.temperature,
      system: params.systemPrompt,
      messages: [{ role: "user", content: params.userPrompt }],
    });
    // Concatenate every text block; tool/thinking blocks are not used here.
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return {
      text,
      source: "anthropic",
      provider: "anthropic",
      model,
      chatID: message.id ?? null,
      verified: null,
      latencyMs: Date.now() - t0,
    };
  }

  // offline-dev: deterministic, no network. Clearly labeled so it never reads as
  // a real model answer. Used only to exercise the pipeline before a key is set.
  const t0 = Date.now();
  return {
    text: offlineAnswer(),
    source: "offline-dev",
    provider: "offline-dev",
    model: "offline-dev",
    chatID: null,
    verified: null,
    latencyMs: Date.now() - t0,
  };
}

// A safe default action for the offline stub: check or call, never a wild bet.
function offlineAnswer(): string {
  return JSON.stringify({ action: "check", size: 0, rationale: "offline-dev: no model configured" });
}
