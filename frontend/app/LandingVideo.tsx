"use client";

import { useEffect, useRef, useState } from "react";

// The background reel: gamified clips of the games, looping and switching. Drop the files
// into public/videos and they play; until then the dark brand backdrop shows on its own.
const CLIPS = ["/videos/poker.mp4", "/videos/chess.mp4", "/videos/prediction.mp4"];

export default function LandingVideo() {
  const [i, setI] = useState(0);
  const [gone, setGone] = useState(false);
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    ref.current?.play().catch(() => {});
  }, [i]);

  if (gone) return null;

  return (
    <video
      ref={ref}
      key={i}
      className="landing-video"
      src={CLIPS[i]}
      autoPlay
      muted
      playsInline
      onEnded={() => setI((i + 1) % CLIPS.length)}
      // If a clip is missing, advance; if none load, drop to the brand backdrop.
      onError={() => (i + 1 >= CLIPS.length ? setGone(true) : setI(i + 1))}
    />
  );
}
