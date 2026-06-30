"use client";

import { useEffect, useState } from "react";
import { useWallets, useConnectWallet } from "@mysten/dapp-kit";
import { Logo } from "./shell";

// A branded Sui wallet connect, replacing dapp-kit's default modal. Two panels: the detected Sui
// wallets on the left, the connection status with a retry on the right. Any Wallet-Standard Sui
// wallet shows up automatically — Slush, plus multichain wallets like OKX, Bitget, and Phantom that
// also support Sui — so there is no allowlist. When the browser exposes no Sui wallet at all, the
// right panel points the user to install one.

// The native Sui wallet to install when the user has none. Multichain wallets (OKX, Bitget,
// Phantom) are not listed here on purpose: they are detected automatically when installed, so
// suggesting them as a download would be wrong.
const INSTALL_SLUSH = "https://slush.app/";

export default function WalletConnect({
  triggerClassName = "chip wallet",
  triggerLabel = "Connect wallet",
}: {
  triggerClassName?: string;
  triggerLabel?: string;
}) {
  const wallets = useWallets();
  const { mutate: connect } = useConnectWallet();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "connecting" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Default the right panel to the first wallet so the modal is not empty.
  useEffect(() => {
    if (open && wallets.length > 0 && !selected) setSelected(wallets[0]!.name);
  }, [open, wallets, selected]);

  const selectedWallet = wallets.find((w) => w.name === selected) ?? null;

  const tryConnect = (name: string) => {
    const wallet = wallets.find((w) => w.name === name);
    if (!wallet) return;
    setSelected(name);
    setStatus("connecting");
    setError(null);
    connect(
      { wallet },
      {
        onSuccess: () => {
          setStatus("idle");
          setOpen(false);
        },
        onError: (e) => {
          setStatus("failed");
          setError(
            /sui|chain|feature|standard/i.test(e.message)
              ? `${name} could not connect on Sui. Make sure it is set to a Sui account.`
              : e.message || "Connection failed.",
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

            {/* Left: the detected Sui wallets. */}
            <div className="wc-left">
              <div className="wc-left-title">Connect a wallet</div>
              {wallets.length > 0 ? (
                <div className="wc-list">
                  {wallets.map((w) => (
                    <button
                      key={w.name}
                      className={`wc-wallet${selected === w.name ? " active" : ""}`}
                      onClick={() => tryConnect(w.name)}
                    >
                      {w.icon ? (
                        <img className="wc-wallet-icon" src={w.icon} alt="" width={28} height={28} />
                      ) : (
                        <span className="wc-wallet-icon wc-wallet-fallback" />
                      )}
                      <span className="wc-wallet-name">{w.name}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="wc-none">No Sui wallet detected.</div>
              )}
            </div>

            {/* Right: connection status, or the install prompt when nothing is detected. */}
            <div className="wc-right">
              {wallets.length === 0 ? (
                <div className="wc-panel">
                  <div className="wc-mark">
                    <Logo size={44} />
                  </div>
                  <div className="wc-panel-title">No Sui wallet found</div>
                  <div className="wc-panel-sub">
                    Install Slush, the native Sui wallet, then come back and connect. Multichain wallets like OKX,
                    Bitget, and Phantom also work once they are installed and set to a Sui account.
                  </div>
                  <a className="wc-cta" href={INSTALL_SLUSH} target="_blank" rel="noreferrer">
                    Get Slush ↗
                  </a>
                </div>
              ) : selectedWallet ? (
                <div className="wc-panel">
                  <div className="wc-panel-icon">
                    {selectedWallet.icon ? (
                      <img src={selectedWallet.icon} alt="" width={56} height={56} />
                    ) : (
                      <span className="wc-wallet-icon wc-wallet-fallback" style={{ width: 56, height: 56 }} />
                    )}
                  </div>
                  <div className="wc-panel-title">Opening {selectedWallet.name}</div>
                  <div className={`wc-panel-status${status === "failed" ? " failed" : ""}`}>
                    {status === "connecting"
                      ? "Confirm in your wallet…"
                      : status === "failed"
                        ? error || "Connection failed"
                        : "Approve the connection in your wallet."}
                  </div>
                  {status === "failed" && (
                    <button className="wc-cta" onClick={() => tryConnect(selectedWallet.name)}>
                      Retry connection
                    </button>
                  )}
                </div>
              ) : (
                <div className="wc-panel">
                  <div className="wc-mark">
                    <Logo size={44} />
                  </div>
                  <div className="wc-panel-sub">Pick a wallet to connect on Sui.</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
