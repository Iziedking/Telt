"use client";

import { useEffect, useRef, useState } from "react";

// The background reel: gamified clips of the games, looping and switching. Drop the files
// into public/videos and they play; until then the dark brand backdrop shows on its own.
const CLIPS = ["/videos/poker.mp4", "/videos/chess.mp4", "/videos/prediction.mp4"];

const PAUSE_MS = 3000; // a short breath between plays
const FADE_S = 1.2; // seconds to ramp volume in at the start and out before the end
// Per-clip target volume (when unmuted): poker 70%, chess 50%, prediction 50%.
const VOLUMES = [0.7, 0.5, 0.5];

export default function LandingVideo() {
  const [i, setI] = useState(0);
  const [gone, setGone] = useState(false);
  // Starts muted because browsers only autoplay muted video. The sound toggle is the user
  // gesture that lets audio play; after that, volume rides the playback progress.
  const [muted, setMuted] = useState(true);
  const ref = useRef<HTMLVideoElement>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    ref.current?.play().catch(() => {});
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [i]);

  // When a clip ends, hold on its last frame for a few seconds, then play the next one.
  const onEnded = () => {
    timer.current = window.setTimeout(() => setI((p) => (p + 1) % CLIPS.length), PAUSE_MS);
  };

  // Volume follows progress, scaled to this clip's target level: fade in over the first
  // FADE_S, hold at the target through the middle, fade out before the end so the cut into
  // the pause is smooth.
  const onTimeUpdate = () => {
    const v = ref.current;
    if (!v || muted) return;
    const d = v.duration || 0;
    if (!d) return;
    const target = VOLUMES[i] ?? 0.5;
    const env = Math.min(1, v.currentTime / FADE_S, (d - v.currentTime) / FADE_S);
    v.volume = Math.max(0, Math.min(1, target * Math.max(0, env)));
  };

  if (gone) return null;

  return (
    <>
      <video
        ref={ref}
        key={i}
        className="landing-video"
        src={CLIPS[i]}
        autoPlay
        muted={muted}
        playsInline
        onEnded={onEnded}
        onTimeUpdate={onTimeUpdate}
        // If a clip is missing, advance; if none load, drop to the brand backdrop.
        onError={() => (i + 1 >= CLIPS.length ? setGone(true) : setI(i + 1))}
      />
      <button
        className="sound-btn"
        onClick={() => setMuted((m) => !m)}
        aria-label={muted ? "Turn sound on" : "Turn sound off"}
        title={muted ? "Sound on" : "Sound off"}
      >
        <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden>
          <path d="M4 9 H8 L13 5 V19 L8 15 H4 Z" fill="currentColor" />
          {muted ? (
            <path d="M16 9 L21 14 M21 9 L16 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
          ) : (
            <path d="M16 8 Q19 12 16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
          )}
        </svg>
      </button>
    </>
  );
}
