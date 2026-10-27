# Canvas media

Images remain Excalidraw image elements. Video is a Galta media kind using the
editor's embeddable geometry and native React `<video>` rendering. There is no
HTML document, generated player, iframe, remote player, or second geometry store.
Move, resize, rotate, group, delete and undo continue through the editor.

## Binary ownership

`document.files` holds immutable `{ id, mimeType, created, blob }` assets. Image
elements reference `fileId`; video metadata references the original `fileId` and
`posterId`, with intrinsic dimensions, duration and name. IndexedDB detaches each
asset from snapshots into `canvas-assets`; geometry changes share the original
binary record. Storage version 6 atomically converts v5 image Data URLs to Blobs
without changing snapshot addresses or logical revisions.

The editor adapter creates image Object URLs for its lifetime. A video mounts a
decoder only while activated, visible in the viewport and in a visible document.
The player releases its decoder and URLs on deactivation/unmount. Playback time,
volume and decoder state never produce document edits. Asset IDs are immutable;
replacement creates new IDs, preserving prior sources for undo and history.

The renderer looks up only its source and poster and is memoized independently
of engine geometry. Unseen media has no player or poster DOM. A single document
visibility listener suspends players in the background; returning preserves
position, volume and pause state within the current canvas session. Enter opens
a selected video, native controls own playback keys, and Escape returns focus to
the editor. Media controls distinguish downloading the original from exporting
its poster. Replacement retains geometry and remains one-step undoable.

Base64 exists only at JSON compatibility boundaries: clipboard, portable .galta
exports and the image bridge protocol. Native video transfer uses bounded chunks
with a source-version fence and reconstructs a Blob without a full base64 copy.
Local image import also keeps its source as binary. Existing data-URL workspaces
remain readable. Export schema 2 stores each source once in an asset table,
so repeated geometry/history versions do not repeat video bytes in the file.
Clipboard and workspace exports encode in short-lived workers; workspace import
also parses and decodes in a worker, including legacy image files. Full base64
and JSON export strings never run through the UI thread. Remote downloads enforce their
byte limit as data arrives, even without a reliable Content-Length header.
The editor uses a valid opaque media URI so per-frame link checks cannot throw;
legacy relative markers normalize in the editor without rewriting saved artwork.

## Observations and limits

Time Machine, PNG selection export and `canvas_capture` project videos to their saved
poster. `canvas_inspect` identifies `kind: video` and exposes dimensions/duration;
`canvas_capture` reports `videoPosterIds` so the agent cannot mistake posters for
observations of motion. `canvas_place` imports and replaces actual video files.
`canvas_extract` materializes immutable image, video and embedded HTML source
files. It returns metadata for ordinary geometry and text because those objects
do not have source bytes to write.

The current video limit is 128 MB per source. MP4, WebM, MOV and OGV require a
codec supported by the browser. Decode, transfer, cancellation and save failures
preserve existing artwork. Streaming sites and video editing are outside this
feature.

## Quality checks

`tests/browser/video-quality.spec.ts` exercises native playback keys and focus,
decoder suspension/resume, resource-URL stability, mixed-media deletion/history,
source download and replacement at 1440/360 px, worker exports, production pan
gestures and legacy markers. `tests/media-assets.test.mjs` checks cancellation of
oversized downloads with both declared and streamed lengths.

On 2026-09-21, the local macOS/Chromium 151 production build, at 1440 × 1000,
rendered a board of 200 video posters with median 16.7 ms and P95 17.3 ms across
120 pan frames after warmup. The separate active-player check keeps at most one
decoder and releases it offscreen, without URL churn during gestures. A 32 MB
portable export took 803 ms while the main thread produced 48 animation frames.
These are measured workloads, not a frame-rate guarantee for every device.

The 200-video fixture reuses a small source and poster. It verifies playback
ownership and gesture behavior, not real-media capacity. The subsequent
[capacity characterization](media-capacity.md) uses distinct 1280px/4K rasters,
up to 1,000 elements and 1.34 GB of assets. It exposes startup/preview stalls and
slow dense overviews; capacity-level performance acceptance remains open.
