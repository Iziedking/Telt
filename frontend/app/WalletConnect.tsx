"use client";

import { useEffect, useState } from "react";
import { useWallets, useConnectWallet } from "@mysten/dapp-kit";
import { Logo } from "./shell";

// A branded Sui wallet connect, replacing dapp-kit's default modal. Lists every Sui-capable wallet
// the browser exposes through the Wallet Standard (Slush, OKX, Bitget, Suiet, ... — multichain
// wallets register here too when they support Sui), connects with clear error handling, and when
// none are found points the user to install one instead of failing silently.

// Where to get a wallet when the user has none that speaks Sui.
const INSTALL = [
  { name: "Slush", note: "The native Sui wallet", url: "https://slush.app/" },
  { name: "OKX Wallet", note: "Multichain, supports Sui", url: "https://www.okx.com/web3" },
  { name: "Bitget Wallet", note: "Multichain, supports Sui", url: "https://web3.bitget.com/" },
];

export default function WalletConnect({
  triggerClassName = "chip wallet",
  triggerLabel = "Connect wallet",
}: {
  triggerClassName?: string;
  triggerLabel?: string;
}) {
  const wallets = useWallets();
  const { mutate: connect, isPending } = useConnectWallet();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const pick = (wallet: (typeof wallets)[number]) => {
    setError(null);
    setConnecting(wallet.name);
    connect(
      { wallet },
      {
        onSuccess: () => {
          setConnecting(null);
          setOpen(false);
        },
        onError: (e) => {
          setConnecting(null);
          // The most common real failure: the chosen wallet does not support Sui.
          setError(
            /sui|chain|feature|standard/i.test(e.message)
              ? `${wallet.name} could not connect on Sui. Try a Sui-enabled wallet below.`
              : e.message || "Could not connect. Try again.",
          );
        },
      },
    );
  };

  return (
    <>
      <button className={triggerClassName} data-tour="connect" onClick={() => setOpen(true)}>
        {triggerLabel}
      </button>
      {open && (
        <div className="wc-overlay" role="dialog" aria-modal="true" onClick={() => setOpen(false)}>
          <div className="wc-modal" onClick={(e) => e.stopPropagation()}>
            <button className="wc-close" onClick={() => setOpen(false)} aria-label="Close">
              ×
            </button>
            <div className="wc-mark">
              <Logo size={40} />
            </div>
            <div className="wc-title">Connect a Sui wallet</div>
            <div className="wc-sub">Telt runs on Sui. Pick a wallet to play, stake tUSDC, and own your agent.</div>

            {wallets.length > 0 ? (
              <div className="wc-list">
                {wallets.map((w) => (
                  <button key={w.name} className="wc-wallet" onClick={() => pick(w)} disabled={isPending}>
                    {w.icon ? <img className="wc-wallet-icon" src={w.icon} alt="" width={28} height={28} /> : <span className="wc-wallet-icon wc-wallet-fallback" />}
                    <span className="wc-wallet-name">{w.name}</span>
                    <span className="wc-wallet-go">{connecting === w.name ? "connecting…" : "→"}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="wc-empty">
                <div className="wc-empty-head">No Sui wallet found</div>
                <div className="wc-empty-sub">Install one of these, then come back and connect:</div>
                <div className="wc-list">
                  {INSTALL.map((w) => (
                    <a key={w.name} className="wc-wallet" href={w.url} target="_blank" rel="noreferrer">
                      <span className="wc-wallet-icon wc-wallet-fallback" />
                      <span className="wc-wallet-name">
                        {w.name}
                        <span className="wc-wallet-note">{w.note}</span>
                      </span>
                      <span className="wc-wallet-go">install ↗</span>
                    </a>
                  ))}
                </div>
              </div>
            )}

            {error && <div className="wc-error">{error}</div>}
          </div>
        </div>
      )}
    </>
  );
}
