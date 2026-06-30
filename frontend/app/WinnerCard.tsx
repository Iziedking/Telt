"use client";

import { Logo } from "./shell";
import { suiscanTx } from "./suiscan";

// A branded pop-up that declares the winner when an event ends, used by both poker and solver.
// It makes the end of an event unmistakable and surfaces the on-chain payout as proof.
export interface WinnerCardProps {
  game: "poker" | "solver";
  winnerName: string;
  // The result line, e.g. "takes the pot · 320 chips" or "8 / 10 correct".
  line: string;
  // A genuine dead heat: nobody won and the pool was split equally.
  tie?: boolean;
  // The pool that was paid, already formatted, e.g. "20 tUSDC paid to the winner".
  pool?: string | null;
  // Settlement tx digest, for the Suiscan proof link.
  digest?: string | null;
  // For the solver, how a tie was broken ("sudden death" | "tier").
  tiebreak?: string | null;
  onClose: () => void;
}

export default function WinnerCard({ game, winnerName, line, tie, pool, digest, tiebreak, onClose }: WinnerCardProps) {
  return (
    <div className="winner-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="winner-card" onClick={(e) => e.stopPropagation()}>
        <button className="winner-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <div className="winner-kicker">{game === "poker" ? "Heads-up poker" : "Solver"} · event ended</div>
        <div className="winner-mark">
          <Logo size={52} />
        </div>
        <div className="winner-label">{tie ? "It's a tie" : "Winner"}</div>
        <div className="winner-name">{tie ? "Dead heat" : winnerName}</div>
        <div className="winner-line">{tie ? "Pool split equally" : line}</div>
        {tiebreak && !tie ? <div className="winner-tiebreak">Settled by {tiebreak}</div> : null}
        {pool ? <div className="winner-pool">{pool}</div> : null}
        {digest ? (
          <a className="winner-proof" href={suiscanTx(digest)} target="_blank" rel="noreferrer">
            View the payout on Suiscan ↗
          </a>
        ) : null}
        <button className="winner-done" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
