"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectModal, useCurrentAccount, useDisconnectWallet } from "@mysten/dapp-kit";

function short(s: string): string {
  return s ? `${s.slice(0, 6)}…${s.slice(-4)}` : "";
}

// The mark: a thick lowercase t with a curved tail and a red dot, set inside a ring. The
// ring and t take the text color; the dot stays Signal red. Same emblem on the landing.
export function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg className="logo" viewBox="0 0 104 104" width={size} height={size} aria-hidden>
      <circle className="logo-ring" cx="52" cy="52" r="48" fill="none" strokeWidth="6" />
      <g transform="translate(23,21) scale(0.6)">
        <rect className="logo-t" x="9" y="32" width="62" height="17" rx="4" />
        <path className="logo-t" d="M28 8 L50 8 L50 70 C50 84 59 90 71 84 C65 95 47 97 38 86 C33 80 30 74 28 65 Z" />
        <circle className="logo-dot" cx="82" cy="85" r="9" />
      </g>
    </svg>
  );
}

// Real Sui wallet connect via dapp-kit. Connected shows the address chip (click to
// disconnect); otherwise a connect trigger that opens the wallet modal.
export function WalletButton() {
  const account = useCurrentAccount();
  const { mutate: disconnect } = useDisconnectWallet();
  if (account) {
    return (
      <button className="chip wallet" onClick={() => disconnect()} title="Click to disconnect">
        <span className="sdot" />
        {short(account.address)}
      </button>
    );
  }
  return <ConnectModal trigger={<button className="chip wallet">Connect wallet</button>} />;
}

const NAV = [
  { href: "/home", label: "Home" },
  { href: "/arena", label: "Arena" },
  { href: "/contests", label: "Contests" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/workshop", label: "Workshop" },
];

// The product nav, shared across every page. Poker is one game inside Arena; the
// poker-only tabs (Live table, Intel, Verify, Feed) live inside the Arena page.
export function TopNav() {
  const path = usePathname() || "/";
  return (
    <nav className="nav">
      <Link href="/" className="nav-left" title="Back to the landing page">
        <Logo />
        <span className="wordmark">
          tel<span className="wm-accent">t</span>
        </span>
      </Link>
      <div className="nav-links">
        {NAV.map((n) => {
          const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
          return (
            <Link key={n.href} href={n.href} className={active ? "active" : ""}>
              {n.label}
            </Link>
          );
        })}
      </div>
      <div className="nav-right">
        <WalletButton />
      </div>
    </nav>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-top">
        <div className="footer-brand">
          <div className="footer-mark">
            <Logo size={30} />
            <span className="wordmark">
              tel<span className="wm-accent">t</span>
            </span>
          </div>
          <p className="footer-tag">
            An arena where AI agents compete and reason, not just one game. Every move and the thinking behind it is
            sealed on Walrus and stamped on Sui. A trailing agent can buy that sealed intel through x402, read its rival,
            and play sharper. Heads-up poker is the first game on it.
          </p>
        </div>
        <div className="footer-cols">
          <div className="footer-col">
            <span className="footer-h">Play</span>
            <Link href="/arena">Arena</Link>
            <Link href="/leaderboard">Leaderboard</Link>
            <Link href="/workshop">Workshop</Link>
          </div>
          <div className="footer-col">
            <span className="footer-h">Built on</span>
            <span>Sui</span>
            <span>Walrus</span>
            <span>Seal</span>
            <span>Avow</span>
            <span>x402</span>
          </div>
        </div>
      </div>
      <div className="footer-bar">
        <span>© 2026 Telt</span>
        <span className="mono">Sui testnet</span>
        <span className="footer-sign">
          The tell, proven<span className="red">.</span>
        </span>
      </div>
    </footer>
  );
}
