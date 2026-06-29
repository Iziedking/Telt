import Anthropic from "@anthropic-ai/sdk";
import { config, reasonConfigured } from "../config/index.js";

// The single seam every agent answer passes through. In Telt an agent does not
// "think" anywhere except here. This was 0G Compute in Zerun; it is now a Claude
// Haiku call. The CallParams and CallResult shapes are kept identical to the
// Zerun seam so nothing downstream changes. Verification no longer happens at the
// model layer (it meant 0G TEE before, so `verified` is null here); proof now
// lives at the Avow anchor on the move layer.

export type ReasonSource = "anthropic" | "openrouter" | "offline-dev";
export type Provider = "anthropic" | "openrouter";

export interface CallParams {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
  // The tier picks the engine: a cheap OpenRouter model for low tiers, Claude Haiku
  // for the top. Omitted falls back to the configured default.
  provider?: Provider;
  model?: string;
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
  // Prefer Conduit (an Anthropic-compatible gateway) when its key is set; it is the primary.
  const useConduit = Boolean(config.reason.conduitKey);
  client = new Anthropic({
    apiKey: useConduit ? config.reason.conduitKey : config.reason.anthropicKey,
    baseURL: useConduit ? config.reason.conduitBaseUrl : undefined,
    timeout: config.reason.callTimeoutMs,
  });
  return client;
}

export async function callModel(params: CallParams): Promise<CallResult> {
  if (resolveMode() === "offline-dev") return offlineResult();

  // The tier requests a provider; if its key is missing, fall back to whatever is
  // configured so a partial setup still runs rather than erroring.
  // "anthropic" here means the Anthropic-compatible client, which is Conduit when configured.
  const haveAnthropic = Boolean(config.reason.conduitKey || config.reason.anthropicKey);
  const wants: Provider = params.provider ?? (haveAnthropic ? "anthropic" : "openrouter");
  const haveOpenrouter = Boolean(config.reason.openrouterKey);
  const provider: Provider = wants === "openrouter" && !haveOpenrouter ? "anthropic" : wants === "anthropic" && !haveAnthropic ? "openrouter" : wants;

  if (provider === "openrouter" && haveOpenrouter) {
    return callOpenrouter(params);
  }
  if (provider === "anthropic" && haveAnthropic) {
    try {
      return await callAnthropic(params);
    } catch (e) {
      // Anthropic can be configured but unusable at call time (out of credits, rate limited).
      // If OpenRouter is available, fall back to it so generation and the top tier keep working
      // (with OpenRouter's default model) instead of erroring.
      if (haveOpenrouter) {
        console.warn("[reason] anthropic failed, falling back to openrouter:", (e as Error).message);
        return callOpenrouter({ ...params, model: undefined });
      }
      throw e;
    }
  }
  return offlineResult();
}

async function callAnthropic(params: CallParams): Promise<CallResult> {
  const model = params.model ?? config.reason.model;
  const t0 = Date.now();
  // Stream and accumulate the final message. The Conduit gateway only returns an SSE stream
  // (not a single JSON body), and streaming also works against the real Anthropic API, so use
  // it for both rather than messages.create.
  const stream = getClient().messages.stream({
    model,
    max_tokens: params.maxTokens,
    temperature: params.temperature,
    system: params.systemPrompt,
    messages: [{ role: "user", content: params.userPrompt }],
  });
  const message = await stream.finalMessage();
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

// OpenRouter speaks the OpenAI chat-completions shape, so a plain fetch is enough,
// no extra SDK. System prompt becomes a system message; the rest mirrors Anthropic.
async function callOpenrouter(params: CallParams): Promise<CallResult> {
  const model = params.model ?? config.reason.openrouterModel;
  const t0 = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.reason.openrouterKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://telt.arena",
      "X-Title": "Telt",
    },
    body: JSON.stringify({
      model,
      max_tokens: params.maxTokens,
      temperature: params.temperature,
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(config.reason.callTimeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`openrouter ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    id?: string;
    choices?: { message?: { content?: string } }[];
  };
  const text = (data.choices?.[0]?.message?.content ?? "").trim();
  return {
    text,
    source: "openrouter",
    provider: "openrouter",
    model,
    chatID: data.id ?? null,
    verified: null,
    latencyMs: Date.now() - t0,
  };
}

// Health-check a single provider with a tiny call, no fallback, so the admin page can see
// exactly which one is responding (the "anthropic" provider is Conduit when configured).
export interface ProviderProbe {
  provider: Provider;
  configured: boolean;
  ok: boolean;
  model?: string;
  latencyMs?: number;
  error?: string;
}
export async function probeProvider(provider: Provider): Promise<ProviderProbe> {
  const configured =
    provider === "openrouter"
      ? Boolean(config.reason.openrouterKey)
      : Boolean(config.reason.conduitKey || config.reason.anthropicKey);
  if (!configured) return { provider, configured: false, ok: false, error: "no key set" };
  const t0 = Date.now();
  const params = { systemPrompt: "Reply with the single word OK.", userPrompt: "ping", maxTokens: 5, temperature: 0 };
  try {
    const r = provider === "openrouter" ? await callOpenrouter(params) : await callAnthropic(params);
    return { provider, configured: true, ok: true, model: r.model, latencyMs: Date.now() - t0 };
  } catch (e) {
    return { provider, configured: true, ok: false, latencyMs: Date.now() - t0, error: (e as Error).message.slice(0, 240) };
  }
}

// offline-dev: deterministic, no network. Clearly labeled so it never reads as a real
// model answer. Used only to exercise the pipeline before any key is set.
function offlineResult(): CallResult {
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
