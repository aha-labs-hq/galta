import { test, expect } from 'bun:test'
import {
  ART, BEAT, BREATH, EYES, MOUTH, MOUTH_FRACTION, OPEN, OPEN_MOUTH, PHASE, REST,
  TILT, VIEW, VIEW_H, VIEW_W, at, atBeat, faceScale, mouthAt, mouthOrigin,
  ofMark, ofMarkY, shape,
} from '../apps/extension/src/marks/geometry.ts'
import { markup } from '../apps/extension/src/marks/markup.ts'

/* The mark's geometry is the one thing in the collect feature that must never
   have a second copy, so these tests pin it to the artwork rather than to the
   numbers the implementation happens to produce today.

   The artwork's own facts are restated here as literals, so a change to the
   module has to be a deliberate change to the test as well. In the face frame —
   `u` along the tilted eye axis, `v` down the face, origin between the eyes —
   the eye axis is v = 0, the drawn lens spans 17.64..25.02, a fully open mouth
   reaches 33.383, and the chin is at 98.21. */
/* The tilt's value is pinned here once and the projection derives from it, so
   there is one pin rather than two copies. Two independent 15.86 constants —
   one in the module, one in this file — would let the artwork's tilt change
   without the test noticing, which is the second-source failure this file
   exists to prevent. */
test('the face tilt is the artwork\'s', () => {
  expect(TILT).toBeCloseTo(15.86 * Math.PI / 180, 9)
})

const FACE_TILT = TILT
const LIP = 17.64
const MOUTH_DEEPEST = 33.383
const CHIN = 98.21

const faceOrigin = at(0, 0)

/* How deep below the eye axis each vertex of a pose sits, in the face's own
   frame. Projecting back is the only honest check on where the mouth is. */
function depths(open) {
  return mouthAt(open).map(([u, v]) => {
    const p = at(u, v)
    return (p[0] - faceOrigin[0]) * -Math.sin(FACE_TILT) + (p[1] - faceOrigin[1]) * Math.cos(FACE_TILT)
  })
}

const width = (open) => {
  const pts = mouthAt(open).map(([u, v]) => at(u, v))
  return Math.max(...pts.map(p => p[0])) - Math.min(...pts.map(p => p[0]))
}

test('the rendered box is the artwork box plus the ring clearance on every side', () => {
  const [x, y, w, h] = VIEW.split(' ').map(Number)
  expect([x, y, w, h]).toEqual([ART.x - BREATH, ART.y - BREATH, ART.w + BREATH * 2, ART.h + BREATH * 2])
  /* The two axes' fraction helpers must agree with the box they divide by. */
  expect(VIEW_W).toBe(ART.w + BREATH * 2)
  expect(ofMark(VIEW_W)).toBeCloseTo(1, 10)
  expect(ofMarkY(VIEW_H)).toBeCloseTo(1, 10)
})

test('the mouth sits below the eyes in every pose', () => {
  /* The mistake that makes the rest pose disagree with the artwork is reading
     the mouth as a lens on the eye line. */
  for (const open of [0, .25, .5, .75, 1]) {
    const d = depths(open)
    /* Below the eye axis: never between the eyes. The rest corners sit exactly
       on the hinge line; an open pose lifts them a little, which the bound
       allows for. */
    expect(Math.min(...d)).toBeGreaterThan(LIP - 1.5)
    /* And still well clear of the chin. The deepest pose reaches 33.383 against
       a chin at 98.21, so this bound has to be tight enough that a mouth which
       grew most of the way to the chin would fail it. */
    expect(Math.max(...d)).toBeLessThan(CHIN - 60)
  }
})

test('the drawn lens is the artwork\'s own lip line, and opening deepens it by a fixed amount', () => {
  expect(Math.min(...depths(0))).toBeCloseTo(LIP, 4)
  expect(Math.max(...depths(1))).toBeCloseTo(MOUTH_DEEPEST, 4)
})

test('the mouth\'s two corner vertices are the hinge, and everything else moves', () => {
  /* `mouthAt` splits its vertices on one threshold: the two corners that sit
     exactly on the lip line take the lift branch, and the other twenty-two take
     the drop branch. That split is the only place the threshold earns its keep
     and it is invisible at open = 0, where both branches agree with the
     artwork. */
  const corners = MOUTH.map(([, v], i) => v === LIP ? i : -1).filter(i => i >= 0)
  expect(corners).toEqual([0, 10])

  /* At rest, every vertex is where the artwork drew it. */
  const rest = depths(0)
  expect(rest[0]).toBeCloseTo(LIP, 6)
  expect(rest[10]).toBeCloseTo(LIP, 6)

  /* Open, the twenty-two drop far below the hinge while the corners stay
     within a unit of it. A flipped threshold would send the corners down with
     them, which is the failure this pins. */
  const open = depths(1)
  const interior = open.filter((_, i) => i !== 0 && i !== 10)
  expect(Math.min(...interior)).toBeGreaterThan(LIP - 2)
  expect(Math.max(...interior)).toBeGreaterThan(LIP + 15)
  for (const c of corners) expect(Math.abs(open[c] - LIP)).toBeLessThan(1)
})

test('openness widens the mouth monotonically, and 1 is the widest pose', () => {
  const widths = [0, .2, .4, .6, .8, 1].map(width)
  /* Strictly increasing: the widen factor is linear in `open` with a positive
     slope, so a flat step means the coefficient changed. */
  for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThan(widths[i - 1])
})

test('the two poses have the same vertex count, so they interpolate rather than swap', () => {
  expect(REST.length).toBe(OPEN.length)
  expect(REST.length).toBe(MOUTH.length)
  /* The interpolation is exercised: every vertex of the half-open pose sits
     halfway between the two poses it is drawn from. Asserting a difference in
     the emitted string would pass even if `mix` clobbered all but the corners. */
  for (let i = 0; i < REST.length; i++) {
    expect(mouthAt(.5)[i][0]).toBeCloseTo((REST[i][0] + OPEN[i][0]) / 2, 10)
    expect(mouthAt(.5)[i][1]).toBeCloseTo((REST[i][1] + OPEN[i][1]) / 2, 10)
  }
})

test('every proportion is a fraction of the mark box, not a pixel count', () => {
  /* This is what makes the gesture identical at 34px and at 220px. If any of
     these ever became a literal, that property would be gone and nothing else
     in the suite would notice. */
  for (const v of [MOUTH_FRACTION.x, MOUTH_FRACTION.y, OPEN_MOUTH.w, OPEN_MOUTH.h]) {
    expect(v).toBeGreaterThan(0)
    expect(v).toBeLessThan(1)
  }
  /* The arrival point is pinned to its measured value rather than to a band: a
     drift of a tenth would put the picture off the mouth entirely, and a band
     would swallow it. */
  expect(MOUTH_FRACTION.x).toBeCloseTo(0.46657, 4)
  expect(MOUTH_FRACTION.y).toBeCloseTo(0.55904, 4)
  /* The aperture is the open mouth's own extent, so it is wider than it is tall
     — an inhale opens wide and stays shallow. */
  expect(OPEN_MOUTH.w).toBeGreaterThan(OPEN_MOUTH.h)
})

test('the mouth origin is the mouth, not the middle of the box', () => {
  const origin = mouthOrigin()
  expect(origin).toMatch(/^[\d.]+% [\d.]+%$/)
  const [x, y] = origin.split(' ').map(v => parseFloat(v) / 100)
  expect(x).toBeCloseTo(MOUTH_FRACTION.x, 6)
  expect(y).toBeCloseTo(MOUTH_FRACTION.y, 6)
  /* If the pivot were 50% 50% the head would turn about its centre and the
     mouth would swing away from the food it is aimed at. */
  expect(x === 0.5 && y === 0.5).toBe(false)
})

test('one clock: every duration is derived from the beat', () => {
  expect(atBeat(0)).toBe(0)
  expect(atBeat(1)).toBe(BEAT)
  expect(atBeat(.5)).toBe(BEAT * .5)
  /* The phases are fractions, ordered, and inside the timeline. */
  const order = [PHASE.commit, PHASE.gather, PHASE.open, PHASE.take, PHASE.gulp, PHASE.rebound, PHASE.settle]
  for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1])
  expect(order.at(-1)).toBeLessThan(1)
})

test('the eyes are a pair on the tilted axis, and the mouth stays clear of them', () => {
  expect(EYES.length).toBe(2)
  for (const eye of EYES) expect(eye.r).toBeGreaterThan(eye.pr)
  /* Both eye centres lie on the eye axis, which is what makes the face frame
     the right one to state the mouth in. */
  for (const eye of EYES) {
    const f = at(0, 0)
    const v = (eye.c[0] - f[0]) * -Math.sin(FACE_TILT) + (eye.c[1] - f[1]) * Math.cos(FACE_TILT)
    expect(Math.abs(v)).toBeLessThan(0.05)
  }
  /* The mouth's half-span against the eye rings' inner edges.
     At rest it is well clear — the lens stops at ±9.84 against an inner edge at
     |u| ≈ 14.14. Fully open it reaches ±14.17, which crosses by about 0.03
     units: under a hundredth of a pixel at the control size, so the aperture
     grazes the eye's outer stroke rather than cutting into the ring. The
     assertion states that real bound instead of the stronger one the design
     note claims, which full openness does not honour. */
  const innerEdge = Math.min(...EYES.map(e => {
    const f = at(0, 0)
    const u = (e.c[0] - f[0]) * Math.cos(FACE_TILT) + (e.c[1] - f[1]) * Math.sin(FACE_TILT)
    return Math.abs(u) - e.r
  }))
  const rest = Math.max(...mouthAt(0).map(([u]) => Math.abs(u)))
  const open = Math.max(...mouthAt(1).map(([u]) => Math.abs(u)))
  expect(rest).toBeLessThan(innerEdge - 4)
  expect(open - innerEdge).toBeLessThan(0.05)
})

test('a pose emits a well-formed path, so a broken vertex cannot vanish silently', () => {
  /* An SVG path with `NaN` in it is not an error the browser reports — the path
     is simply dropped, and the mark renders with no mouth. Nothing else in the
     suite would notice, so the shape of the emitted `d` is asserted here. */
  for (const open of [0, .5, 1]) {
    const d = shape(open)
    expect(d).not.toMatch(/NaN|Infinity|undefined|null/)
    expect(d.startsWith('M')).toBe(true)
    expect(d.endsWith('Z')).toBe(true)
    expect((d.match(/L/g) ?? []).length).toBe(MOUTH.length - 1)
  }
})

test('markup draws every part of the mark, and openness reaches the lip', () => {
  /* `markup` is what the surface actually injects. Its `open` argument could be
     ignored — the lip pinned at rest — and every other assertion in this file
     would still pass. */
  const rest = markup(0)
  const open = markup(1)
  for (const part of ['galta-mark__head', 'galta-mark__ring', 'galta-mark__lip']) {
    expect(rest).toContain(part)
  }
  expect((rest.match(/galta-mark__eye/g) ?? []).length).toBe(2)
  expect(rest).toContain('data-eye="0"')
  expect(rest).toContain('data-eye="1"')
  expect(rest).toContain(`viewBox="${VIEW}"`)
  /* The viewBox goes into an attribute, so it cannot carry a quote. */
  expect(VIEW).not.toContain('"')

  const lip = (html) => html.match(/galta-mark__lip" d="([^"]+)"/)[1]
  expect(lip(rest)).toBe(shape(0))
  expect(lip(open)).toBe(shape(1))
  expect(lip(rest)).not.toBe(lip(open))
})

test('the ring traces the head rather than a box around it', () => {
  /* The white edge is the head's own contour stroked, which is what makes it a
     die-cut sticker's edge rather than a plate. If it were a rect, the mark
     would be drawn inside a box — the thing the design forbids. */
  const html = markup(0)
  expect(html).not.toMatch(/<rect/)
  const paths = [...html.matchAll(/<path class="galta-mark__(head|ring)" d="([^"]+)"/g)]
  expect(paths.length).toBe(2)
  expect(paths[0][2]).toBe(paths[1][2])
})

/* A squint closes across the face, which leans: applied to the face's own
   axes, the transform must keep a vector along the eye axis on that axis and
   shorten one across the face by exactly `across`. A plain scale on the
   artwork's axes, which closed the eyes level, fails both. */
test('a squint closes across the tilted face, not across the page', () => {
  const match = /^rotate\(([-\d.]+)\) scale\(([-\d.]+) ([-\d.]+)\) rotate\(([-\d.]+)\)$/.exec(faceScale(.82, .38))
  expect(match).not.toBeNull()
  const [, a, sx, sy, b] = match.map(Number)
  expect(a).toBeCloseTo(15.86, 2)
  expect(b).toBeCloseTo(-15.86, 2)
  const rotate = (deg, [x, y]) => { const r = deg * Math.PI / 180; return [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)] }
  // SVG applies the rightmost transform first
  const apply = p => rotate(a, [rotate(b, p)[0] * sx, rotate(b, p)[1] * sy])
  const u = [Math.cos(FACE_TILT), Math.sin(FACE_TILT)], v = [-Math.sin(FACE_TILT), Math.cos(FACE_TILT)]
  const [ux, uy] = apply(u), [vx, vy] = apply(v)
  expect(ux / u[0]).toBeCloseTo(.82, 3); expect(uy / u[1]).toBeCloseTo(.82, 3)
  expect(vx / v[0]).toBeCloseTo(.38, 3); expect(vy / v[1]).toBeCloseTo(.38, 3)
})
