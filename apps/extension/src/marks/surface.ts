import tokens from '../design/tokens.css?raw'
import { markup } from './markup'

/* ===========================================================================
   The page-proof container.

   Everything Galta draws on someone else's page lives in one closed shadow
   root attached to one host element. Two directions of isolation matter and
   they are not symmetrical:

   - outward: the host page's CSS must not reach in. A closed root plus
     `:host { all: initial }` is what stops a page's `* { font-family }` or
     `body { line-height }` from restyling the mark.
   - inward: nothing we draw may reach out. The shadow boundary gives this for
     free; the host itself is the only leak risk, so it is sized explicitly and
     carries no inherited layout.

   All interface geometry — radii, motion, icon stroke, the mark's ring —
   resolves through tokens.css exactly like any other control. The host page
   cannot load that file, so it is inlined here as text; the file itself
   declares `:root, :host` so that the same sheet serves a document and a
   shadow tree without any consumer rewriting it.
   =========================================================================== */

/* The in-page layer has to beat arbitrary page stacking, so it is the largest
   value the property accepts. An extension's own `--layer-*` scale is
   meaningless here: it orders surfaces inside a Galta document, and this is a
   different document with a different stack. */
export const PAGE_LAYER = 2147480000

/* The host is appended to `documentElement` rather than `body`, because a page
   can hide or reposition its own body, and a fixed-position element inside a
   transformed ancestor stops being fixed. `all: initial` resets every inherited
   property so nothing cascades in from whatever the page set. */
function createShadowHost(doc: Document): { host: HTMLElement; root: ShadowRoot } {
  const host = doc.createElement('div')
  host.setAttribute('data-galta-collector', '')
  host.style.cssText = [
    'all: initial',
    'position: fixed',
    'inset: 0',
    'width: 0',
    'height: 0',
    'margin: 0',
    'padding: 0',
    'border: 0',
    `z-index: ${PAGE_LAYER}`,
    'pointer-events: none',
  ].join(';')
  const root = host.attachShadow({ mode: 'closed' })
  return { host, root }
}

/* Everything the surface draws, in one sheet so the root parses once.

   The mark's ink and paper are tokens like any other, with one difference
   stated in `tokens.css`: they are the artwork's own colours, so a theme may
   not reassign them. */
const SURFACE_CSS = `${tokens}
.galta-mark { display: block; overflow: visible; }
.galta-mark__head   { fill: var(--mark-ink); }
/* The sticky edge follows the silhouette, so it is the head's own contour
   stroked outside its fill. The width is in screen pixels, not artwork units:
   a stroke measured in the artwork would shrink with the mark and vanish at
   control size. */
.galta-mark__ring   { fill: none; stroke: var(--mark-paper);
                      stroke-width: var(--mark-ring);
                      paint-order: stroke fill;
                      stroke-linejoin: round;
                      vector-effect: non-scaling-stroke; }
.galta-mark__socket { fill: var(--mark-paper); }
.galta-mark__pupil  { fill: var(--mark-ink); }
/* Aimed and squinted in the mark's own units; SVG transform-box makes the
   scale pivot on the pupil rather than on the artwork's origin. */
.galta-mark__gaze { transform-box: fill-box; transform-origin: center; }
.galta-mark__lip    { fill: var(--mark-paper); }

/* The mark as a control. The inline style carries only what changes per
   placement; everything constant about it is declared once, here. */
.galta-collector__mark {
  position: fixed;
  display: none;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  pointer-events: auto;
  width: var(--mark-size);
  height: var(--mark-size);
}
.galta-collector__mark[data-shown="true"] { display: block; }
.galta-collector__mark[data-shown="true"] .galta-mark { width: 100%; height: 100%; }

/* The swallow's two layers hold the picture while it is eaten. The back one
   comes before the mark in the root, so the creature stays on top of the
   picture it is eating; the front one comes after it, for the last of the
   picture going in through the mouth. */
.galta-collector__layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
}

.galta-collector__status {
  position: fixed;
  max-width: calc(100vw - 24px);
  box-sizing: border-box;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--mark-ink);
  color: var(--mark-paper);
  font: var(--text-label)/1.4 var(--font-ui);
  box-shadow: 0 2px 8px #0002;
  pointer-events: none;
}
.galta-collector__status:empty { display: none; }

/* The canvases the picture is drawn on, placed and sized per gesture. */
.galta-pour {
  position: absolute;
  display: block;
}
`

export type CollectorSurface = {
  host: HTMLElement
  root: ShadowRoot
  mark: HTMLElement
  back: HTMLElement
  front: HTMLElement
  status: HTMLElement
}

/* Build the one mark, its two layers and the one sheet the whole page shares.

   A mark per image would mean a shadow root, a stylesheet and an SVG per image
   on a page that may hold hundreds. There is exactly one of each, moved to
   wherever the pointer is.

   This is called on the first qualifying hover rather than at content-script
   start: most pages never produce one, and the sheet is a few kilobytes that
   nothing needs until then. */
export function createSurface(doc: Document): CollectorSurface {
  const { host, root } = createShadowHost(doc)
  const style = doc.createElement('style')
  style.textContent = SURFACE_CSS
  root.append(style)

  const mark = doc.createElement('button')
  mark.type = 'button'
  mark.className = 'galta-collector__mark'
  mark.setAttribute('aria-label', 'Collect image with Galta')
  mark.setAttribute('tabindex', '-1')
  /* The mark's markup is a constant, so it is written once here and never
     regenerated. Replacing it on every hover would re-parse the artwork's
     136-point path and both eye rings at pointer cadence. */
  mark.innerHTML = markup(0)

  const [back, front] = [0, 1].map(() => {
    const layer = doc.createElement('div')
    layer.className = 'galta-collector__layer'
    return layer
  })
  root.append(back!, mark, front!)

  const status = doc.createElement('div')
  status.className = 'galta-collector__status'
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  root.append(status)

  doc.documentElement.append(host)
  return { host, root, mark, back: back!, front: front!, status }
}
