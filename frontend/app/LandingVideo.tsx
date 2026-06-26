"use client";

import { useEffect, useRef, useState } from "react";

// The background reel: gamified clips of the games, looping and switching. Drop the files
// into public/videos and they play; until then the dark brand backdrop shows on its own.
const CLIPS = ["/videos/poker.mp4", "/videos/chess.mp4", "/videos/prediction.mp4"];

const PAUSE_MS = 3000; // a short breath between plays

export default function LandingVideo() {
  const [i, setI] = useState(0);
  const [gone, setGone] = useState(false);
  const ref = useRef<HTMLVideoElement>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    ref.current?.play().catch(() => {});
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [i]);

  if (gone) return null;

  // When a clip ends, hold on its last frame for a few seconds, then play the next one
  // (or replay this one if it is the only clip). The reel never stops cycling.
  const onEnded = () => {
    timer.current = window.setTimeout(() => setI((p) => (p + 1) % CLIPS.length), PAUSE_MS);
  };

  return (
    <video
      ref={ref}
      key={i}
      className="landing-video"
      src={CLIPS[i]}
      autoPlay
      muted
      playsInline
      onEnded={onEnded}
      // If a clip is missing, advance; if none load, drop to the brand backdrop.
      onError={() => (i + 1 >= CLIPS.length ? setGone(true) : setI(i + 1))}
    />
  );
}
