// Central game audio: one looping background track plus short one-shot game sounds. A special
// sound makes the music yield so it is heard, then the music comes back. Big moments (an event
// win) pause the music for drama; quick gameplay sounds just duck it. Files live in
// public/audio; a missing file fails silently, so sounds can be added incrementally. Mute is
// remembered across sessions. Everything is guarded for SSR.

type Sfx = "win" | "poker" | "solver";

const SFX_FILES: Record<Sfx, string> = {
  win: "/audio/win.mp3", // clap + celebration for the winner of an event
  poker: "/audio/poker.mp3", // a card/chip beat for a poker move
  solver: "/audio/solver.mp3", // a soft ding for a solver answer
};
const MUSIC_FILE = "/audio/music.mp3";

const MUSIC_VOL = 0.32;
const SFX_VOL = 0.8;
const RESUME_AFTER_MS = 3500; // resume the music after this long without a game sound
const MIN_GAP_MS = 120; // ignore sounds fired closer than this, so a burst does not clash

let music: HTMLAudioElement | null = null;
let muted = false;
let ready = false;
let primed = false;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;
let current: HTMLAudioElement | null = null; // the single game sound allowed to play at once
let lastPlayAt = 0;

function init(): void {
  if (ready || typeof window === "undefined") return;
  ready = true;
  try {
    muted = localStorage.getItem("telt-muted") === "1";
  } catch {
    /* ignore */
  }
  music = new Audio(MUSIC_FILE);
  music.loop = true;
  music.preload = "auto";
  music.volume = MUSIC_VOL;
}

export function isMuted(): boolean {
  init();
  return muted;
}

// Start (or resume) the background track. Autoplay needs a user gesture, so this is also primed
// on the first interaction via primeMusicOnGesture; a blocked play() just no-ops.
export function startMusic(): void {
  init();
  if (!music || muted) return;
  music.volume = MUSIC_VOL;
  void music.play().catch(() => {});
}

export function primeMusicOnGesture(): void {
  init();
  if (primed || typeof window === "undefined") return;
  primed = true;
  const go = () => startMusic();
  window.addEventListener("pointerdown", go, { once: true });
  window.addEventListener("keydown", go, { once: true });
}

// Stop the music entirely (used when leaving the app for the landing, so it does not keep playing
// over a page with no chrome). Also clears any pending resume and cuts a playing game sound.
export function stopMusic(): void {
  if (resumeTimer) {
    clearTimeout(resumeTimer);
    resumeTimer = null;
  }
  if (music && !music.paused) music.pause();
  if (current) {
    try {
      current.pause();
      current.currentTime = 0;
    } catch {
      /* ignore */
    }
    current = null;
  }
}

export function setMuted(m: boolean): void {
  init();
  muted = m;
  try {
    localStorage.setItem("telt-muted", m ? "1" : "0");
  } catch {
    /* ignore */
  }
  if (!music) return;
  if (m) {
    music.pause();
    if (current) {
      try {
        current.pause();
      } catch {
        /* ignore */
      }
      current = null;
    }
  } else void music.play().catch(() => {});
}

// Play a one-shot game sound. Only one plays at a time: a new one cuts off the previous, so a
// burst of moves does not pile into a clashing wall of sound. The background music pauses while
// game sounds play and resumes only after a short gap of silence, so it stays out of the way
// through a match instead of fighting the game audio. The opts arg is accepted but ignored now
// that every game sound pauses the music.
export function play(sfx: Sfx, _opts?: { pauseMusic?: boolean }): void {
  init();
  if (muted) return;

  // Drop sounds fired almost on top of each other.
  const now = Date.now();
  if (now - lastPlayAt < MIN_GAP_MS) return;
  lastPlayAt = now;

  // Cut off whatever is still playing so sounds never overlap.
  if (current) {
    try {
      current.pause();
      current.currentTime = 0;
    } catch {
      /* ignore */
    }
    current = null;
  }

  let a: HTMLAudioElement;
  try {
    a = new Audio(SFX_FILES[sfx]);
  } catch {
    return;
  }
  a.volume = SFX_VOL;
  current = a;
  a.addEventListener(
    "ended",
    () => {
      if (current === a) current = null;
    },
    { once: true },
  );

  // Pause the music while game sounds play; resume only after a gap so it does not blip back on
  // between each move or answer.
  if (music && !music.paused) music.pause();
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    if (music && !muted) void music.play().catch(() => {});
  }, RESUME_AFTER_MS);

  void a.play().catch(() => {
    if (current === a) current = null;
  });
}
