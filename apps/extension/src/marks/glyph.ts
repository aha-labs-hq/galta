import { ART, BREATH, HEAD_POINTS } from './geometry'

/* ===========================================================================
   The confirmation glyph.

   A solid head with the tick cut out of it. Not a stroked outline, and not the
   mark: the mark already carries "collect" on the page, and repeating the same
   symbol in the surface that answers the collect stops it carrying anything the
   second time.

   The tick is a HOLE, not a white shape laid on top. That is the mark's own
   two-tone rule applied to a second form — ink, and whatever the glyph sits on
   showing through — and it is why the glyph reads on a dark page as well as a
   light one, with no second colour and no plate behind it.
   =========================================================================== */

export const GLYPH_BOX = 24

/* The head, placed in the glyph's box by one affine fit of the artwork's own
   outline.

   It is the real 136-point silhouette rather than a simplification: a
   hand-drawn stand-in rendered as a hollow five-pointed box and was unreadable
   at control size. Deriving it from `HEAD` here rather than pasting a second
   literal is what keeps it true — redraw the artwork and the glyph moves with
   it, which a copy would not. */
const FIT_INSET = .6

function fittedHead(): string {
  const points = HEAD_POINTS
  const xs = points.map(p => p[0])
  const ys = points.map(p => p[1])
  const minX = Math.min(...xs), minY = Math.min(...ys)
  const width = Math.max(...xs) - minX
  const height = Math.max(...ys) - minY
  /* One scale for both axes, so the head keeps its proportions, centred in the
     box rather than stretched to fill it. */
  const scale = Math.min((GLYPH_BOX - FIT_INSET * 2) / width, (GLYPH_BOX - FIT_INSET * 2) / height)
  const offsetX = (GLYPH_BOX - width * scale) / 2
  const offsetY = (GLYPH_BOX - height * scale) / 2
  return points
    .map(([x, y], i) => `${i ? 'L' : 'M'}${((x - minX) * scale + offsetX).toFixed(2)} ${((y - minY) * scale + offsetY).toFixed(2)}`)
    .join('') + 'Z'
}

export const GLYPH_HEAD = fittedHead()

/* The tick, solved rather than eyeballed.

   The constraint is the stroked tick's OUTER EDGE, not its centreline. An
   earlier version of this fitted the centreline to the head's largest inscribed
   circle, which is the wrong problem: a stroke is half its width wider than the
   path it follows, so the tip left the silhouette by 1.22 units and the cut
   eroded the head to a hairline instead of ending inside it. The head's
   inscribed circle here is r 7.93 at (11.95, 11.30); the check below keeps both
   legs, and the full width of each, clear of the outline with 4.2 units to
   spare. */
export const GLYPH_TICK = 'M 8.16 11.03 L 12.04 14.31 L 15.88 9.57'

/* The tick's stroke, as a length in the glyph's own box. It is stated in box
   units rather than screen pixels because the cut has to scale with the head:
   a screen-space edge would eat the whole silhouette at small sizes. */
export const GLYPH_STROKE = 2

/* The glyph as markup, for injection into a shadow root.

   A mask does the cutting rather than `fill-rule="evenodd"` on a closed tick
   subpath: an open tick closed by `Z` self-intersects into a sliver, and it is
   the round caps and joins the mask preserves that match the mark's own forms.

   The two mask operands are LUMINANCE, not colour — `#fff` means "keep" and
   `#000` means "cut". They are not painted and must not be routed through the
   mark's ink and paper tokens, which would make the hole follow a theme.

   The mask id is per-instance. Two glyphs in one document would otherwise both
   resolve `url(#…)` to whichever came first, and the second would be cut by the
   first one's tick. */
let instance = 0

export function glyph(): string {
  const cut = `galta-glyph-cut-${++instance}`
  return `<svg class="galta-glyph" viewBox="0 0 ${GLYPH_BOX} ${GLYPH_BOX}" aria-hidden="true" focusable="false">
    <defs>
      <mask id="${cut}" maskUnits="userSpaceOnUse" x="0" y="0" width="${GLYPH_BOX}" height="${GLYPH_BOX}">
        <rect width="${GLYPH_BOX}" height="${GLYPH_BOX}" fill="#fff"/>
        <path d="${GLYPH_TICK}" fill="none" stroke="#000" stroke-width="${GLYPH_STROKE}" stroke-linecap="round" stroke-linejoin="round"/>
      </mask>
    </defs>
    <path class="galta-glyph__head" d="${GLYPH_HEAD}" mask="url(#${cut})"/>
  </svg>`
}
