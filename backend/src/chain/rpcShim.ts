// Sui's public fullnode (fullnode.testnet.sui.io) began returning 404 to every JSON-RPC call in
// July 2026. avow-sdk@0.3.1 builds its client with getJsonRpcFullnodeUrl(network) and gives no way
// to override the URL, so that dead host is baked into the single SuiJsonRpcClient the whole process
// shares. Anchoring, settlement, the faucet and intel all died with it.
//
// Until the SDK takes an RPC option (avow is ours, so that is the real fix), rewrite requests to the
// dead host at the fetch layer, which catches the SDK's client and every other Sui caller at once.
//
// The awkward part: no free testnet endpoint does everything (measured 2026-07-11).
//   blockvision : index OK, history OK, but returns 429 under anchor load
//   suiscan     : index OK, history MISSING ("Could not find the referenced transaction events")
//   nodeinfra   : history OK, index MISSING ("Index store not available on this Fullnode")
// verify needs history; getBalance/getOwnedObjects/queryEvents need the index store. So route each
// call to a node that can actually serve it and keep blockvision as the backstop instead of
// hammering it into a 429. Retry the next endpoint on 429/5xx rather than dropping the move.
//
// The durable fix is an API key (one endpoint, high limits) or an RPC option in avow-sdk.
// SUI_RPC_URL overrides every pool with a comma separated list, highest priority first.
//
// Import this FIRST in server.ts, before anything constructs a Sui client.

const DEAD_HOST = /^https:\/\/fullnode\.(?:testnet|mainnet|devnet)\.sui\.io(?::443)?/i;

const BLOCKVISION = "https://sui-testnet-endpoint.blockvision.org"; // complete, but rate limited
const SUISCAN = "https://rpc-testnet.suiscan.xyz"; // index, no history
const NODEINFRA = "https://sui-testnet.nodeinfra.com"; // history, no index

const OVERRIDE = (process.env.SUI_RPC_URL || "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

// Owner/balance/event lookups need the index store. Transaction reads need history. Writes stay on
// the endpoint we have actually seen land transactions. Everything else can go anywhere.
const POOLS = {
  index: [SUISCAN, BLOCKVISION],
  history: [NODEINFRA, BLOCKVISION],
  write: [BLOCKVISION, SUISCAN, NODEINFRA],
  any: [SUISCAN, NODEINFRA, BLOCKVISION],
};

const HISTORY_METHODS = new Set(["sui_getTransactionBlock", "sui_multiGetTransactionBlocks", "sui_getEvents"]);
const WRITE_METHODS = new Set([
  "sui_executeTransactionBlock",
  "sui_dryRunTransactionBlock",
  "sui_devInspectTransactionBlock",
]);

function poolFor(method: string | undefined): string[] {
  if (OVERRIDE.length) return OVERRIDE;
  if (!method) return POOLS.any;
  if (WRITE_METHODS.has(method)) return POOLS.write;
  if (HISTORY_METHODS.has(method)) return POOLS.history;
  if (method.startsWith("suix_")) return POOLS.index; // suix_* is the indexed namespace
  return POOLS.any;
}

function methodOf(body: unknown): string | undefined {
  try {
    const text = typeof body === "string" ? body : body instanceof ArrayBuffer ? new TextDecoder().decode(body) : "";
    if (!text) return undefined;
    const parsed = JSON.parse(text) as { method?: string } | { method?: string }[];
    return Array.isArray(parsed) ? parsed[0]?.method : parsed.method;
  } catch {
    return undefined;
  }
}

const upstream = globalThis.fetch;
type FetchArgs = Parameters<typeof upstream>;
type Body = FetchArgs[1] extends { body?: infer B } | undefined ? B : never;

globalThis.fetch = async function patchedFetch(input: FetchArgs[0], init?: FetchArgs[1]): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  if (typeof url !== "string" || !DEAD_HOST.test(url)) return upstream(input, init);

  // Buffer the request: a Request body is a one-shot stream and would be spent after the first try.
  let method = init?.method;
  let headers = init?.headers;
  let body: Body = init?.body as Body;
  if (input instanceof Request) {
    method = input.method;
    headers = input.headers;
    body = (input.body ? await input.arrayBuffer() : undefined) as Body;
  }

  const endpoints = poolFor(methodOf(body));
  let lastErr: unknown;
  for (const endpoint of endpoints) {
    try {
      const res = await upstream(url.replace(DEAD_HOST, endpoint), { ...init, method, headers, body } as FetchArgs[1]);
      // Throttled or unhealthy: fall through to the next endpoint instead of failing the call.
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${endpoint} returned ${res.status}`);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("every Sui RPC endpoint failed");
} as typeof fetch;

console.log(
  `[rpc] Sui fullnode rewritten (upstream 404s). index=${POOLS.index[0]} history=${POOLS.history[0]} write=${POOLS.write[0]}` +
    (OVERRIDE.length ? ` (SUI_RPC_URL override: ${OVERRIDE.join(",")})` : ""),
);
