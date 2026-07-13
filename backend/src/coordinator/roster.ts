import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { coordinator, coordinatorAddress } from "../chain/sui.js";
import type { AgentAvow } from "../avow/anchorMove.js";
import type { Seat } from "../poker/types.js";

// Loads the agents written by setup:agents and builds the Avow context for each. All
// agents are operated by the coordinator wallet for the demo, so the signer and agent
// address are the coordinator; only the per-agent sealing identity (user) differs.

export interface RosterEntry {
  key: Seat;
  name: string;
  level: number;
  agentId: string;
  mandateId: string;
  accessId: string;
  capId: string;
  userAddr: string;
  userSecret?: string;
}

export function rosterFile(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../runtime/agents.json");
}

export function loadRoster(): { coordinator: string; agents: RosterEntry[] } {
  return JSON.parse(readFileSync(rosterFile(), "utf8"));
}

export function avowFor(e: RosterEntry): AgentAvow {
  return {
    mandateId: e.mandateId,
    accessId: e.accessId,
    agentAddress: coordinatorAddress(),
    user: e.userAddr,
    signer: coordinator(),
  };
}

// The two agents of the headline duel, by seat. The roster now holds a full house field so a
// championship bracket can fill, and several of them share a seat key -- so take the FIRST match
// for each seat, which keeps Calypso and Maverick as the standalone pairing rather than letting
// whoever was appended last quietly take their place.
export function rosterBySeat(): Record<Seat, RosterEntry> {
  const out = {} as Record<Seat, RosterEntry>;
  for (const e of loadRoster().agents) {
    if (!out[e.key]) out[e.key] = e;
  }
  return out;
}

// Platform (house) agents are the roster agents. They run demos and fill contests but are
// never graded, so result recording skips them.
export function isPlatformAgent(agentId: string): boolean {
  try {
    return loadRoster().agents.some((a) => a.agentId === agentId);
  } catch {
    return false;
  }
}
