import { faucetMintUsdc, coordinatorAddress } from "../chain/sui.js";
const addr = coordinatorAddress();
const digest = await faucetMintUsdc(addr, 250_000_000n);
console.log("minted 250 tUSDC to", addr, "\ndigest", digest);
