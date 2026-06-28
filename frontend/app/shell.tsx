"use client";

import { useState } from "react";
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
      <button className="chip wallet" data-tour="connect" onClick={() => disconnect()} title="Click to disconnect">
        <span className="sdot" />
        {short(account.address)}
      </button>
    );
  }
  return <ConnectModal trigger={<button className="chip wallet" data-tour="connect">Connect wallet</button>} />;
}

const NAV = [
  { href: "/home", label: "Home", tour: undefined as string | undefined },
  { href: "/arena", label: "Arena", tour: "arena" },
  { href: "/contests", label: "Contests", tour: "contests" },
  { href: "/leaderboard", label: "Leaderboard", tour: "leaderboard" },
  { href: "/workshop", label: "Workshop", tour: "workshop" },
];

// The product nav, shared across every page. Poker is one game inside Arena; the
// poker-only tabs (Live table, Intel, Verify, Feed) live inside the Arena page.
export function TopNav() {
  const path = usePathname() || "/";
  const [menuOpen, setMenuOpen] = useState(false);
  const isActive = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <nav className="nav">
      <Link href="/" className="nav-left" title="Back to the landing page">
        <Logo />
        <span className="wordmark">
          tel<span className="wm-accent">t</span>
        </span>
      </Link>
      <div className="nav-links">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={isActive(n.href) ? "active" : ""} data-tour={n.tour}>
            {n.label}
          </Link>
        ))}
      </div>
      <div className="nav-right">
        <button
          className="nav-help"
          onClick={() => window.dispatchEvent(new Event("telt:tour"))}
          aria-label="Take the tour"
          title="Take the tour"
        >
          ?
        </button>
        <WalletButton />
        <button
          className="nav-burger"
          onClick={() => setMenuOpen((o) => !o)}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
            {menuOpen ? (
              <path d="M5 5 L19 19 M19 5 L5 19" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            ) : (
              <path d="M4 7 H20 M4 12 H20 M4 17 H20" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            )}
          </svg>
        </button>
      </div>
      {menuOpen && (
        <div className="nav-mobile">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={isActive(n.href) ? "active" : ""}
              onClick={() => setMenuOpen(false)}
            >
              {n.label}
            </Link>
          ))}
        </div>
      )}
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
            and play sharper. Heads-up poker and a live quiz solver are the first games on it.
          </p>
        </div>
        <div className="footer-cols">
          <div className="footer-col">
            <span className="footer-h">Play</span>
            <Link href="/arena">Arena</Link>
            <Link href="/solver">Solver</Link>
            <Link href="/contests">Contests</Link>
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
