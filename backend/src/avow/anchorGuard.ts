// Circuit breaker for Avow/Walrus anchoring. Anchoring shares the coordinator's transaction
// queue (so its on-chain stamp does not race the gas coin). When Walrus degrades, anchor calls
// pile up on that queue and delay critical transactions like settling a contest pool. After a
// few consecutive failures we pause anchoring for a cooldown so the queue stays clear for the
// important work, then resume automatically once Walrus recovers. ANCHOR_ENABLED=off disables
// anchoring entirely (useful for a demo when Walrus testnet is flaky).
const HARD_OFF = (process.env.ANCHOR_ENABLED ?? "on").toLowerCase() === "off";
// Forgiving by design: Walrus testnet blips should not pause anchoring (which makes some moves
// show unanchored). Trip only after many consecutive failures, and recover quickly.
const FAIL_THRESHOLD = 8;
const COOLDOWN_MS = 15_000;

let consecutiveFails = 0;
let pausedUntil = 0;

export function anchorAllowed(): boolean {
  if (HARD_OFF) return false;
  return Date.now() >= pausedUntil;
}

export function recordAnchor(ok: boolean): void {
  if (ok) {
    consecutiveFails = 0;
    return;
  }
  consecutiveFails += 1;
  if (consecutiveFails >= FAIL_THRESHOLD) {
    pausedUntil = Date.now() + COOLDOWN_MS;
    consecutiveFails = 0;
    console.warn(`[anchor] paused for ${COOLDOWN_MS / 1000}s after repeated Walrus failures; critical txs keep flowing`);
  }
}
