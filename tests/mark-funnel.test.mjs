import { test, expect } from 'bun:test'
import { funnel } from '../apps/extension/src/marks/funnel.ts'

/* The funnel is the whole shape of the picture's way into the mouth. These are
   the properties the eye relies on, stated without a browser: the first frame
   is the picture exactly as the page showed it, the last is nothing but the
   mouth, and nothing in between folds, jumps or escapes the space between the
   two. */

/* A Pinterest-shaped card with the mark inside its bottom-right corner, and a
   wide banner with the mark inside its top-right corner. */
const card = { picture: { left: 40, top: 80, width: 236, height: 354 }, mouth: { x: 252, y: 413 } }
const banner = { picture: { left: 20, top: 30, width: 900, height: 320 }, mouth: { x: 894, y: 61 } }
const neck = { width: 3.5, height: 2.4 }
const BAND = 5

const progressions = Array.from({ length: 101 }, (_, i) => i / 100)

test('a portrait card pours along its height, a wide banner along its width', () => {
  expect(funnel(card.picture, card.mouth, neck, BAND).axis).toBe('y')
  expect(funnel(banner.picture, banner.mouth, neck, BAND).axis).toBe('x')
})

test('at rest every band is exactly where the picture was', () => {
  for (const { picture, mouth } of [card, banner]) {
    const f = funnel(picture, mouth, neck, BAND)
    const [start, length, centre, width] = f.axis === 'y'
      ? [picture.top, picture.height, picture.left + picture.width / 2, picture.width]
      : [picture.left, picture.width, picture.top + picture.height / 2, picture.height]
    expect(f.edges[0]).toBe(0)
    expect(f.edges.at(-1)).toBeCloseTo(length, 9)
    f.at(0).forEach((edge, i) => {
      expect(edge.along).toBeCloseTo(start + f.edges[i], 9)
      expect(edge.cross).toBeCloseTo(centre, 9)
      expect(edge.width).toBeCloseTo(width, 9)
    })
  }
})

test('when the pull is done all of it is in the mouth, at the mouth\'s width', () => {
  for (const { picture, mouth } of [card, banner]) {
    const f = funnel(picture, mouth, neck, BAND)
    const [target, targetCross, narrowest] = f.axis === 'y' ? [mouth.y, mouth.x, neck.width] : [mouth.x, mouth.y, neck.height]
    for (const edge of f.at(1)) {
      expect(edge.along).toBeCloseTo(target, 9)
      expect(edge.cross).toBeCloseTo(targetCross, 9)
      expect(edge.width).toBeCloseTo(narrowest, 9)
    }
  }
})

test('the picture never folds over itself and never leaves the space between it and the mouth', () => {
  for (const { picture, mouth } of [card, banner]) {
    const f = funnel(picture, mouth, neck, BAND)
    const box = {
      left: Math.min(picture.left, mouth.x), right: Math.max(picture.left + picture.width, mouth.x),
      top: Math.min(picture.top, mouth.y), bottom: Math.max(picture.top + picture.height, mouth.y),
    }
    const [lo, hi, crossLo, crossHi] = f.axis === 'y'
      ? [box.top, box.bottom, box.left, box.right] : [box.left, box.right, box.top, box.bottom]
    for (const p of progressions) {
      const edges = f.at(p)
      for (let i = 1; i < edges.length; i++) expect(edges[i].along).toBeGreaterThanOrEqual(edges[i - 1].along - 1e-9)
      for (const edge of edges) {
        expect(edge.along).toBeGreaterThanOrEqual(lo - 1e-9)
        expect(edge.along).toBeLessThanOrEqual(hi + 1e-9)
        expect(edge.cross - edge.width / 2).toBeGreaterThanOrEqual(crossLo - 1e-9)
        expect(edge.cross + edge.width / 2).toBeLessThanOrEqual(crossHi + 1e-9)
      }
    }
  }
})

test('the part nearest the mouth goes in first and the far edge last', () => {
  const f = funnel(card.picture, card.mouth, neck, BAND)
  const arrived = p => f.at(p).map(edge => Math.abs(edge.along - card.mouth.y) < 1e-6)
  /* The nearest band takes half the pull. Just past halfway the edges around
     the mouth are in and the top of the card is not. */
  const half = arrived(.55)
  const nearest = f.edges.reduce((best, offset, i) =>
    Math.abs(card.picture.top + offset - card.mouth.y) < Math.abs(card.picture.top + f.edges[best] - card.mouth.y) ? i : best, 0)
  expect(half[nearest]).toBe(true)
  expect(half[0]).toBe(false)
  expect(arrived(.999)[0]).toBe(false)
})

test('every band moves smoothly: no edge jumps between neighbouring moments', () => {
  /* The stiffness this replaces came from motion with corners in it. A step
     of 1/240 of the pull is a quarter of a 60 Hz frame at the shipped
     timing; no edge may cover more than a small share of its whole journey in
     it, which rules out jumps and snaps anywhere in the gesture. */
  const f = funnel(card.picture, card.mouth, neck, BAND)
  const journey = f.at(0).map((edge, i) => Math.abs(card.mouth.y - edge.along) + Math.abs(card.mouth.x - edge.cross) || 1)
  let previous = f.at(0)
  for (let k = 1; k <= 240; k++) {
    const next = f.at(k / 240)
    next.forEach((edge, i) => {
      const moved = Math.abs(edge.along - previous[i].along) + Math.abs(edge.cross - previous[i].cross)
      expect(moved / journey[i]).toBeLessThan(.035)
    })
    previous = next
  }
})

test('a mouth on the picture\'s own centre or edge produces numbers, not NaN', () => {
  for (const mouth of [{ x: 158, y: 257 }, { x: 40, y: 80 }, { x: 276, y: 434 }]) {
    const f = funnel(card.picture, mouth, neck, BAND)
    for (const p of [0, .25, .5, .75, 1]) {
      for (const edge of f.at(p)) for (const v of Object.values(edge)) expect(Number.isFinite(v)).toBe(true)
    }
  }
})
