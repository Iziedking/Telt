import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { getSuiClient } from "avow-sdk";
import { config } from "../config/index.js";

// The arena's chain layer: one Sui client (reused from avow-sdk so Seal and Walrus
// share the same client identity, as the plan requires), the coordinator keypair,
// and typed move-call builders for the registry, table, and intel modules. This
// replaces Zerun's chain/contracts.ts.

// Reuse the avow-sdk client so there is exactly one SuiJsonRpcClient in the process.
export const sui: SuiJsonRpcClient = getSuiClient();

let coordinatorKp: Ed25519Keypair | null = null;
export function coordinator(): Ed25519Keypair {
  if (coordinatorKp) return coordinatorKp;
  if (!config.sui.privateKey) throw new Error("SUI_PRIVATE_KEY is not set");
  coordinatorKp = Ed25519Keypair.fromSecretKey(config.sui.privateKey);
  return coordinatorKp;
}

export function coordinatorAddress(): string {
  return coordinator().getPublicKey().toSuiAddress();
}

const PKG = () => {
  if (!config.arena.packageId) throw new Error("ARENA_PACKAGE_ID is not set");
  return config.arena.packageId;
};

export interface TxResult {
  digest: string;
  objectChanges: unknown[];
  status: string;
}

// Run a built transaction with the coordinator (or a given signer) and surface object
// changes so callers can read created object ids.
export async function execute(tx: Transaction, signer: Ed25519Keypair = coordinator()): Promise<TxResult> {
  const res = await sui.signAndExecuteTransaction({
    transaction: tx,
    signer,
    options: { showEffects: true, showObjectChanges: true },
  });
  const status = res.effects?.status?.status ?? "unknown";
  if (status !== "success") {
    throw new Error(`tx ${res.digest} failed: ${JSON.stringify(res.effects?.status)}`);
  }
  return { digest: res.digest, objectChanges: res.objectChanges ?? [], status };
}

// Pull the id of the first created object whose type ends with `suffix`.
export function createdId(changes: unknown[], suffix: string): string {
  for (const c of changes as Array<Record<string, unknown>>) {
    if (c.type === "created" && String(c.objectType).endsWith(suffix)) {
      return String(c.objectId);
    }
  }
  throw new Error(`no created object of type ...${suffix}`);
}

// --- registry ---

export async function claimAgent(name: string, mandateId: string, signer?: Ed25519Keypair): Promise<{ agentId: string; digest: string }> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::registry::claim_agent`,
    arguments: [tx.pure.vector("u8", new TextEncoder().encode(name)), tx.pure.id(mandateId)],
  });
  const r = await execute(tx, signer);
  return { agentId: createdId(r.objectChanges, "::registry::Agent"), digest: r.digest };
}

export async function registerForArena(agentId: string, signer?: Ed25519Keypair): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({ target: `${PKG()}::registry::register_for_arena`, arguments: [tx.object(agentId)] });
  return (await execute(tx, signer)).digest;
}

export async function upgradeAgent(agentId: string, payMist: bigint, signer?: Ed25519Keypair): Promise<string> {
  const tx = new Transaction();
  const [pay] = tx.splitCoins(tx.gas, [tx.pure.u64(payMist)]);
  tx.moveCall({
    target: `${PKG()}::registry::upgrade`,
    arguments: [tx.object(agentId), pay, tx.object(config.arena.treasuryObject)],
  });
  return (await execute(tx, signer)).digest;
}

export async function recordResult(agentId: string, won: boolean): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::registry::record_result`,
    arguments: [tx.object(config.arena.coordinatorCap), tx.object(agentId), tx.pure.bool(won)],
  });
  return (await execute(tx)).digest;
}

// --- table ---

export async function openTable(buyinMist: bigint): Promise<{ tableId: string; digest: string }> {
  const tx = new Transaction();
  tx.moveCall({ target: `${PKG()}::table::open_table`, arguments: [tx.pure.u64(buyinMist)] });
  const r = await execute(tx);
  return { tableId: createdId(r.objectChanges, "::table::Table"), digest: r.digest };
}

export async function joinTable(tableId: string, agentId: string, buyinMist: bigint, signer?: Ed25519Keypair): Promise<string> {
  const tx = new Transaction();
  const [stake] = tx.splitCoins(tx.gas, [tx.pure.u64(buyinMist)]);
  tx.moveCall({
    target: `${PKG()}::table::join_table`,
    arguments: [tx.object(tableId), tx.object(agentId), stake],
  });
  return (await execute(tx, signer)).digest;
}

export async function settleTable(tableId: string, winnerOwner: string, handsPlayed: number): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::table::settle`,
    arguments: [
      tx.object(tableId),
      tx.object(config.arena.coordinatorCap),
      tx.pure.address(winnerOwner),
      tx.pure.u64(BigInt(handsPlayed)),
    ],
  });
  return (await execute(tx)).digest;
}

// --- intel ---

export async function buyIntel(tableId: string, targetAgentId: string, feeMist: bigint, signer?: Ed25519Keypair): Promise<{ receiptId: string; digest: string }> {
  const tx = new Transaction();
  const [fee] = tx.splitCoins(tx.gas, [tx.pure.u64(feeMist)]);
  tx.moveCall({
    target: `${PKG()}::intel::buy_intel`,
    arguments: [tx.pure.id(tableId), tx.object(targetAgentId), fee, tx.object(config.arena.treasuryObject)],
  });
  const r = await execute(tx, signer);
  return { receiptId: createdId(r.objectChanges, "::intel::IntelReceipt"), digest: r.digest };
}
