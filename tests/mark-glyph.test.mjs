import { test, expect } from 'bun:test'
import { HEAD } from '../apps/extension/src/marks/geometry.ts'
import { GLYPH_BOX, GLYPH_HEAD, GLYPH_STROKE, GLYPH_TICK, glyph } from '../apps/extension/src/marks/glyph.ts'

/* The glyph is a solid head with the tick cut out of it, and both of its paths
   are derived — the head by an affine fit of the artwork, the tick by a
   containment solve against that fitted head. Neither is visible to the eye at
   the size it ships, and neither existed before the fit ran.

   This file exists because a version of the glyph shipped with the tick's tip
   outside the head: the stroke overran the silhouette by 1.2 units, which the
   mask turned into an erosion of the head rather than paint outside it, leaving
   a hairline where the check should have ended. Nothing caught it — the glyph
   had no consumer and no test. These assertions are that test. */

const points = (d) => [...d.matchAll(/([ML])\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map(m => [Number(m[2]), Number(m[3])])

const headPoints = points(GLYPH_HEAD)
const tickPoints = points(GLYPH_TICK)
const halfStroke = GLYPH_STROKE / 2

/* Even-odd crossing test: is a point inside the head. */
function inside(x, y) {
  let crossed = false
  for (let i = 0; i < headPoints.length; i++) {
    const a = headPoints[i]
    const b = headPoints[(i + 1) % headPoints.length]
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) crossed = !crossed
  }
  return crossed
}

/* Distance from a point to the nearest point on the head's outline. */
function toOutline(x, y) {
  let best = Infinity
  for (let i = 0; i < headPoints.length; i++) {
    const a = headPoints[i]
    const b = headPoints[(i + 1) % headPoints.length]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)))
    best = Math.min(best, Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy)))
  }
  return best
}

test('the head is the artwork\'s own outline, refitted into the glyph box', () => {
  /* The fit parses the artwork's path, so it must see every point the artwork
     states. A dropped point would silently change the silhouette. */
  expect(headPoints.length).toBe(points(HEAD).length)
  expect((GLYPH_HEAD.match(/M/g) ?? []).length).toBe(1)
  expect(GLYPH_HEAD.endsWith('Z')).toBe(true)
  /* Every coordinate lands in the box, with the stated inset on the long axis. */
  for (const [x, y] of headPoints) {
    expect(x).toBeGreaterThanOrEqual(0)
    expect(x).toBeLessThanOrEqual(GLYPH_BOX)
    expect(y).toBeGreaterThanOrEqual(0)
    expect(y).toBeLessThanOrEqual(GLYPH_BOX)
  }
  const xs = headPoints.map(p => p[0])
  expect(Math.min(...xs)).toBeCloseTo(0.6, 2)
  expect(Math.max(...xs)).toBeCloseTo(GLYPH_BOX - 0.6, 2)
})

test('the whole stroked tick is cut inside the head, not merely inside its box', () => {
  /* This is the assertion that failed when the tip overran: the tick's far
     endpoint sat 0.13 units from the outline against a stroke reaching 1.36 in
     every direction. The check is over the stroke's OUTER EDGE, because a
     stroke is half its width wider than the path it follows — fitting the
     centreline to the head's inscribed circle is the wrong problem and is what
     produced the defect. */
  expect(tickPoints.length).toBe(3)
  let worst = Infinity
  for (let leg = 0; leg + 1 < tickPoints.length; leg++) {
    const [ax, ay] = tickPoints[leg]
    const [bx, by] = tickPoints[leg + 1]
    const length = Math.hypot(bx - ax, by - ay)
    const nx = -(by - ay) / length
    const ny = (bx - ax) / length
    for (let i = 0; i <= 200; i++) {
      const s = i / 200
      const x = ax + (bx - ax) * s
      const y = ay + (by - ay) * s
      for (const side of [1, -1]) {
        const px = x + nx * halfStroke * side
        const py = y + ny * halfStroke * side
        expect(inside(px, py)).toBe(true)
        worst = Math.min(worst, toOutline(px, py))
      }
    }
  }
  /* And with room to spare, so the head is not reduced to a hairline anywhere
     near the cut — which is what the defect actually looked like on screen. */
  expect(worst).toBeGreaterThan(1)
})

test('the tick reads at the size it ships', () => {
  /* The cut has to be wide enough to be a cut rather than a seam once the glyph
     is drawn in the interface's icon slot. */
  const pxAtIcon = GLYPH_STROKE / GLYPH_BOX * 20
  expect(pxAtIcon).toBeGreaterThan(1.4)
  /* And the tick must span enough of the head to read as a check. */
  const span = Math.hypot(tickPoints[2][0] - tickPoints[0][0], tickPoints[2][1] - tickPoints[0][1])
  expect(span).toBeGreaterThan(GLYPH_BOX * 0.25)
})

test('two glyphs never share a mask', () => {
  /* Each glyph cuts its own head with a mask it names itself. Two on one page
     with the same id would make the second resolve to the first's cut. */
  const ids = [...`${glyph()}${glyph()}`.matchAll(/id="(galta-glyph-cut-[^"]+)"/g)].map(m => m[1])
  expect(ids.length).toBe(2)
  expect(new Set(ids).size).toBe(2)
})

test('the markup is the glyph, and the cut is a mask rather than a painted shape', () => {
  const markup = glyph()
  expect(markup).toContain('class="galta-glyph__head"')
  expect(markup).toContain(`viewBox="0 0 ${GLYPH_BOX} ${GLYPH_BOX}"`)
  /* The tick is a hole: the head carries a mask and the tick strokes black
     inside it. A white tick painted on top would be a second colour and would
     fail on any surface that is not white — the mark's own two-tone rule, and
     the reason the mask exists at all. */
  expect(markup).toMatch(/<mask [^>]*>/)
  expect(markup).toContain('stroke="#000"')
  expect(markup).toContain(GLYPH_TICK)
  expect(markup).toContain(GLYPH_HEAD)
})
