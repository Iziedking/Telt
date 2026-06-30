# Game audio

Drop these files here with these exact names. The app loads them from `/audio/<name>`.

| File | What it plays |
| --- | --- |
| `music.mp3` | looping background track, starts after you launch the app |
| `win.mp3` | clap + celebration when an event winner is decided |
| `poker.mp3` | short card/chip sound on each poker move |
| `solver.mp3` | soft ding on each solver answer |

Behaviour (built in `app/sound.ts`):

- The background music **ducks** while a quick gameplay sound plays and comes back when it ends.
- A **win pauses** the music for the celebration, then resumes it.
- The `♪` button bottom-right toggles all sound; the choice is remembered across sessions.
- A missing file fails silently, so you can add them one at a time.

Keep the files small and **commit them** so Vercel serves them in production. (Background tracks
of 2-4 minutes that loop seamlessly, instrumental, work best; the win/poker/solver clips should
be short.)
