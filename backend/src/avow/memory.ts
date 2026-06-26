import { createMemory } from "avow-sdk";

// Avow memory per agent. createMemory() reads MEMWAL_PRIVATE_KEY / MEMWAL_ACCOUNT_ID
// and gives the agent recall/remember on Walrus, scoped per user (here, per agent
// operator identity).
//
// MemWal also needs a local Seal sidecar (default http://localhost:9000). Because the
// SDK swallows sidecar failures internally rather than throwing, we gate memory behind
// an explicit MEMORY_ENABLED flag so an absent sidecar does not spam the match. Default
// off: the loop runs statelessly and intel is passed in-context for the demo, which is
// the documented fallback. Turn it on (MEMORY_ENABLED=on) once the sidecar is running.

const ENABLED = (process.env.MEMORY_ENABLED ?? "").toLowerCase() === "on";
const mem = createMemory();

export function memoryEnabled(): boolean {
  return ENABLED && mem.enabled;
}

/** Recall this agent's relevant prior-hand notes, by meaning. */
export async function recallNotes(user: string, query: string, limit = 4): Promise<string[]> {
  if (!memoryEnabled()) return [];
  return mem.recall(user, query, limit);
}

/** Remember a short note from a hand for future decisions. */
export async function rememberNote(user: string, text: string): Promise<void> {
  if (!memoryEnabled()) return;
  await mem.remember(user, text);
}
