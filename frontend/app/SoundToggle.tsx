"use client";

import { useEffect, useState } from "react";
import { isMuted, setMuted } from "./sound";

// A quiet corner toggle for the game audio, sitting just above the tutorial button. Reflects and
// persists the mute state. Rides on every app page (Chrome mounts it).
export default function SoundToggle() {
  const [muted, setMutedState] = useState(false);
  useEffect(() => setMutedState(isMuted()), []);

  const toggle = () => {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
  };

  return (
    <button
      className={`snd-btn${muted ? " muted" : ""}`}
      onClick={toggle}
      aria-label={muted ? "Turn sound on" : "Turn sound off"}
    >
      <span className="snd-btn-mark" aria-hidden>
        ♪
      </span>
      <span className="snd-btn-label">{muted ? "Sound off" : "Sound on"}</span>
    </button>
  );
}
