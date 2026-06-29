import { Transaction } from "@mysten/sui/transactions";
import { sui, coordinator, coordinatorAddress, execute } from "../chain/sui.js";

// Refill the coordinator's WAL by exchanging some of its testnet SUI for WAL through the
// Walrus testnet exchange. WAL pays for blob storage, so without it the move and dossier
// anchors fail. Each anchor costs ~0.0014 WAL, so a few WAL is thousands of anchors.
//
// Run:  npm run wal:refill            (exchanges 5 SUI for WAL by default)
//       npm run wal:refill -- 8       (exchange 8 SUI)
//
// The signer is the coordinator from SUI_PRIVATE_KEY, so send the testnet SUI to that address
// (the deployer EOA) first.

const EXCHANGE_PKG = "0x82593828ed3fcb8c6a235eac9abd0adbe9c5f9bbffa9b1e7a45cdd884481ef9f";
const EXCHANGE_ID = "0x83b454e524c71f30803f4d6c302a86fb6a39e96cdfb873c2d1e93bc1c26a3bc5";
const WAL_TYPE = "0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL";

async function walBalance(owner: string): Promise<string> {
  try {
    return (await sui.getBalance({ owner, coinType: WAL_TYPE })).totalBalance;
  } catch {
    return "?";
  }
}

async function main(): Promise<void> {
  // Touch the keypair so a missing key fails loudly before we build anything.
  coordinator();
  const addr = coordinatorAddress();
  const suiAmount = Number(process.argv[2] ?? "5");
  if (!Number.isFinite(suiAmount) || suiAmount <= 0) throw new Error("pass a positive SUI amount");
  const amountMist = BigInt(Math.floor(suiAmount * 1e9));

  const before = await walBalance(addr);
  const suiBal = (await sui.getBalance({ owner: addr })).totalBalance;
  console.log(`coordinator: ${addr}`);
  console.log(`SUI balance: ${Number(suiBal) / 1e9} SUI`);
  console.log(`WAL before:  ${before}`);
  console.log(`exchanging ${suiAmount} SUI for WAL...`);

  const tx = new Transaction();
  const [suiCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountMist)]);
  const [walCoin] = tx.moveCall({
    target: `${EXCHANGE_PKG}::wal_exchange::exchange_all_for_wal`,
    arguments: [tx.object(EXCHANGE_ID), suiCoin!],
  });
  tx.transferObjects([walCoin!], tx.pure.address(addr));

  const r = await execute(tx);
  const after = await walBalance(addr);
  console.log(`done. digest: ${r.digest}`);
  console.log(`WAL after:   ${after}`);
  console.log("Anchoring (move proofs and intel dossiers) should now write to Walrus.");
  process.exit(0);
}

main().catch((e) => {
  console.error("refill failed:", (e as Error).message);
  process.exit(1);
});
