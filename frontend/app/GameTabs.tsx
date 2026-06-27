"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// The Arena hosts several games. These tabs switch between the live ones and show what is
// coming, so the Solver and future games are discoverable from poker and back.
const GAMES = [
  { href: "/arena", label: "Poker", live: true },
  { href: "/solver", label: "Solver", live: true },
];
const SOON = ["Prediction", "Chess"];

export default function GameTabs() {
  const path = usePathname() || "";
  return (
    <div className="game-tabs">
      {GAMES.map((g) => (
        <Link key={g.href} href={g.href} className={`game-tab${path === g.href ? " active" : ""}`}>
          {g.label}
        </Link>
      ))}
      {SOON.map((s) => (
        <span key={s} className="game-tab soon">
          {s}
        </span>
      ))}
    </div>
  );
}
