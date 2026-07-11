// Sui's public fullnode (fullnode.testnet.sui.io) began returning 404 to every JSON-RPC call in
// July 2026. avow-sdk@0.3.1 builds its client with getJsonRpcFullnodeUrl(network) and offers no way
// to override the URL, so that dead host is baked into the one SuiJsonRpcClient the whole process
// shares. The result is that anchoring, settlement, the faucet, and intel all fail with a 404.
//
// Until the SDK accepts an RPC option (avow is ours, so that is the real fix), rewrite requests to
// the dead host at the fetch layer. This catches the SDK's client and every other Sui caller at
// once. SUI_RPC_URL repoints it without a code change if this endpoint degrades too.
//
// Import this FIRST in server.ts, before anything that constructs a Sui client.

const DEAD_HOST = /^https:\/\/fullnode\.(?:testnet|mainnet|devnet)\.sui\.io(?::443)?/i;
const REPLACEMENT = (process.env.SUI_RPC_URL || "https://rpc-testnet.suiscan.xyz").replace(/\/+$/, "");

const upstream = globalThis.fetch;
type FetchArgs = Parameters<typeof upstream>;

globalThis.fetch = function patchedFetch(input: FetchArgs[0], init?: FetchArgs[1]): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  if (typeof url === "string" && DEAD_HOST.test(url)) {
    const rewritten = url.replace(DEAD_HOST, REPLACEMENT);
    // Preserve method, headers and body when the caller passed a Request object.
    if (input instanceof Request) return upstream(new Request(rewritten, input), init);
    return upstream(rewritten, init);
  }
  return upstream(input, init);
} as typeof fetch;

console.log(`[rpc] Sui fullnode calls rewritten to ${REPLACEMENT} (upstream fullnode.*.sui.io returns 404)`);
