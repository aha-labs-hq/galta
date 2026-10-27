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

## Cooperative brush rendering

`prepareFreeDrawElement(element, elementsMap, appState)` warms the existing
native shape and bitmap caches without mutating document state or history.
Galta calls it between cooperative scheduling checkpoints, on the exact
candidate objects that will enter the editor. This prevents the first native
paint from constructing every brush outline in one task. Offscreen strokes
keep normal lazy rendering. Cache ownership, invalidation, bitmap size limits
and zoom invalidation remain entirely native. The shared outline adapter below
owns pressure geometry for both native rendering and worker exports.

The wrapper calls `ShapeCache.generateElementShape` and
`generateElementWithCanvas` (production aliases `he` and `F1` in 0.18.1).
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
