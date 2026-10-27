# The Galta mark

Galta has one silhouette and two complementary forms: an expressive character
and a quiet outline. Both preserve the tilted body, the left shoulder and the
small fold on the right. The expressive mark is drawn from
[`galta-logo-selection.svg`](../../apps/extension/src/public/galta-logo-selection.svg)
as live geometry: the mouth has to be able to open.

The production implementation lives in `src/marks` and `src/content/collector.ts`;
the shared SVG is the authoritative source artwork.

## Outline companion

| Form | Intended use | Asset |
| --- | --- | --- |
| Expressive | Inside Galta: the canvas header, web collection interactions, guidance and the native Mac app | [`galta-logo.svg`](../../apps/extension/src/public/galta-logo.svg) for static identity; `marks/markup.ts` for the animated collector |
| Refined outline | Browser extension identity (toolbar, browser-owned side-panel heading, extension list) and Codex plugin icons | [`galta-logo-outline.svg`](../../apps/extension/src/public/galta-logo-outline.svg), exported to extension PNGs and plugin SVGs |
| Browser tab | Canvas and side panel favicon, adapting to the browser's light/dark preference | `galta-favicon.svg`, generated from the refined outline |

The authoritative outline is one closed contour with a genuinely transparent
interior. It has no face, solid backing, sticker edge or additional fold lines.
It uses one ink colour; `currentColor` works when the SVG is inline, while an
external image defaults to black. White on a dark background is an equivalent
treatment. The browser export is the one deliberate exception: it draws a
white exterior contour around the black contour and keeps the interior white,
because Dia's toolbar can be dark. The authoritative source SVG and Codex
plugin SVGs stay hollow and transparent.

The approved outline is one compound path with an even-odd fill. Its outer
contour preserves the expressive silhouette; its inner contour is deliberately
drawn to soften the shoulder, apex and right fold. It carries roughly the visual
weight of the 3× exploration, but has no single exact stroke width. The same
geometry serves all sizes; there is no alternate small cut or weight series.
Do not regenerate the authoritative outline with a uniform stroke or add a
screen-space outline. The browser export's white exterior contour belongs only
to that export and is generated in `render-brand-assets.ts`.

`galta-logo-outline.svg` is the authoritative outline artwork. All external
icon exports preserve this path. Codex's `logo` and `logoDark` use dark and
light ink respectively; its `composerIcon` is pure white because the composer
row is dark and accepts one static icon. Browser extension PNGs use a black
contour with a white exterior contour because the browser toolbar has no
reliable light/dark icon slot. Browser favicons adapt through
`prefers-color-scheme`. No variant adds a face or tile; only the browser export
has this exterior contour.

`GaltaMark` displays the expressive `galta-logo.svg` inside the app, in a 20 px
canvas-header box. It contains the artwork
without stretching; dark forced-colors mode inverts the two tones to keep the
body visible. The collector retains its animated face and protective ring.
The browser-owned side-panel heading is extension identity; the canvas header
inside that panel is in-app identity, so these adjacent surfaces use different
forms deliberately.

Run [`bun scripts/render-brand-assets.ts`](../../scripts/render-brand-assets.ts)
to export the favicon, Codex plugin SVGs, browser extension PNGs at
16/32/48/128 px, transparent black/white PNGs and the
brand preview. It reads the
approved SVG without changing its contour. `render-icons.swift` rasterizes the generated
black browser icon with its white exterior contour and separately uses the expressive
source for the native app's iconset. The preview covers light/dark backgrounds and
16–64 px. Superseded weight comparisons and trial artwork are removed.

## Collector placement

The rendered image owns placement, including under hover layers that share its
image-sized surface. The collector does not resolve through unrelated dialogs
or page chrome. It offers HTTP(S) images and video posters with both rendered
edges at least 72 CSS pixels; inline and blob URLs cannot be retained by the
collection store and are not offered.

| Scene | Anchor and obstruction rule |
| --- | --- |
| Pinterest feed, search, board and related cards | Bottom-right, 12px inset. Move left along that same row past actual native controls, leaving a 12px gap. |
| Pinterest detail main image | Top-left, 16px inset. Move down the left edge past an obstruction. Identified by `/pin/<id>/` and the media's `closeup-media-container` ancestor; related cards keep their card rule. |
| Other websites | Top-right, 12px inset. Move down the right edge past an obstruction. |

The complete 34px mark stays inside both the image and viewport. Probing is
bounded to eight placements; if its action row or edge cannot fit the mark,
hide it rather than switch corners or cover another control. A 108px Pinterest
card can still offer the mark when there is space. Cosmos's fixed right offset
and 150px width floor are not copied: current native actions can be inside the
image or below it, so actual rendered obstructions determine the reservation.

Other collectors keep their own positions and stacking order. Galta moves
past their actual hit area along its existing row or edge, retaining the scene's
gap. A closed Shadow DOM may report a zero-size host or an inert full-viewport
host for a visible button; neither host rectangle describes that button.
In those cases the collector measures the occupied edge with local hit tests,
limited to eight strides and four refinements per obstruction probe. Gap
probes prevent the adjacent controls from touching. No extension IDs, brand
selectors, host changes or additional page listeners are needed.

One shared closed Shadow DOM surface and seven listeners serve the entire page.
Pointer work is coalesced per animation frame; scroll and resize have a separate
frame. Moving from the image onto the mark keeps the same image selected.

## Collection handoff

At activation the collector captures a serializable `CollectionItemInput`,
including a fresh `id`, the current rendered `mediaUrl`, a `sourceUrl` (the Pin
or nearest HTTP(S) image link), the current `pageUrl`, and optional image `title`
and `pageTitle`. It reads `currentSrc` again at click time and freezes this input
before awaiting animation. DOM elements remain private to the animation.
Source document, snapshot and gesture IDs share `content/sourceId.ts`, which
generates UUID v4 using `getRandomValues` on both HTTP and HTTPS pages.

`content/main.ts` immediately sends `collection-add` to the extension background.
The shared collection contract and background store own normalization, durable
storage and deduplication; canvas import owns downloading and retaining bytes.
This action saves a reference, not an offline copy or an inferred original-size
image. `sourceUrl` and `pageUrl` keep the Pin and browsing context separate.

The swallow and storage handoff run together. Only an affirmative storage
response produces “Collected”; a failed response or transport produces a
visible failure and a diagnostic with the click ID. The image is restored, and
another click remains possible. Success feedback lasts 2.2 seconds and failure
feedback 5 seconds, unless the user moves to another image or starts a new
collection. Stopping removes the surface and listeners without cancelling a
handoff already submitted.

`tests/browser/collector.spec.ts` covers scene selection, 108px cards, native
actions, clipping, dialogs, detached and inline images, hover handoff, reduced
motion, frozen provenance, repeated clicks, storage acknowledgements/failures
and stop during collection, including a non-secure HTTP source page. Closed
shadow coexistence covers higher and lower stacking orders, zero-size and
inert viewport hosts, independent clicks and a crowded row.
Pinterest-origin fixtures intercept all requests
to the local Vite page; their screenshots are test evidence. Real Pinterest
acceptance additionally requires the newly built extension loaded in an
authenticated browser.

## Artwork geometry

The source variants have different canvas padding around the same artwork.
Placement uses the artwork box plus the room its ring needs, rather than the
export canvas dimensions.

| | Value |
| --- | --- |
| Artwork box | `80.22 96.18 252.88 228.74` |
| Rendered viewBox | the artwork box plus `BREATH` clearance on all sides, `70.22 86.18 272.88 248.74` |
| Head | one closed polygon, 136 points |
| Eyes | rings at `(166.93, 195.64)` and `(239.12, 216.15)`, white radius 23.38, pupil radius 13.95 |
| Eye axis | tilted 15.86° |
| Mouth, as drawn | a white lens below the eyes, spanning `−9.84 … 9.77` on the eye axis at v `17.64 … 25.02` |

The eyes sit on a tilted axis, so the face has its own frame: `x` runs along the
eye line and `y` runs down the face. Every mouth anchor is expressed in that
frame and projected back into artwork coordinates. A mouth placed in raw
artwork coordinates drifts off the face the moment it is reshaped.

## Expressive mark: two tones

The mark is ink and the paper showing through it. Both eyes are white holes in
the black silhouette, and the mouth is the same kind of hole. Nothing in the
mark is a third tone: there is no shading, no cavity colour, no gradient. An
open mouth is the same white shape drawn wider and lower, never a new surface.

## The face

The mouth's anchors come from the artwork itself, stated in the face frame
(`u` along the eye axis, `v` down the face, origin at the midpoint between the
eyes):

| | u | v |
| --- | --- | --- |
| Upper lip | −9.84 … 9.77 | 17.64 |
| Lower lip | −9.54 … 9.57 | 17.75 … 25.02 |

The mouth sits **below** the eyes, not between them. Reading it as a lens on
the eye line is the mistake that makes the rest pose disagree with the artwork.

The swallow's feed point is the face-frame point `(0, 20.1)`, projected into the
artwork box by the same helper every anchor uses, so redrawing the artwork moves
the destination with it. That projection is the mark's `MOUTH_FRACTION`, and it
is where the picture lands and what the head turns about.

Opening is stated as one function of a single `t`, so the two poses interpolate
point for point: the corners travel apart, the ceiling lifts a little, and the
floor drops. The eye rings' inner edges are at |u| = 14.14 and 14.15; at rest the
corners stop well clear of them, and at full openness they reach ±14.17 — a graze
of 0.03 units, under a hundredth of a pixel at `--mark-size`, so the widest
aperture touches the rings rather than cutting into them.

The eyes are groups, not bare circles, so the timeline can aim them at whatever
the mark is eating and narrow them on the gulp. They follow the picture's centre
into the mouth, then return to rest before the gesture ends, so the final reset
changes nothing on screen. A creature whose eyes never move reads as a symbol.

## Timing

One clock drives the mouth, the eyes and the body. The mouth is painted from
the body animation's own `currentTime` rather than from a loop of its own:
an animated `d` attribute is not reflected in the DOM, and two clocks for one
action is how a mouth and a body drift apart.

The mouth parts from the first frame, holds wide while the picture pours in,
and closes over a beat of its own once the last of it is in; a mouth that snaps
shut in one frame reads as a glitch. It does not reopen afterwards. The gulp
belongs to the body — a mouth that reopens after the bite is a stutter.

Nothing interpolates linearly between poses. A linear keyframe list has a
visible corner at every pose, where the motion abruptly changes speed. The body
runs through its poses on a monotone cubic sampled at frame rate, so it passes
each pose with continuous velocity, never overshoots between two of them and
starts and ends at rest. The mouth, the eyes and the picture are smooth
functions of the same clock.

`t = 0` is not a shut mouth: it is the artwork's own lens, which is where the
mark rests.

### Everything is a ratio, nothing is a pixel count

The mark is drawn at whatever size its context asks for, so every quantity in
the swallow is a fraction of the mark's own box:

| Quantity | Stated as |
| --- | --- |
| Where the picture goes in | the mouth's position inside the viewBox |
| What the picture narrows to | the open mouth's own width and height |
| The ring | a screen-space stroke, with clearance sized for the smallest draw |

The one that matters most is the destination: the picture narrows to exactly
the size of the hole it is going into. A keyframe of "shrink to 11 px" is a statement
about one particular control size; "shrink to the mouth" is a statement about
the mark, and it stays true at 34 px and at 220 px alike.

The proportions are exported from the mark module rather than restated by the
animation, so redrawing the artwork moves the animation with it.

A duration written at a call site is the same mistake in the time axis. The
whole gesture derives from one `BEAT`, with the beats named once.

### The picture is poured in, not moved

A single transform can only move and scale a rectangle, and a rectangle that
shrinks toward a point reads as a card being flown, however it is clipped. The
picture is therefore cut into thin bands across the direction it travels and
drawn band by band on a canvas: `marks/funnel.ts` owns the shape as pure
arithmetic, and `marks/swallow.ts` draws it.

- Every band starts at rest and accelerates into the mouth.
- Bands nearer the mouth arrive first and the far edge last, so the picture
  pours in rather than shrinking as one piece.
- Each band narrows toward the open mouth's width before it arrives, so the
  picture funnels: wide where it still lies, a ribbon where it goes in.
- The picture travels along the axis with farther to go: a portrait card pours
  toward the corner the mark sits in, a wide banner slides across. The sliver
  beyond the mouth goes in with the mouth's own row, so the picture tapers to
  one point rather than pinching at the mouth.

The copy is drawn from the element's own decoded pixels, placed by its
`object-fit` and `object-position` and cut by the frame it is seen through,
including the rounded corners of a clipping wrapper such as a Pinterest card.
Only the part inside the viewport is kept. Its first frame is the picture at
rest, pixel for pixel, so the source is hidden in the same task and only one
instance of the picture is ever on screen. A canvas may draw a cross-origin
image without reading it back, so no fetch or CORS access is involved. A
picture that cannot be drawn stays on the page; the mark still performs the
swallow.

The picture is drawn on two canvases around the mark. The back one, beneath
the mark, holds all of it, so the creature stays on top of the picture it is
eating. The front one, over the face, holds only the ribbon: bands arriving
from beyond the head come forward once they have narrowed to a ribbon, faded
in by one gradient along the travel axis, and the mouth's outline is cut out
of it. The ribbon is therefore seen crossing the face and going in through the
mouth instead of slipping behind the head. What the creature was already
sitting on goes in from beneath it. The cut-out is placed by the same pose
function the body's keyframes are sampled from, so it stays on the drawn mouth
while the body swells and turns.

Before/after filmstrips and frame pacing are recorded in
`swallow-funnel-2026-10-10`.

## What the page says afterwards

Collection is now a complete cross-surface path. The content script freezes a
serialisable `CollectionItemInput` at activation, including the media URL, the
source Pin or resource URL, the page that was being browsed, and available
titles. The background service worker owns `chrome.storage.local`; writes are
serialised so two source tabs cannot overwrite one another with stale reads.
Only HTTP(S) media is retained, records are deduplicated by media URL, and the
newest 1,000 records are kept.

The collector starts the storage request and the swallow together, but reports
**Collected** only after storage succeeds. A failed message or rejected write
leaves the mark available for another attempt and shows a bounded error message
instead of claiming success. The source surface is owned by the extension and
uses a closed shadow root, so host-page styles cannot restyle the mark or its
status.

The canvas header places a single `Collection` entry beside Time Machine in the
document-context group. Its count is the durable collection count, and the
side panel reads the same storage authority in every canvas window. It opens
as a 320 px layout column from the left: the editor gives up that width,
the search field receives focus, and drag-to-place crosses the column boundary.
The drawing dock and composer remain inside the editor's remaining space.
Column width and a slight content fade/shift share the panel motion token;
reduced motion switches the layout directly. Collapse restores the editor's
space and focuses the entry, retaining the search and browsing position.
The panel is deliberately an action surface rather than a second history:
recent references are shown first, an oldest-first choice supports long-running
research, and the first 60 results are revealed progressively so 1,000 records
remain calm and responsive. Each card can be clicked to import the reference at
the canvas centre or dragged onto the canvas to place it at a chosen point.
Opening the source and removing a card are secondary edge actions. An empty
state explains where web references arrive without covering the artwork.

The entry remains available at narrow widths as the bookmark and count while
the word `Collection` recedes. At widths of 720 px or less, the library becomes
the current content page of the desktop browser side panel; its shared Galta
header stays visible and the editor retains its scene and draft out of view.
Successfully importing a card returns to that editor. Visual
acceptance lives in `tests/browser/collection-panel.spec.ts`.

All interface copy is English. The product has no localisation layer yet, so
there is one owned set of strings rather than parallel translations that can
drift.

## The ring

The white edge is a die-cut sticker's edge, and it does the job a sticker's edge
does: it holds the black body apart from whatever is behind it. On a dark page,
a mid grey or a photograph, the white ring is what makes the mark legible. It is
the only thing that needs to be there — no scrim, no plate, no second backing.

The white edge follows the silhouette, so it is a stroke on the head's own path
with `paint-order: stroke fill` — the contour carries the edge, and no box is
ever drawn around the mark.

The stroke is declared in **screen** pixels (`--mark-ring`, with
`vector-effect: non-scaling-stroke`), because an edge measured in artwork units
would thin out as the mark shrinks and disappear at control size. That choice
has a consequence worth stating: the smaller the mark is drawn, the more artwork
units one pixel of edge is worth, and the edge reaches further past the artwork
box. At the control size a 2 px edge reaches about 8 units out, so the viewBox
clearance (`BREATH`) is 10 — enough that the ring can never be clipped by the
viewBox at any size the mark is drawn.

Measuring this protective white edge in artwork units would render a different
edge at every size. The collector needs a stable screen-space separation from
the image beneath it; the separate outline companion scales as artwork.

## Ownership

The canvas's first-run invitation draws the expressive form as native
polygons from the same geometry (`HEAD_POINTS`, `EYES`, `lipAt` in
`marks/geometry.ts`) with `--mark-ink` and `--mark-paper`; it carries no second
copy of the artwork.

The mark's ink and paper are declared in
[`tokens.css`](../../apps/extension/src/design/tokens.css) as `--mark-ink` and
`--mark-paper`, so they have one home like every other value the mark is drawn
with. They are the artwork's own colours, not theme values: no theme block may
reassign them, and no surface token may be substituted for them. The mark is
two-tone, and a themed paper colour would make it something else.

Everything else the mark is placed with — its ring, its target size, its
durations — resolves through that same file. The one exception is geometry that
only makes sense as arithmetic: `BREATH`, `BEAT`, the phase fractions and the
mouth's anchors live in `marks/geometry.ts`, because they are baked into the
viewBox and into the timeline rather than applied as style.
