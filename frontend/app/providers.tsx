"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createNetworkConfig, SuiClientProvider, WalletProvider } from "@mysten/dapp-kit";
import "@mysten/dapp-kit/dist/index.css";

// Sui wallet connect, the real thing. The connect button and modal come from dapp-kit;
// the WalletProvider keeps the connected account in context for the nav.
// Sui's public fullnode (fullnode.testnet.sui.io) started returning 404 to every RPC call in July
// 2026, which broke wallet balances and every on-chain read in the browser. The browser only makes
// indexed reads (balances, owned objects), so it needs a node with an index store: suiscan has one
// and is not rate limited. Do NOT use nodeinfra here, it has no index store and balances would fail.
// NEXT_PUBLIC_SUI_RPC repoints it without a code change.
const SUI_RPC = process.env.NEXT_PUBLIC_SUI_RPC ?? "https://rpc-testnet.suiscan.xyz";

const { networkConfig } = createNetworkConfig({
  testnet: { url: SUI_RPC, network: "testnet" },
});
const queryClient = new QueryClient();

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networkConfig} defaultNetwork="testnet">
        <WalletProvider autoConnect>{children}</WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  );
}
