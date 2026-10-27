/* ===========================================================================
   The picture's way into the mouth.

   Pure arithmetic, like geometry.ts: given where the picture sits, where the
   mouth is and how far the pull has got, it says where every part of the
   picture is. The swallow only draws what this returns, so the shape of the
   gesture can be held to its invariants without a browser.

   A single transform can only move and scale a rectangle, and a rectangle
   that shrinks toward a point reads as a card being flown, however it is
   clipped. So the picture is cut into thin bands across the direction it
   travels, and every band has its own position and width. That is what lets
   the picture bend into the mouth instead of being carried there.

   Three rules give the gesture its shape:

   - Every band starts at rest. The first frame is the picture exactly where
     it was, which is what makes hiding the original seamless.
   - Bands nearer the mouth arrive first and the far edge arrives last, so the
     picture pours in rather than shrinking as one piece.
   - A band narrows toward the mouth's width before it gets there, so the
     picture funnels: wide where it still lies, a ribbon where it goes in.
   =========================================================================== */

export type Box = { left: number; top: number; width: number; height: number }
export type Point = { x: number; y: number }

/* Where one band edge is at a moment of the pull: its position along the
   travel axis, the centre of the picture across it, and the width there. */
export type Edge = { along: number; cross: number; width: number }

export type Funnel = {
  /* The axis the picture travels along: bands are rows for 'y', columns for 'x'. */
  axis: 'x' | 'y'
  /* Each band edge's offset into the picture along `axis`. Band i is the
     slice between edges i and i + 1. */
  edges: number[]
  /* How far each edge is from the mouth at rest, measured toward the far
     edge; zero for the sliver beyond the mouth. */
  distance: number[]
  /* Every edge at `progress`, 0 (at rest) to 1 (all of it in). */
  at(progress: number): Edge[]
}

/* The share of the pull the band nearest the mouth takes. The farthest band
   takes all of it, so the picture always finishes as one gesture. */
const NEAREST = .5
/* How the far bands trail behind the near ones, by their share of the
   farthest distance. It is flat at the mouth, so the part already at the
   mouth goes in as one neck rather than meeting the rest of the picture at a
   corner, and flat at the far edge, so the far end is drawn in as one piece. */
const trail = (x: number) => x * x * (3 - 2 * x)
/* How far ahead of arriving a band narrows. At 1 a band would narrow exactly
   as it travels — a shrinking picture. Above 1 the narrowing leads, which is
   the funnel. */
const NARROW = 1.6

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/* A band's own progress. It leaves at rest, so nothing jumps when the pull
   begins, and it is still accelerating when it reaches the mouth: suction
   gathers speed, and the moment it would be fastest is the moment it
   disappears. */
const draw = (x: number) => clamp01(x) ** 2

/* `neck` is the open mouth's own size, which is what every band narrows to.
   `band` is the band thickness at rest, in the same units as `picture`; it
   only sets how many bands there are, within a range that stays smooth
   without costing more draws than the gesture needs. */
export function funnel(picture: Box, mouth: Point, neck: { width: number; height: number }, band: number): Funnel {
  /* The picture travels along the axis it has the farthest to go. A portrait
     card pours down into a mouth at its corner; a wide banner slides across. */
  const reach = (start: number, size: number, at: number) => Math.max(Math.abs(at - start), Math.abs(start + size - at))
  const axis = reach(picture.top, picture.height, mouth.y) >= reach(picture.left, picture.width, mouth.x) ? 'y' : 'x'
  const [start, length, crossStart, crossLength, target, targetCross, narrowest] = axis === 'y'
    ? [picture.top, picture.height, picture.left, picture.width, mouth.y, mouth.x, neck.width]
    : [picture.left, picture.width, picture.top, picture.height, mouth.x, mouth.y, neck.height]

  const count = Math.min(240, Math.max(48, Math.ceil(length / band)))
  const edges = Array.from({ length: count + 1 }, (_, i) => length * i / count)
  /* Distance is measured toward the far edge only. The mark sits in a corner,
     so the sliver of picture beyond the mouth is short; if it trailed by its
     own distance it would stay wide while the picture pinched at the mouth,
     and the near edge would flare out like a hem. Instead it goes in with
     the mouth's own row, and the picture tapers one way, to one point. */
  const farIsStart = Math.abs(target - start) >= Math.abs(start + length - target)
  const distance = edges.map(offset => Math.max(0, farIsStart ? target - (start + offset) : start + offset - target))
  const farthest = Math.max(...distance) || 1
  /* When each edge arrives, as a share of the pull. Arrival grows with
     distance, so the edges can never pass each other: the picture folds over
     itself at no point of the gesture. */
  const arrival = distance.map(d => NEAREST + (1 - NEAREST) * trail(d / farthest))
  const centre = crossStart + crossLength / 2

  return {
    axis,
    edges,
    distance,
    at(progress) {
      return edges.map((offset, i) => {
        const travel = draw(progress / arrival[i]!)
        const narrow = 1 - (1 - travel) ** NARROW
        const rest = start + offset
        return {
          along: rest + (target - rest) * travel,
          cross: centre + (targetCross - centre) * narrow,
          width: crossLength + (narrowest - crossLength) * narrow,
        }
      })
    },
  }
}
