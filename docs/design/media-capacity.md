# Media capacity characterization

Measured on 2026-09-21. The canvas opens workloads with 1,000 independent media
elements, but it does **not** yet meet a consistently smooth interaction bar at
that scale. Even 100–300 elements can trigger a noticeable startup or background
preview stall. Functional success is not a performance acceptance result.

This records the media baseline before integrating upstream history playback
and preview scheduling changes from `2d19d93`. The subsequent integration was
functionally regression-tested; the timings below were not remeasured after it.

## Method

Apple M1, 16 GB RAM, macOS 15.7.9, headless Chromium 151.0.7922.34 with the Apple
Metal renderer, production build, 1440 × 1000 viewport. Each workload uses a new
temporary persistent browser profile and the actual IndexedDB repository.
After seeding, the fixture page is closed and a fresh application page is opened.
Browser and OS disk caches are warm; this is not an OS-cold launch or a memory
peak measurement. Runtime connection state is mocked, as in other browser tests.

Every image/poster has distinct JPEG pixels and its own asset ID. Standard
rasters are 1280 × 720 at JPEG quality 0.85, about 337 KB each; the high-resolution
case uses 3840 × 2160 images, about 3 MB each. Video sources are a valid tiny WebM
with synthetic tail padding to control stored byte size. The test characterizes
idle media, not the cost of decoding 1,000 actual videos or particular codecs.

An overview fits all elements into the viewport. A spread uses eight columns of
340 × 215 scene units, with about 20 elements initially visible; mixed media is
interleaved. Each pan phase has 20 warmup frames and 180 measured frames. The
steady phase alternates ±2 px horizontally. The sweep moves down 24 px/frame,
bringing uncached content into view. Results are one full matrix run, not a
statistical device certification. Preliminary incognito measurements and a
separate CPU-profile run are excluded from the table.

## Results

P95 and maximum are frame intervals in milliseconds; lower is better. A 60 Hz
frame budget is about 16.7 ms. A good P95 does not erase a single visible stall.
First-ready means the scene and requested images have loaded, **not** that all
background preview work has finished.

| Workload | Logical source + raster size | First-ready | Steady pan P95 / max | Sweep P95 / max |
| --- | ---: | ---: | ---: | ---: |
| 100 videos, all visible | 134 MB | 0.34 s | 17.5 / 53.8 | 17.7 / 55.5 |
| 300 videos, all visible | 401 MB | 0.51 s | 19.3 / 133.2 | 17.5 / 17.8 |
| 1,000 videos, all visible | 1.34 GB | 1.63 s | 62.6 / 470.8 | 48.4 / 217.6 |
| 1,000 videos, spread | 1.34 GB | 0.46 s | 17.4 / 456.5 | 17.7 / 30.9 |
| 100 images, all visible | 34 MB | 0.71 s | 17.7 / 76.9 | 17.7 / 17.9 |
| 300 images, all visible | 101 MB | 1.55 s | 17.7 / 141.2 | 17.7 / 17.9 |
| 1,000 images, spread | 337 MB | 0.74 s | 17.3 / 17.8 | 31.7 / 42.4 |
| 100 4K images, spread | 297 MB | 1.08 s | 17.8 / 408.3 | 17.9 / 179.0 |
| 150 images + 150 videos, spread | 251 MB | 0.45 s | 17.7 / 139.6 | 20.0 / 28.1 |
| 100 videos at 10 MB + 20 history snapshots | 1.03 GB | 0.32 s | 17.6 / 83.4 | 17.6 / 61.0 |

All ten workloads restored without application/image errors and had **zero video
decoders and zero video source Object URLs** before activation. The history case
fetched 200 asset records, not 4,000: unchanged sources are shared across its 20
snapshots. Blob byte totals describe referenced payload sizes, not physically
measured disk reads or bytes resident in JavaScript memory.

The 1,000-visible-video case had a 57 ms median pan frame, approximately 17.5 fps.
The spread of the same 1,000 videos had a 16.7 ms median but still a 456.5 ms
outlier. The 1,000-image case's renderer-process RSS snapshot totaled about
1.42 GiB; this excludes browser/GPU processes, is not a peak, and can count shared
pages. RSS varies with decoder/cache eviction. JS heap alone is not an adequate
media memory metric.

A separate 100-image CPU profile attributed about 401 ms of sampled self time
to `drawElementFromCanvas` and 397 ms to `renderElement`: the editor's bitmap
painting paths. This supports addressing bitmap preparation and final painting.
The profile does not separately measure native JPEG decoding, downsampling and
rasterization, and its instrumented timings are excluded from the matrix.

## Confirmed boundaries

- **Background previews are part of the workload.** At 300 videos, the longest
  observed startup/background task was 1,162 ms; at 300 images, 1,165 ms. The
  preview path projects every video to its poster and loads the complete scene's
  images, including offscreen ones. A short first-ready time misses this work.
- **Image and video lifecycles differ.** In the 1,000-image spread, all 1,000
  native image URLs were loaded before first-ready. In the 1,000-video spread,
  only 20 poster URLs had loaded at first-ready; background preview generation
  subsequently brought the count to 1,020. These are image load observations,
  not proof that every full-resolution bitmap stays resident.
- **Dense video overviews are expensive.** The same sources behave very
  differently when 20 versus 1,000 poster elements are visible. Reducing source
  I/O alone will not solve the observed steady-state frame cost.
- **High-resolution source images cause interaction outliers.** The 4K sweep
  had eight frames above 33.4 ms and a 179 ms maximum even though its P95 was
  17.9 ms. Average frame rate alone would hide this.
- **Storage is finite and separate from rendering capacity.** The persistent
  test origin reported a 10 GiB quota. A separate fresh profile running the
  packaged MV3 extension reported approximately the same quota. Its manifest
  has no `unlimitedStorage` permission. These are local estimates, not a fixed
  cross-device product allowance. The preliminary incognito profile rejected
  the 1.34 GB cases; that failure is not a product count limit.

## Next architecture acceptance work

The measured priorities are bounded image decoding and resolution-appropriate
display derivatives; native-canvas or level-of-detail poster rendering for
dense overviews; and preview generation that stays within a scheduling budget,
including bitmap decode and final painting. Source and historical asset reads
should also become on-demand, but these measurements do not establish them as
the dominant interaction bottleneck.

Keep original media immutable and full quality. Display derivatives should be
disposable and owned by the asset layer, with an explicit memory budget and
eviction. Export and original download must continue to resolve source assets.
The acceptance matrix should cover open, first interaction, crossing into new
regions, zooming out, history, and long editing sessions, with frame outliers and
memory growth reported alongside P95. Multi-resolution rendering, cache budgets,
and these further optimizations are **not implemented by this benchmark change**.

## Reproduce

```sh
bun run build
GALTA_MEDIA_CAPACITY=1 \
  GALTA_CHROME_PATH='/path/to/extension-capable/Chromium' \
  bunx playwright test tests/browser/media-capacity.spec.ts --workers 1 --reporter line
```

Each test saves `capacity.json` in its Playwright output directory. Use
`GALTA_MEDIA_PROFILE=1` with a single `--grep` workload to save a startup CPU
profile separately; do not combine profiled timings with the unprofiled matrix.
Tests are skipped unless explicitly enabled. They assert functional invariants,
not that every measured workload meets a responsiveness target.

The captured matrix and environment are in
`media-capacity-2026-09-21.json`.
