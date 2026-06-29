import { config } from "../config/index.js";

// Where solver puzzles get their facts. Firecrawl does a deep web search and returns
// scraped content, which keeps questions fresh and non-repeating. Exa answers a query and
// cites its sources. Both are optional; without keys the generator uses the model's own
// knowledge instead.

export interface Research {
  text: string;
  sources: string[];
}

// How many Firecrawl calls this process has made, against the configured cap.
let firecrawlCalls = 0;
export function firecrawlUsage(): { used: number; cap: number } {
  return { used: firecrawlCalls, cap: config.solver.firecrawlMaxCalls };
}

async function firecrawlSearch(query: string): Promise<Research | null> {
  if (!config.solver.firecrawlKey) return null;
  // Stop calling the metered API once the per-process cap is reached (0 disables it entirely).
  if (firecrawlCalls >= config.solver.firecrawlMaxCalls) return null;
  firecrawlCalls += 1;
  try {
    const r = await fetch("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.solver.firecrawlKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit: 3, scrapeOptions: { formats: ["markdown"] } }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return null;
    const d = (await r.json()) as { data?: { url?: string; markdown?: string; description?: string }[] };
    const items = d.data ?? [];
    const text = items
      .map((it) => it.markdown || it.description || "")
      .join("\n\n")
      .slice(0, 4000)
      .trim();
    const sources = items.map((it) => it.url).filter(Boolean) as string[];
    return text ? { text, sources } : null;
  } catch {
    return null;
  }
}

async function exaAnswer(query: string): Promise<Research | null> {
  if (!config.solver.exaKey) return null;
  try {
    const r = await fetch("https://api.exa.ai/answer", {
      method: "POST",
      headers: { "x-api-key": config.solver.exaKey, "Content-Type": "application/json" },
      body: JSON.stringify({ query, text: true }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return null;
    const d = (await r.json()) as { answer?: string; citations?: { url?: string; text?: string }[] };
    const cites = d.citations ?? [];
    const text = [d.answer ?? "", ...cites.map((c) => c.text || "")]
      .join("\n\n")
      .slice(0, 4000)
      .trim();
    const sources = cites.map((c) => c.url).filter(Boolean) as string[];
    return text ? { text, sources } : null;
  } catch {
    return null;
  }
}

// Research a topic: Exa first, since it answers with citations and its key is free, and only
// fall back to Firecrawl when Exa returns nothing, because Firecrawl is metered. This keeps
// Firecrawl usage to a minimum; remove FIRECRAWL_API_KEY to switch it off entirely. Null when
// neither is configured.
export async function research(topic: string): Promise<Research | null> {
  return (await exaAnswer(topic)) ?? (await firecrawlSearch(topic));
}

export function solverSourcesConfigured(): boolean {
  return Boolean(config.solver.exaKey || config.solver.firecrawlKey);
}
