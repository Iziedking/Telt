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
const DUCK_VOL = 0.06;
const SFX_VOL = 0.85;

let music: HTMLAudioElement | null = null;
let muted = false;
let ready = false;
let primed = false;
let restoreTimer: ReturnType<typeof setTimeout> | null = null;

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

export function setMuted(m: boolean): void {
  init();
  muted = m;
  try {
    localStorage.setItem("telt-muted", m ? "1" : "0");
  } catch {
    /* ignore */
  }
  if (!music) return;
  if (m) music.pause();
  else void music.play().catch(() => {});
}

function restoreMusic(): void {
  if (!music || muted) return;
  music.volume = MUSIC_VOL;
  if (music.paused) void music.play().catch(() => {});
}

// Play a one-shot game sound. The music ducks (or pauses for a win) while it plays and comes
// back when it ends. A safety timer restores the music even if "ended" never fires.
export function play(sfx: Sfx, opts: { pauseMusic?: boolean } = {}): void {
  init();
  if (muted) return;
  let a: HTMLAudioElement;
  try {
    a = new Audio(SFX_FILES[sfx]);
  } catch {
    return;
  }
  a.volume = SFX_VOL;

  if (music && !music.paused) {
    if (opts.pauseMusic) music.pause();
    else music.volume = DUCK_VOL;
  }
  const back = () => {
    if (restoreTimer) clearTimeout(restoreTimer);
    restoreTimer = null;
    restoreMusic();
  };
  a.addEventListener("ended", back, { once: true });
  a.addEventListener("error", back, { once: true });
  if (restoreTimer) clearTimeout(restoreTimer);
  restoreTimer = setTimeout(back, opts.pauseMusic ? 9000 : 4000);

  void a.play().catch(back);
}
