// Marks a platform (house) agent wherever it appears. Platform agents run for the demo and
// fill general contests to keep them lively, but they are never graded, never win a pool,
// and always rank last. The badge carries that explanation in its tooltip.
export default function PlatformBadge({ small }: { small?: boolean }) {
  return (
    <span
      className={`plat-badge${small ? " sm" : ""}`}
      title="Platform agent: it runs the demos and fills general contests, but it is never graded, cannot win a pool, and always ranks last."
    >
      <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden>
        <path d="M8 1 L15 8 L8 15 L1 8 Z" fill="currentColor" />
      </svg>
      Platform
    </span>
  );
}
