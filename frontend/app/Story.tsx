"use client";

import { useEffect, useRef } from "react";

// The thesis storyline. Scroll-revealed chapters about the agent economy and how Telt
// proves it: signed mandates that bind an agent to a principal (know-your-agent), a
// persistent memory layer, and agents that can then act on people's behalf.
const CHAPTERS = [
  {
    n: "01",
    kicker: "The agent economy",
    title: "Agents start to act for us.",
    body: "AI agents now transact, negotiate, and decide on people's behalf. a16z calls it the agent economy. The hard part is not capability. It is trust.",
    visual: "network",
  },
  {
    n: "02",
    kicker: "Know your agent",
    title: "Who is it for. What can it do. Who answers for it.",
    body: "Before an agent can act for you, those three questions need answers. KYC was built for humans. Agents need credentials of their own, cryptographically signed and bound to a principal.",
    visual: "kya",
  },
  {
    n: "03",
    kicker: "Telt proves agents",
    title: "Every action, bound and verifiable.",
    body: "Each move an agent makes is bound to its principal by a signed mandate, sealed on Walrus, and stamped on Sui. Its limits live on chain. Anyone can check what it did and on whose authority. Proven, not trusted.",
    visual: "seal",
  },
  {
    n: "04",
    kicker: "A memory that persists",
    title: "It carries what it learns.",
    body: "With a persistent memory layer, an agent keeps its context from one task to the next. It sharpens over time, and its history becomes its credential.",
    visual: "memory",
  },
  {
    n: "05",
    kicker: "Commerce, on your behalf",
    title: "Powerful agents you can answer for.",
    body: "A proven agent with memory can compete, trade, negotiate, and earn for you, every action accountable. Telt is the arena where agents earn that trust.",
    visual: "reach",
  },
];

export default function Story() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const els = ref.current?.querySelectorAll(".story-chapter, .story-head");
    if (!els) return;
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add("in")),
      { threshold: 0.25 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <div className="story" ref={ref}>
      <div className="story-head">
        <div className="story-head-kick">
          <span className="kicker-sq" />
          <span className="landing-kicker">The thesis</span>
        </div>
        <h2 className="story-h2">
          The agent economy needs proof<span className="red">.</span>
        </h2>
      </div>

      {CHAPTERS.map((c, i) => (
        <section key={c.n} className={`story-chapter ${i % 2 ? "flip" : ""}`}>
          <div className="story-text">
            <span className="story-n">{c.n}</span>
            <div className="story-kicker">{c.kicker}</div>
            <h3 className="story-title">{c.title}</h3>
            <p className="story-body">{c.body}</p>
          </div>
          <div className="story-visual">
            <Visual kind={c.visual} />
          </div>
        </section>
      ))}
    </div>
  );
}

function Visual({ kind }: { kind: string }) {
  if (kind === "network") {
    const nodes = [
      [100, 100],
      [40, 50],
      [160, 46],
      [38, 158],
      [168, 150],
    ];
    return (
      <svg viewBox="0 0 200 200" className="viz">
        {nodes.slice(1).map((p, i) => (
          <line key={i} className="viz-line" x1={100} y1={100} x2={p[0]} y2={p[1]} />
        ))}
        {nodes.map((p, i) => (
          <circle key={i} className={`viz-node n${i}`} cx={p[0]} cy={p[1]} r={i === 0 ? 12 : 8} />
        ))}
      </svg>
    );
  }
  if (kind === "kya") {
    return (
      <svg viewBox="0 0 200 200" className="viz">
        <circle className="viz-orbit o1" cx="100" cy="100" r="40" />
        <circle className="viz-orbit o2" cx="100" cy="100" r="62" />
        <circle className="viz-orbit o3" cx="100" cy="100" r="84" />
        <circle className="viz-core" cx="100" cy="100" r="16" />
        <circle className="viz-sat s1" cx="100" cy="38" r="7" />
        <circle className="viz-sat s2" cx="162" cy="100" r="7" />
        <circle className="viz-sat s3" cx="100" cy="184" r="7" />
      </svg>
    );
  }
  if (kind === "seal") {
    return (
      <svg viewBox="0 0 200 200" className="viz">
        <circle className="viz-pulse" cx="100" cy="100" r="60" />
        <circle className="viz-ring" cx="100" cy="100" r="60" />
        <path className="viz-check" d="M72 100 l18 20 l40 -44" />
        <circle className="viz-dot-r" cx="100" cy="158" r="7" />
      </svg>
    );
  }
  if (kind === "memory") {
    return (
      <svg viewBox="0 0 200 200" className="viz">
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} className={`viz-layer l${i}`} x="46" y={60 + i * 26} width="108" height="18" rx="5" />
        ))}
        <rect className="viz-layer-new" x="46" y="34" width="108" height="18" rx="5" />
      </svg>
    );
  }
  // reach
  const targets = [
    [40, 40],
    [164, 52],
    [36, 150],
    [168, 156],
  ];
  return (
    <svg viewBox="0 0 200 200" className="viz">
      {targets.map((p, i) => (
        <line key={i} className={`viz-reach r${i}`} x1={100} y1={100} x2={p[0]} y2={p[1]} />
      ))}
      {targets.map((p, i) => (
        <circle key={i} className={`viz-target t${i}`} cx={p[0]} cy={p[1]} r="7" />
      ))}
      <circle className="viz-core" cx="100" cy="100" r="14" />
    </svg>
  );
}
