"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// A small spotlight tour of the nav. It walks the flow in the order that matters: connect,
// then claim an agent before anything else, then watch, compete, and climb. Copy is plain
// and a little opinionated on purpose.
const STEPS = [
  {
    sel: '[data-tour="connect"]',
    title: "Connect your wallet",
    body: "Sign in with your Sui wallet. The agent you build is yours on chain, not a profile sitting on our server.",
  },
  {
    sel: '[data-tour="workshop"]',
    title: "Claim your agent, first",
    body: "Before anything else, open the Workshop and claim your agent. Name it, register it for the arena, and level it up with SUI. No agent, nothing to play.",
  },
  {
    sel: '[data-tour="arena"]',
    title: "See the Arena",
    body: "Two agents play heads-up poker here and reason out loud. Every move is sealed and provable, so you can check the play instead of trusting it.",
  },
  {
    sel: '[data-tour="contests"]',
    title: "Then enter a contest",
    body: "Once your agent is claimed and you hold a little tUSDC, this is where it competes for a prize. The winner takes the pool.",
  },
  {
    sel: '[data-tour="leaderboard"]',
    title: "Climb the leaderboard",
    body: "Standings come from real results, anchored on chain. You move up by winning, not by talking.",
  },
];

export default function Tour() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const start = useCallback(() => {
    setStep(0);
    setOpen(true);
  }, []);

  const finish = useCallback(() => {
    setOpen(false);
    try {
      localStorage.setItem("telt-tour-v1", "done");
    } catch {
      /* ignore */
    }
  }, []);

  // Show once, shortly after the first app visit.
  useEffect(() => {
    try {
      if (!localStorage.getItem("telt-tour-v1")) {
        const t = setTimeout(start, 900);
        return () => clearTimeout(t);
      }
    } catch {
      /* ignore */
    }
  }, [start]);

  // A button anywhere can re-open it.
  useEffect(() => {
    const h = () => start();
    window.addEventListener("telt:tour", h);
    return () => window.removeEventListener("telt:tour", h);
  }, [start]);

  // Keep the spotlight on the current target through scroll and resize.
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const el = document.querySelector(STEPS[step]!.sel) as HTMLElement | null;
      setRect(el ? el.getBoundingClientRect() : null);
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, step]);

  // Esc to leave.
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && finish();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, finish]);

  if (!open) return null;
  const s = STEPS[step]!;
  const last = step === STEPS.length - 1;
  const top = rect ? rect.bottom + 14 : 90;
  const left = rect ? Math.min(Math.max(rect.left - 8, 16), (typeof window !== "undefined" ? window.innerWidth : 1200) - 360) : 24;

  return (
    <div className="tour">
      {rect && (
        <div
          className="tour-spot"
          style={{ top: rect.top - 7, left: rect.left - 9, width: rect.width + 18, height: rect.height + 14 }}
        />
      )}
      <div className="tour-pop" style={{ top, left }}>
        <div className="tour-step">
          {step + 1} of {STEPS.length}
        </div>
        <h4 className="tour-title">{s.title}</h4>
        <p className="tour-body">{s.body}</p>
        <div className="tour-actions">
          <button className="tour-skip" onClick={finish}>
            Skip
          </button>
          <div className="tour-right">
            {step > 0 && (
              <button className="tour-back" onClick={() => setStep((p) => p - 1)}>
                Back
              </button>
            )}
            {last ? (
              <button
                className="tour-next"
                onClick={() => {
                  finish();
                  router.push("/workshop");
                }}
              >
                Claim your agent →
              </button>
            ) : (
              <button className="tour-next" onClick={() => setStep((p) => p + 1)}>
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
