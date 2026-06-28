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

async function doExecute(tx: Transaction, signer: Ed25519Keypair): Promise<TxResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await sui.signAndExecuteTransaction({
        transaction: tx,
        signer,
        options: { showEffects: true, showObjectChanges: true },
      });
      const status = res.effects?.status?.status ?? "unknown";
      if (status !== "success") {
        throw new Error(`tx ${res.digest} failed: ${JSON.stringify(res.effects?.status)}`);
      }
      // Wait until the node has indexed this transaction before returning.
      await sui.waitForTransaction({ digest: res.digest });
      return { digest: res.digest, objectChanges: res.objectChanges ?? [], status };
    } catch (e) {
      lastErr = e;
      const m = String((e as Error).message || "");
      // Transient network blips on the load-balanced RPC: wait and retry the same tx.
      if (/fetch failed|ECONN|ETIMEDOUT|timeout|502|503|429/i.test(m) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// The coordinator drives every platform transaction from a single key. Running them
// concurrently makes them fight over the same gas coin (object-version locks). Serialize
// them through a queue so each one settles before the next starts.
let txQueue: Promise<unknown> = Promise.resolve();

// Run a built transaction with the coordinator (or a given signer) and surface object
// changes so callers can read created object ids. Serialized to avoid gas contention.
export async function execute(tx: Transaction, signer: Ed25519Keypair = coordinator()): Promise<TxResult> {
  const run = txQueue.then(() => doExecute(tx, signer));
  txQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
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

// --- avow mandate (created via our execute() so the two txs do not race gas) ---

export interface CreatedMandate {
  mandateId: string;
  accessId: string;
  capId: string;
}

// Mirror avow-sdk createMandate, but run both transactions through execute() so each
// waits for indexing before the next. The SDK's own version fires the two back to back
// and races the gas-coin version on a busy node.
export async function createMandateAndAccess(params: {
  agent: string;
  perMoveCap: bigint;
  dailyCap: bigint;
  expiryEpoch: bigint;
  restrictTargets?: boolean;
}): Promise<CreatedMandate> {
  const AVOW = config.avow.packageId;

  const txMandate = new Transaction();
  txMandate.moveCall({
    target: `${AVOW}::mandate::create_entry`,
    arguments: [
      txMandate.pure.address(params.agent),
      txMandate.pure.u64(params.perMoveCap),
      txMandate.pure.u64(params.dailyCap),
      txMandate.pure.u64(params.expiryEpoch),
      txMandate.pure.bool(params.restrictTargets ?? false),
    ],
  });
  const r1 = await execute(txMandate);
  const mandateId = createdId(r1.objectChanges, "::mandate::Mandate");
  const capId = createdId(r1.objectChanges, "::mandate::MandateCap");

  const txAccess = new Transaction();
  txAccess.moveCall({
    target: `${AVOW}::record::create_access`,
    arguments: [txAccess.object(mandateId), txAccess.object(capId)],
  });
  const r2 = await execute(txAccess);
  const accessId = createdId(r2.objectChanges, "::record::EvidenceAccess");

  return { mandateId, accessId, capId };
}

// Read an agent's linked mandate id from chain (for the verify reveal).
export async function agentMandateId(agentId: string): Promise<string> {
  const obj = await sui.getObject({ id: agentId, options: { showContent: true } });
  const f = (obj.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields;
  if (!f) throw new Error(`agent ${agentId} not found`);
  return String(f.mandate_id);
}

// --- registry ---

export async function claimAgent(name: string, mandateId: string, signer?: Ed25519Keypair): Promise<{ agentId: string; digest: string }> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::registry::claim_agent`,
    arguments: [
      tx.object(config.arena.nameRegistry),
      tx.pure.vector("u8", Array.from(new TextEncoder().encode(name))),
      tx.pure.id(mandateId),
    ],
  });
  const r = await execute(tx, signer);
  return { agentId: createdId(r.objectChanges, "::registry::Agent"), digest: r.digest };
}

// Rename an agent. Owner-signed; unique and rate limited on chain (max 3 lifetime, one per
// 30 days). The Sui Clock is the shared object at 0x6.
export async function renameAgent(agentId: string, newName: string, signer?: Ed25519Keypair): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::registry::rename`,
    arguments: [
      tx.object(agentId),
      tx.object(config.arena.nameRegistry),
      tx.pure.vector("u8", Array.from(new TextEncoder().encode(newName))),
      tx.object("0x6"),
    ],
  });
  return (await execute(tx, signer)).digest;
}

export async function registerForArena(agentId: string, signer?: Ed25519Keypair): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({ target: `${PKG()}::registry::register_for_arena`, arguments: [tx.object(agentId)] });
  return (await execute(tx, signer)).digest;
}

// Tier upgrades are paid in SUI. The fee is split from gas and lands in the on-chain
// Treasury balance, which the coordinator can later claim with the CoordinatorCap.
export async function upgradeAgent(agentId: string, payMist: bigint, signer?: Ed25519Keypair): Promise<string> {
  const tx = new Transaction();
  const [pay] = tx.splitCoins(tx.gas, [tx.pure.u64(payMist)]);
  tx.moveCall({
    target: `${PKG()}::registry::upgrade`,
    arguments: [tx.object(agentId), pay, tx.object(config.arena.treasuryObject)],
  });
  return (await execute(tx, signer)).digest;
}

// Sweep accumulated upgrade fees from the Treasury to its address. CoordinatorCap-gated.
export async function claimTreasury(signer?: Ed25519Keypair): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::registry::claim_treasury`,
    arguments: [tx.object(config.arena.coordinatorCap), tx.object(config.arena.treasuryObject)],
  });
  return (await execute(tx, signer)).digest;
}

// Faucet: mint tUSDC (the in-app currency for contests and duels) to a recipient. The
// coordinator holds the mint authority, so this is signed by the coordinator. `amount`
// is in base units (6 decimals).
export async function faucetMintUsdc(recipient: string, amount: bigint): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::test_usdc::mint`,
    arguments: [tx.object(config.arena.testUsdcCap), tx.pure.u64(amount), tx.pure.address(recipient)],
  });
  return (await execute(tx)).digest;
}

// --- contests / challenge duels (paid in tUSDC) ---

export const CONTEST_FORMAT = { duel: 0, multi: 1 } as const;

export async function createContest(opts: {
  game?: number;
  format: number;
  levelMin: number;
  levelMax: number;
  entryFeeUsdc: bigint;
  maxEntries: number;
}): Promise<{ contestId: string; digest: string }> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::contest::create`,
    arguments: [
      tx.pure.u8(opts.game ?? 0),
      tx.pure.u8(opts.format),
      tx.pure.u8(opts.levelMin),
      tx.pure.u8(opts.levelMax),
      tx.pure.u64(opts.entryFeeUsdc),
      tx.pure.u64(BigInt(opts.maxEntries)),
    ],
  });
  const r = await execute(tx);
  return { contestId: createdId(r.objectChanges, "::contest::Contest"), digest: r.digest };
}

// Anyone can top up a contest pool. The coordinator mints the tUSDC and funds in one tx;
// a real user would pass their own coin.
export async function fundContest(contestId: string, amountUsdc: bigint, signer?: Ed25519Keypair): Promise<string> {
  const tx = new Transaction();
  const pay = tx.moveCall({
    target: `${PKG()}::test_usdc::mint_coin`,
    arguments: [tx.object(config.arena.testUsdcCap), tx.pure.u64(amountUsdc)],
  });
  tx.moveCall({ target: `${PKG()}::contest::fund`, arguments: [tx.object(contestId), pay] });
  return (await execute(tx, signer)).digest;
}

// Real entrant joins paying the entry. The coordinator mints the entry and pays it in the
// same tx (it owns the demo agents).
export async function joinContest(
  contestId: string,
  agentId: string,
  entryFeeUsdc: bigint,
  signer?: Ed25519Keypair,
): Promise<string> {
  const tx = new Transaction();
  const pay = tx.moveCall({
    target: `${PKG()}::test_usdc::mint_coin`,
    arguments: [tx.object(config.arena.testUsdcCap), tx.pure.u64(entryFeeUsdc)],
  });
  tx.moveCall({ target: `${PKG()}::contest::join`, arguments: [tx.object(contestId), tx.object(agentId), pay] });
  return (await execute(tx, signer)).digest;
}

// Seat a house filler agent for free. CoordinatorCap-gated; never wins.
export async function joinContestAsHouse(contestId: string, agentId: string): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::contest::join_as_house`,
    arguments: [tx.object(config.arena.coordinatorCap), tx.object(contestId), tx.object(agentId)],
  });
  return (await execute(tx)).digest;
}

// Name the winner; the whole pool pays out to the winning agent's owner.
export async function settleContest(contestId: string, winnerAgentId: string): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::contest::settle`,
    arguments: [tx.object(config.arena.coordinatorCap), tx.object(contestId), tx.pure.id(winnerAgentId)],
  });
  return (await execute(tx)).digest;
}

export interface ContestEntrant {
  agentId: string;
  owner: string;
  isHouse: boolean;
}
export interface ContestState {
  contestId: string;
  game: number;
  format: number;
  status: number;
  levelMin: number;
  levelMax: number;
  entryFee: bigint;
  maxEntries: number;
  pool: bigint;
  entrants: ContestEntrant[];
}

function parseContestFields(contestId: string, f: Record<string, any>): ContestState {
  const entrants: ContestEntrant[] = (f.entrants ?? []).map((e: any) => {
    const ef = e?.fields ?? e;
    return { agentId: String(ef.agent), owner: String(ef.owner), isHouse: Boolean(ef.is_house) };
  });
  const poolRaw = typeof f.pool === "object" ? (f.pool?.fields?.value ?? f.pool?.value ?? 0) : (f.pool ?? 0);
  return {
    contestId,
    game: Number(f.game ?? 0),
    format: Number(f.format ?? 0),
    status: Number(f.status ?? 0),
    levelMin: Number(f.level_min ?? 0),
    levelMax: Number(f.level_max ?? 0),
    entryFee: BigInt(f.entry_fee ?? 0),
    maxEntries: Number(f.max_entries ?? 0),
    pool: BigInt(poolRaw),
    entrants,
  };
}

// Read a contest's live state, including who has entered and which seats are house fillers.
export async function readContest(contestId: string): Promise<ContestState | null> {
  const obj = (await sui.getObject({ id: contestId, options: { showContent: true } })) as {
    data?: { content?: { fields?: Record<string, any> } };
  };
  const f = obj.data?.content?.fields;
  return f ? parseContestFields(contestId, f) : null;
}

// Read many contests in a single RPC call (much faster than one getObject each).
export async function readContests(ids: string[]): Promise<ContestState[]> {
  if (ids.length === 0) return [];
  const objs = (await sui.multiGetObjects({ ids, options: { showContent: true } })) as {
    data?: { objectId?: string; content?: { fields?: Record<string, any> } };
  }[];
  const out: ContestState[] = [];
  for (const o of objs) {
    const id = o.data?.objectId;
    const f = o.data?.content?.fields;
    if (id && f) out.push(parseContestFields(id, f));
  }
  return out;
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
