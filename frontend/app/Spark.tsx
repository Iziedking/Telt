"use client";

import { useEffect } from "react";

// A short, clean welcome for returning visitors: the telt emblem sparks to life, the
// wordmark settles, and after three seconds it hands off to the home page.
export default function Spark({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 5000);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <div className="spark">
      <div className="spark-stage">
        <div className="spark-rays" aria-hidden>
          {Array.from({ length: 12 }).map((_, i) => (
            <span key={i} style={{ transform: `rotate(${i * 30}deg)` }} />
          ))}
        </div>
        <svg className="spark-emblem" viewBox="0 0 104 104" width="124" height="124" aria-hidden>
          <circle className="spark-ring" cx="52" cy="52" r="46" fill="none" strokeWidth="6" />
          <path className="spark-t" d="M50 28 V58 Q50 70 62 70" fill="none" strokeWidth="9" strokeLinecap="round" />
          <line className="spark-cross" x1="38" y1="40" x2="62" y2="40" strokeWidth="9" strokeLinecap="round" />
          <circle className="spark-dot" cx="71" cy="70" r="5" />
        </svg>
      </div>
      <div className="spark-word" aria-label="telt">
        <span>tel</span>
        <span className="spark-word-t">t</span>
      </div>
      <div className="spark-tag">the tell, proven</div>
    </div>
  );
}
