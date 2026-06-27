import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { sui, coordinatorAddress, createMandateAndAccess } from "../chain/sui.js";
import { loadRoster, type RosterEntry } from "./roster.js";
import type { Seat } from "../poker/types.js";

// Seats any agent in a match, not just the platform roster. Platform agents reuse their
// stored Avow context. Any other agent (a user's) gets a fresh coordinator-provisioned
// mandate at match time, so the coordinator can anchor on its behalf the same way it does
// for the house agents. The agent's level and name are read from its on-chain state.
export interface Participant extends RosterEntry {
  isHouse?: boolean;
}

const CAPS = { perMoveCap: 1_000_000_000n, dailyCap: 1_000_000_000_000n, expiryEpoch: 100000n };

export async function provisionAgentEntry(agentId: string, key: Seat, isHouse = false): Promise<Participant> {
  const known = loadRoster().agents.find((r) => r.agentId === agentId);
  if (known) return { ...known, key, isHouse };

  const obj = (await sui.getObject({ id: agentId, options: { showContent: true } })) as {
    data?: { content?: { fields?: Record<string, unknown> } };
  };
  const f = obj.data?.content?.fields ?? {};
  const userKp = Ed25519Keypair.generate();
  const mandate = await createMandateAndAccess({ agent: coordinatorAddress(), ...CAPS, restrictTargets: false });
  return {
    key,
    name: String(f.name ?? "agent"),
    level: Number(f.level ?? 0),
    agentId,
    mandateId: mandate.mandateId,
    accessId: mandate.accessId,
    capId: mandate.capId,
    userAddr: userKp.getPublicKey().toSuiAddress(),
    userSecret: userKp.getSecretKey(),
    isHouse,
  };
}
