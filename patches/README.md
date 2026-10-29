# Excalidraw 0.18.1 integration patch

Bun applies the version-pinned patch declared in the root `patchedDependencies`.
Both the readable development build and the published minified production build
receive the same changes. Do not edit an installed dependency without updating
this patch. Verify with `bun install --frozen-lockfile`; Bun's text lockfile keeps
the patch path, so editing its contents does not necessarily change that file.

## Native relationship exports

The patch exports the existing `bindLinearElement`, `updateBoundElements` and
`redrawTextBoundingBox` functions, plus their declarations. Galta uses them on a
detached draft for bound arrows and text, keeping geometry and text wrapping
with the editor instead of implementing a parallel layout engine. The patch
does not change these algorithms. Production aliases are version-specific;
never carry them forward by name without checking the upgraded bundle.

`tests/browser/canvas-semantics.spec.ts` exercises creation, binding, text edits,
rotation, group movement, rebind/detach, atomic rejection, snapshot restoration
and native pointer/undo behavior. Run against both the development fixture and
a production build of that fixture. `GALTA_SEMANTICS_URL` selects the latter;
the normal extension build does not contain test fixtures.

Remove these exports if a future public Excalidraw API supports the same edits.
On upgrades, first verify the native signatures and both build modes; a passing
development bundle alone does not validate the minified production aliases.

## Host keyboard policy

`UIOptions.allowKeyboardShortcut(event)` lets Galta decline an engine shortcut
before native dispatch, including the window-level command palette and search
listeners. Returning `false` does not cancel browser defaults or text input.
The policy itself lives in `canvasShortcuts.ts`, beside the tool-key registry
used by Galta's toolbar; the dependency patch contains no Galta key bindings.

`tests/browser/canvas-shortcuts.spec.ts` covers numeric aliases, hidden engine
modes, native text entry, IME, undo/redo, zoom and focus isolation in development
and production. On upgrades, verify all global listeners as well as the canvas
handler; replace this hook when upstream exposes an equivalent shortcut policy.

## Native box selection

`AppState.boxSelectionMode` follows upstream's `"contain" | "overlap"` contract.
The engine default remains `contain`; Galta explicitly starts with `overlap` in
`ExcalidrawCanvas.initialData`. `DrawingTools` exposes the native Wrap/Overlap
choice in its existing more-tools panel, reading and updating engine app state
without capturing an undo entry. The choice lasts for the mounted editor, survives
document/history restoration, and resets to Overlap when that editor is reopened.
It is not stored in artwork or history snapshots.

The latest stable npm version at implementation time is 0.18.1, which lacks this
API. The backport lives inside the existing native selection path; Galta does not
intercept pointer events or maintain a second set of selected elements. Sources:

- [Overlap selection #11053](https://github.com/excalidraw/excalidraw/commit/d9e8a33aa4b48d920ecb9d3fde15cf0e8b72fd5c).
- [Frame correction #11250](https://github.com/excalidraw/excalidraw/commit/43fa4b56028478f53dbb65045df1f9f7737c4321).
- [Group correction #11234](https://github.com/excalidraw/excalidraw/commit/974b338b7e5fed5176cfd83b7a120b137751a1db).
- The native curve solver and ellipse/segment intersection from `packages/math`
  at that last revision. The previous numerical curve solver is replaced, not
  kept as a fallback. Ellipse intersections are bounded by the tested segment.

The selection policy is adapted to 0.18.1's geometry interfaces: unrotated bounds
come from `getElementAbsoluteCoords`; line and brush intersections consume this
release's native rotated collision shapes and caches. Brush points stay exact;
the newer upstream brush simplification and full collision-engine rewrite are
not transplanted. The upstream midpoint precheck rotated already-rotated points
twice; this backport removes the second rotation, with a real-pointer regression
case for the resulting false selection inside an empty rotated rectangle.

Further regression corrections keep 0.18.1's rejection of completely hidden
frame children, and clip the selection query itself to a child's frame before
testing its outline. Clipping only the element's bounding box can still select
an invisible part of its outline. The group lookup has no object prototype so
opaque IDs such as `constructor` cannot collide with built-in properties.

Locked objects and bound text stay excluded as direct candidates. Overlap expands
native groups; Wrap requires their selectable members to be enclosed. Native
frame clipping, Shift selection, pointer feedback, group expansion and movement
remain in the editor. Selecting a frame can include its children in raw selected
IDs; native transforms still move the frame and its children exactly once.

`tests/browser/box-selection.spec.ts` exercises real pointer gestures, both modes,
all drag directions, live shrinking, empty interiors, rotated geometry, paths,
groups (including reserved property names), bound text, locked objects, fully
hidden children, clipped outlines, frame creation/movement, zoom/pan, curved
arrows, undo across mode changes, Shift and the host menu.
Run it against development and a production build of `dev/scene-test.html`
using `GALTA_SEMANTICS_URL`, alongside native binding/undo and brush-hit tests.

Remove this backport when upgrading to a release with native `boxSelectionMode`.
Keep only Galta's initial preference and UI projection; rerun the geometry cases
before removing the midpoint correction. This is a rectangular selection change,
not a freeform lasso implementation.

## Tiled static scene

Upstream draws the interactive canvas from one cached bitmap per element, sized
to the element at the current zoom, so memory grows with the element count and
every zoom step re-rasterises every element. An agent's tracing of a few
thousand brush strokes exhausted the renderer's canvas memory: at 2× pixel
density the owner's 4,758-element canvas held 875 MB in 9,510 bitmaps, zooming
took up to 2 s a frame and the canvas went blank
([evidence](../docs/evidence/canvas-scale-2026-10-28/README.md)).

`dist/staticTiles.js`, imported by both bundles, rasterises the static scene
into 512-pixel tiles aligned to the world at the exact device scale and copies
them to the screen. Nothing is cached per element, so bitmap memory is bounded
and a frame costs the pixels on screen, whatever the element count.

- Tiles are drawn by the native static renderer in its direct, export-style
  branch (`renderConfig.directRender`). When the visible tiles to draw hold up
  to 1,500 elements they finish within the frame, as upstream's pass does;
  larger work is spread over frames in batches within an 8 ms budget, nearest
  the centre first. A missing tile then shows the previous scale's pixels, and
  a stale one keeps its pixels until the new ones are complete.
- A uniform grid indexes element bounds, padded by `getCanvasPadding`.
- A changed element re-renders the tiles under its old and new bounds and is
  drawn above them while they are pending. A new object counts as a change
  even at the same version, as it does for upstream's bitmaps: Time Machine
  interpolates copies. An element added above everything a tile holds is
  painted straight into it.
- An element that changes again within 250 ms (a drag, an arrow bound to it)
  is drawn live above the tiles instead, but only while nothing tiled belongs
  over it, so the order stays exact. Once still it stays live until something
  covers it or more than 64 are still. Erasure previews and the image being
  cropped are always live. Live elements are drawn at the tiles' device-pixel
  phase, so baking one back moves no pixel.
- `ShapeCache.delete` and `destroy` also invalidate tiles: fonts, decoded
  images, embed validation and resizes redraw without a new element version.
  Theme, pixel density and frame rendering settings drop every tile.
- Tiles live in a least-recently-used cache capped at 128 MiB; empty tiles hold
  no bitmap. A first scene, another canvas or a restored version starts over.
- Exports keep the upstream pass. Frame highlighting during a drag and the
  element-link picker draw the whole visible scene directly, without
  per-element bitmaps. Link badges are drawn above the tiles.

`StaticCanvas` passes `sceneNonce`, so membership is compared only when the
scene changes, not on every scroll. The hooks and their production aliases in
0.18.1: `_renderStaticScene` (`dp`) and its throttled entry (`cp`); the direct
branches of `renderElement` (`Fn`), where dark-mode images take
`IMAGE_INVERT_FILTER` (`Ia`) unless exporting; `ShapeCache` (`Xe`);
`getElementBounds` (`Ke`), `getCanvasPadding` (`ri`), `isIframeLikeElement`
(`gt`), `renderLinkIcon` (`sp`) and rough (`Da`); `StaticCanvas`'s call (`Kx`
in `prod/index.js`).

`tests/browser/scene-scale.spec.ts` renders 6,000 strokes at 2× density (about
1.5 GB of bitmaps without the module; under 160 MB with it, under 240 MB after
zooming to 300%) and checks pixels through an addition, recolouring,
reordering, deletion, a drag and zoom, and in every frame of a drag beneath
another element. Run it in both bundle modes. On an upgrade, re-apply the hooks
to the new renderer, or remove the module if upstream stops caching a bitmap
per element.

## Ink presentation and static scheduling

`holdStaticElements(canvas, hold)` holds committed elements out of the static
tiles while Galta's ink pen lands them (`apps/extension/src/canvas/inkPen.ts`).
A hold owns ids, a membership version and a `paint()` callback, never artwork.
Each render of the tiles calls `paint()` before synchronizing membership, and
draws the elements it returns above everything, like live elements: by the
native renderer, on the tiles' device pixels. An element the pen lets go is
painted into the tiles by that same render, by that same renderer, so the
hand-off moves no pixel. Releasing a hold restores every committed element.
Exports never use a hold.

`presentFreeDrawElement(element, outline)` (both bundles; production caches
`C1` and `he`) shows a presentation copy of a brush stroke with an outline the
caller built, here the stroke's prefix from `createFreeDrawPlayback` below: it
fills the copy's path cache and records that a transparent stroke has no fill
shape. The copy never enters the scene.

A GPU canvas antialiases overlapping translucent strokes by how many it paints
in one pass: painted into the tiles one stroke at a time, dense hatching
settles visibly darker than any later render of the same tiles. The pen
therefore lets finished work go in batches, presenting it natively until then
(`BAKE` in `inkPen.ts`); do not lower that batch without measuring settled
pixels against a complete render from screenshots. When the pen lets more than
256 held elements go at once, the tiles they touch re-render in place, keeping
their pixels until the new ones are complete, instead of starting over: what
they show is right, only incomplete. A software tile backend was tried and
removed: it matched pixels only by also slowing every re-rasterization.

`staticSceneScheduler` owns the latest requested configuration and one pending
frame per canvas. Native updates replace the configuration; presentation only
asks to redraw it. Re-entering upstream's trailing RAF throttler with a captured
configuration perpetuated old scenes alongside new ones, making completed ink
disappear and undo leave pixels. Both bundle entry points now use this scheduler
(dev `renderStaticSceneThrottled`, production `x7`; public entry `cp`).
Omitting the throttle argument still draws synchronously, as upstream does:
PNG exports and agent captures read their pixels immediately after that call.
Native renderer teardown is global and happens before DOM removal. Cancellation
therefore prunes detached canvases, and each queued frame checks its canvas is
still connected; destroying Time Machine must not stop a live canvas's pen.
`static-scene-scheduler.test.mjs` covers these three scheduling boundaries.

`ink-pen.spec.ts` checks growth, the hand-off and settled pixels from
screenshots at both device scales (reading a canvas back often moves it to
software rendering, so read-backs would measure a renderer the user never
sees), together with ordering, interruption, undo, stacking and long strokes.
`history-browser.spec.ts` checks playback waiting and decodes the exported
video to verify intermediate ink. Run them with the renderer suite in both
bundle modes. An optional `GALTA_INK_REPLAY` operations file exercises private
artwork without storing it in the repository. Remove the hold hook if upstream
provides an equivalent presentation boundary; keep one scheduler authoritative
for each canvas.

`createFreeDrawPlayback(element)` in `freeDrawPath` is a forward-only cursor
through one immutable stroke. It carries perfect-freehand 1.2.0's pressure,
streamlining and outline state, using the same brush options as the native
whole-stroke function. Only new source points are filtered. Outline points
become stable once their successor is stable and they lie outside the native
three-unit endpoint filter; stability uses committed filter length, never the
provisional tip's length, which can recede at a sharp turn. The first ten
samples establish starting pressure; before those stabilize, native computes
the short starting outline. Processed sample windows are released.

The cursor produces one closed Path2D with the native two-decimal coordinates,
including caps and sharp corners. It does not split painted ink, simplify
source points, change pressure, or write document state. Path assembly still
scales with emitted outline geometry, but source filtering is linear over the
whole playback rather than repeated for every prefix. `brush-playback.test.mjs`
compares complete command streams against native, including dense points,
pressure changes, reversals, repeated points and released sample windows; it
also bounds source-point reads. Preserve the included upstream MIT notice and
recheck parity before upgrading perfect-freehand. Only the active stroke owns
a cursor; switching strokes or finishing drops it.

## Cooperative brush rendering

`prepareFreeDrawElement(element, elementsMap, appState)` warms the native
shape cache (the brush outline and its Path2D) without mutating document state
or history; the tiled static scene keeps no per-element bitmap to warm.
Galta calls it between cooperative scheduling checkpoints, on the exact
candidate objects that will enter the editor. This prevents the first native
paint from constructing every brush outline in one task. Offscreen strokes
keep normal lazy rendering. Shape cache ownership and invalidation remain
entirely native. The shared outline adapter below
owns pressure geometry for both native rendering and worker exports.

The wrapper calls `ShapeCache.generateElementShape` (production alias `he` in
0.18.1).
`tests/browser/progressive-write.spec.ts` verifies progressive presentation,
atomic persistence, native undo/redo and cancellation in both bundle modes.
`freedraw.spec.ts` verifies native/export geometry and pixels. On upgrades,
verify both native signatures and aliases; remove this wrapper when the editor
exposes a public cache preparation API or makes its initial render cooperative.

## Cooperative history export and worker geometry

`exportToCanvas` accepts optional `checkpoint` and `prepareFreeDraw` callbacks.
The native exporter prepares bounds and shapes between checkpoints and hands the exact
prepared shapes to its final renderer, avoiding duplicate outline computation.
The optional brush callback supplies only the SVG outline; native Path2D,
closed-path fill and scene composition remain unchanged. Ordinary exports retain
the synchronous geometry path.

The upstream pure `getFreeDrawSvgPath` function and helpers are shared through
`dist/freeDrawPath.js`, exported as `@excalidraw/excalidraw/freeDrawPath`.
Both native bundles and Galta's Worker import it, including the same pinned
perfect-freehand dependency and pressure options. The adapter normalizes geometry
to the library's default pen size before outlining, then restores scene units.
Its fixed tail cutoff and dot offsets otherwise distort short strokes created or
resized at high zoom. Numeric coordinates are rounded to two decimal places before
serialization; trimming the serialized string can corrupt scientific notation.
This changes rendered stroke endpoints, not saved points, pressure or history.
Persisted preview appearance `native-png-3` invalidates the old derived PNGs. This
is one algorithm running on two threads, not a second brush renderer. Production
aliases are `wa` (pure outline), `V1` (Path2D), `vd` (shape generation).

`history-storage.spec.ts` compares worker/native export pixels, exact input
preservation and persisted PNG decoding in both build modes. Cancellation kills
obsolete worker computation; genuine worker failures surface as unavailable
previews rather than silently retrying on the main thread. Remove these hooks
when the editor supports interruptible off-thread exports through its public API.

`brush-outline.test.mjs` checks proportional scaling for short lines, corners,
closed paths and dots with measured/simulated pressure and live/completed ends.
`native-invitation.spec.ts` compares the actual illustration, provider mark and
arrow pixels after rebuilding at different camera zooms, on desktop and narrow
viewports at DPR 1 and 2. On upgrades, remove the normalization only once these
checks pass with upstream's unmodified outline function.

## Brush hit testing

Upstream reconstructs every freedraw polyline and rescans its absolute bounds
on pointer movement, even when artwork has not changed. The patch caches native
absolute coordinates and collision shapes in weak maps, invalidated by the
native element version (and the shape's center/closed state). Native mutation,
restore and undo keep owning invalidation. A bounding-box rejection avoids
walking distant stroke segments; selected bounding boxes retain the upstream
hit path. No points are simplified and zoom-dependent tolerance is unchanged.

Production aliases in 0.18.1 are `Gm` (absolute coordinates), `x1` (freedraw
collision shape), `xm` (element collision), and `ba` (bounding-box hit).
`canvas-interaction.spec.ts` covers in-place native movement/rotation, fill,
selection and restoration in both builds. `verify-canvas-interaction.ts` checks
the same scene-coordinate queries before/after, plus realistic history storage.
On upgrade, rerun these checks against upstream and remove the correction when
its collision geometry is reused or its pointer path is otherwise bounded.

## SVG Blob registration

`App.addMissingFiles` normalizes inline SVG data URLs synchronously. Galta's
editor projection supplies scene-owned `blob:` URLs while preserving the source
Blob for persistence and export. Passing those URLs to the inline Base64 decoder
throws `InvalidCharacterError` during import, cross-window sync and restoration.
Both engine bundles leave Blob URLs to the image cache's normal decoding path;
inline SVG normalization and its version increment remain unchanged.

`tests/browser/scene.spec.ts` asserts error-free SVG rendering, original Unicode
source bytes, Blob-only snapshots and inline SVG normalization. The production
panel test in `workspace-sync.spec.ts` checks import, cross-window sync, reload,
exact persisted bytes and the absence of console exceptions. Remove this guard
when upstream SVG registration handles object URLs without inline decoding.

## Image cache failure

`App.updateImageCache` captures element objects before awaiting image decoding.
History scrubbing can replace those objects during the await. On completion,
upstream deletes cached shapes only for the captured objects. The current scene
retains a cached placeholder even though the actual image has decoded. A later
failsafe skips that file because its image cache already exists.

The correction invalidates shapes for the original objects **and the current
scene** whose file IDs were updated. It retains Excalidraw's existing cache
ownership, decoding, error handling and render notification.

## Verification and removal

- `tests/browser/scene.spec.ts` repeatedly restores a new image before decoding
  completes and asserts its real canvas pixel within 350 ms. Without the patch,
  the green pixel remains gray. With it, the image paints.
- The opt-in legacy workspace test rapidly restores 13 actual history versions,
  checks rendered image pixels, and tests the production startup migration and
  history ruler. Its fixture stays outside the repository.

On an Excalidraw upgrade, test without the cache correction in both build modes.
Remove it if upstream has corrected the race; evaluate the relationship exports
separately against the public API available in that version.

## Registered clipboard actions

Native keyboard and context-menu handlers pass their original action objects
into `ActionManager.executeAction`, bypassing replacements installed through
`registerAction`. Resolve the registered action by name before dispatch in both
bundles. Galta's clipboard boundary can then encode Blob assets for portable
copies without changing selection, paste geometry or native undo. This also
covers Cut, which removes the selection only after a successful clipboard write.
`video.spec.ts` covers copying across a reload; remove this correction when
upstream dispatch consistently honors its action registry.

## Embeddable outlines and link badges

The engine draws an embeddable on the static canvas as a rough rectangle in the
element's own stroke, so every Galta page and video carried a near-black
hand-drawn outline beside the frame its own content draws, clashing with a
page's browser bar. `modifyIframeLikeForRoughOptions` now gives an embeddable a
transparent stroke in both bundles, after its existing placeholder and iframe
cases: its rendered content owns its frame.

An embeddable's link is the route to its own content, not a destination, yet
the engine drew its blue external-link badge past the top-right corner of every
unselected page and video. `renderLinkIcon` skips embeddables and
`isPointHittingLinkIcon` reports no badge for them, so no invisible hotspot is
left. Using a page stays a click on the page; read-only canvases keep their
whole-page hit, and Galta's selection actions own Open.

Element data is unchanged, so exports keep their posters and both marks return
if these corrections are removed. `object-labels.spec.ts` checks the edge and
top-right corner of a page in the development fixture and the production
extension.
