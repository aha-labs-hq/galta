# Reference fixtures

`reference-{pink,glass,citrus,flower}.png` are small still lifes drawn for
these tests by `draw-references.sh`; they stand in for the references a user
drags onto a canvas. On 2026-10-27 they replaced crops of a third-party video
frame, so every fixture here is Galta's own and can be published.

`canvas-video.webm` and `canvas-video.mp4` are generated two-second FFmpeg test pattern (320 × 180,
12 fps, VP9 / H.264, no audio), used to verify native playback and binary persistence.

`source-image.{jpg,webp,avif,bmp,ico}` are small format variants of the glass
fixture, used for source-byte preservation and MIME validation;
`draw-references.sh` writes them too.
