# Landing background reel

Drop gameplay clips here and the landing hero plays them on loop, switching between
them. Expected files (served from the site root as `/videos/<name>.mp4`):

- `poker.mp4`
- `chess.mp4`
- `prediction.mp4`

Notes:

- The reel is wired in `app/LandingVideo.tsx`; it cycles this list on `ended` and drops
  to the brand backdrop if a file is missing, so the landing looks right with zero, one,
  or all three present.
- Keep them muted-friendly (they autoplay muted), short (10–20s loops), and reasonably
  compressed (H.264 MP4, ~1080p) so the page stays fast.
- To change the list or order, edit `CLIPS` in `app/LandingVideo.tsx`.
