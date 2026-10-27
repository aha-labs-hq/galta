/* ===========================================================================
   The mark's geometry.

   Built from the artwork's own path data in its own coordinate system — the
   head outline, both eye rings and the mouth lens are the file's real
   geometry, with its 420×420 padding trimmed away. The face has its own frame
   because the eyes sit on an axis tilted 15.86°; every mouth anchor is
   expressed along that axis and projected back, which is why the mouth stays
   below the eyes in every pose.

   This module is pure arithmetic: no DOM, no stylesheet, no animation. The
   content script, the collection surface and the tests all read the same
   numbers from here, so there is never a second copy of the artwork.
   =========================================================================== */

export const ART = { x: 80.22, y: 96.18, w: 252.88, h: 228.74 };

/* Clearance around the artwork, in artwork units. The ring is a SCREEN-space
   stroke, so the smaller the mark is drawn the more artwork units one pixel of
   ring is worth. At the control size (34px) a 2px ring reaches 7.9 units out,
   so the breath has to cover that or the ring clips against the viewBox. */
export const BREATH = 10;

export const VIEW = [ART.x - BREATH, ART.y - BREATH, ART.w + BREATH * 2, ART.h + BREATH * 2].join(' ');

export const HEAD = 'M84.03 243.79L83.35 243.45L82.74 243.09L82.19 242.71L81.71 242.3L81.3 241.87L80.95 241.42L80.67 240.94L80.46 240.44L80.31 239.91L80.23 239.37L80.22 238.8L80.27 238.2L80.39 237.58L80.57 236.94L80.82 236.28L81.14 235.59L130.44 137.58L130.98 136.56L131.57 135.6L132.19 134.69L132.85 133.83L133.56 133.02L134.3 132.27L135.08 131.56L135.9 130.92L136.76 130.32L137.65 129.78L138.59 129.29L139.57 128.85L140.59 128.47L141.64 128.14L142.73 127.86L143.87 127.64L163.86 124.22L165 124L166.13 123.75L167.24 123.46L168.34 123.14L169.41 122.78L170.47 122.38L171.51 121.95L172.54 121.49L173.54 120.98L174.53 120.44L175.51 119.87L176.46 119.26L177.4 118.61L178.32 117.93L179.23 117.21L180.11 116.45L202.31 96.92L202.5 96.76L202.7 96.62L202.89 96.5L203.09 96.4L203.29 96.32L203.49 96.25L203.69 96.21L203.89 96.19L204.09 96.18L204.3 96.2L204.5 96.24L204.71 96.29L204.92 96.36L205.13 96.46L205.34 96.57L205.55 96.7L330.54 179.91L331 180.24L331.42 180.58L331.79 180.94L332.11 181.3L332.39 181.68L332.62 182.07L332.81 182.48L332.95 182.9L333.04 183.33L333.09 183.77L333.09 184.23L333.05 184.7L332.96 185.18L332.83 185.67L332.64 186.18L332.42 186.7L296.51 262.35L296.27 262.88L296.05 263.42L295.86 263.95L295.68 264.5L295.53 265.04L295.41 265.59L295.3 266.14L295.22 266.69L295.16 267.25L295.12 267.81L295.11 268.37L295.12 268.94L295.15 269.51L295.2 270.08L295.28 270.65L295.38 271.23L297.3 281.25L297.39 281.83L297.46 282.39L297.49 282.95L297.49 283.5L297.46 284.04L297.4 284.57L297.31 285.1L297.19 285.61L297.04 286.12L296.86 286.62L296.64 287.11L296.4 287.6L296.12 288.07L295.81 288.54L295.47 288.99L295.11 289.44L265.59 323.64L265.37 323.88L265.15 324.09L264.92 324.28L264.69 324.44L264.45 324.58L264.21 324.7L263.96 324.79L263.7 324.86L263.44 324.91L263.18 324.93L262.91 324.92L262.64 324.89L262.36 324.84L262.07 324.77L261.78 324.67L261.48 324.54Z';

/* The silhouette's vertices, for surfaces that draw the head as geometry
   rather than as an SVG path: the glyph's fitted copy and the canvas guide. */
export const HEAD_POINTS = [...HEAD.matchAll(/([ML])(-?[\d.]+)\s+(-?[\d.]+)/g)].map(m => [Number(m[2]), Number(m[3])] as const);

/* The face's own frame: `u` runs along the eye axis, `v` runs down the face,
   and the origin is the midpoint between the two eye centres. Every anchor
   below is stated in that frame and projected back, so the mouth stays on the
   face under any reshape. */
export const TILT = 15.86 * Math.PI / 180;
export const U = [Math.cos(TILT), Math.sin(TILT)];
export const V = [-U[1]!, U[0]!];
export const EM = [203.03, 205.90];

export const EYES = [
  { c: [166.93, 195.64], r: 23.38, pr: 13.95 },
  { c: [239.12, 216.15], r: 23.38, pr: 13.95 },
];

/* The mark is two-tone: ink, and the paper showing through it. Both eyes and
   the mouth are white holes in the black silhouette, so a mouth that opens is
   that same hole drawn wider — never a cavity we invent.

   The mouth's anchors come from the artwork itself, expressed in the face's own
   frame. The artwork puts the mouth at v 17.6–25.0, i.e. below the eyes,
   spanning ±9.84 — not between them. */
export const MOUTH = [
  [-9.84, 17.64], [-7.88, 17.75], [-5.92, 17.84], [-3.96, 17.89],
  [-2.00, 17.93], [-0.04, 17.94], [1.93, 17.93], [3.89, 17.90],
  [5.85, 17.84], [7.81, 17.76], [9.77, 17.64], [9.57, 19.50],
  [8.70, 21.25], [7.37, 22.68], [5.73, 23.74], [3.91, 24.46],
  [1.99, 24.87], [0.04, 25.02], [-1.92, 24.89], [-3.84, 24.48],
  [-5.67, 23.77], [-7.32, 22.72], [-8.66, 21.31], [-9.54, 19.57],
];

export const LIP_V = 17.64;      // the line through both corners: the mouth's hinge
export const LIP_HALF = 9.84;    // how far each corner sits from the mouth's centre

/* The mouth as a shape, for a given openness in [0,1].

   The corners are the hinge line, so it never moves; the ceiling lifts a little
   and the floor drops a great deal, and the corners travel apart as it widens.
   The eye rings' inner edges are at |u| = 14.15, so the corners stop short of
   them by design.

   An inhale opens WIDE and relatively shallow — a mouth taking something in,
   not a round hole — so depth grows far less than width. */
export function mouthAt(open: number): number[][] {
  const widen = 1 + 0.44 * open;
  const drop = 1 + 1.35 * open;
  const lift = 1.6 * open;
  return MOUTH.map(([x, y]) => {
    if (y! > LIP_V + 0.05) return [x! * widen, (LIP_V - lift) + (y! - LIP_V) * drop];
    const k = Math.max(0, 1 - Math.abs(x!) / LIP_HALF) ** 0.7;
    return [x! * widen, y! - lift * k];
  });
}

export const at = (x: number, y: number): [number, number] =>
  [EM[0]! + x * U[0]! + y * V[0]!, EM[1]! + x * U[1]! + y * V[1]!];

/* An SVG transform that scales a part of the face in the face's own frame:
   `along` the eye axis (u) and `across` it (v). The face is tilted, so a
   squint or a blink, which closes across the face, is never a plain scale on
   the artwork's axes: that would close the eyes level while the face leans.
   It scales about the element's transform origin, which `.galta-mark__gaze`
   puts at the pupil's centre (surface.ts). */
export const faceScale = (along: number, across: number) => {
  const deg = (TILT * 180 / Math.PI).toFixed(2);
  return `rotate(${deg}) scale(${along.toFixed(3)} ${across.toFixed(3)}) rotate(-${deg})`;
};

const mix = (a: number[][], b: number[][], t: number) =>
  a.map((p, i) => [p[0]! + (b[i]![0]! - p[0]!) * t, p[1]! + (b[i]![1]! - p[1]!) * t]);

export const REST = MOUTH;
export const OPEN = mouthAt(1);

/* Interpolating the two poses point for point is what makes the mouth open
   rather than swap, and one openness drives the whole shape. The outline is
   in artwork coordinates: the SVG lip is drawn from it, and so is anything
   the swallow has to line up with the mouth, so the two cannot disagree. */
export const lipAt = (open: number) => mix(REST, OPEN, open).map(p => at(p[0]!, p[1]!));

export const shape = (open: number) =>
  'M' + lipAt(open).map(p => p.map(n => n.toFixed(2)).join(' ')).join('L') + 'Z';

/* ---------------------------------------------------------------------------
   Proportions.

   Everything the swallow does is expressed as a fraction of the mark's own
   box, never as a pixel count. The mark is drawn at whatever size its context
   asks for — a 34 px control on a card, a 200 px figure in a notice — and the
   action has to be the same action at every size. A keyframe of "shrink to
   11 px" is a statement about one particular control; "shrink to the width of
   the mouth" is a statement about the mark.

   All of these are measured in the artwork's own units and divided by VIEW_W,
   so they travel with the artwork if it is ever redrawn.
   --------------------------------------------------------------------------- */

export const VIEW_W = ART.w + BREATH * 2;
export const VIEW_H = ART.h + BREATH * 2;

/* The box's own origin, which every fraction below is measured from, and which
   a caller projecting page pixels back into artwork units also needs. */
export const ORIGIN_X = ART.x - BREATH;
export const ORIGIN_Y = ART.y - BREATH;

/* A named length in the mark's box, as a fraction of each axis. */
export const ofMark = (units: number) => units / VIEW_W;
export const ofMarkY = (units: number) => units / VIEW_H;

/* Where the mouth sits inside the mark's box, as a 0–1 fraction of each axis.
   The swell and the arrival point both come from here. */
const MOUTH_AT = at(0, 20.1);
export const MOUTH_FRACTION = {
  x: ofMark(MOUTH_AT[0]! - ORIGIN_X),
  y: ofMarkY(MOUTH_AT[1]! - ORIGIN_Y),
};

/* The aperture's own size, which is what the picture has to shrink to. */
export const OPEN_MOUTH = {
  w: ofMark(Math.max(...OPEN.map(p => p[0]!)) - Math.min(...OPEN.map(p => p[0]!))),
  h: ofMark(Math.max(...OPEN.map(p => p[1]!)) - Math.min(...OPEN.map(p => p[1]!))),
};

/* The feed point is the mouth, so the mark swells out of its own mouth instead
   of around the middle of its body. Both percentages come from the same
   fractions the arrival point does, so a redrawn artwork moves all three
   together and the pivot can never drift from where the picture lands. */
export function mouthOrigin(): string {
  return `${MOUTH_FRACTION.x * 100}% ${MOUTH_FRACTION.y * 100}%`;
}

/* ---------------------------------------------------------------------------
   Timing.

   The whole gesture is one timeline, stated once and derived everywhere. A
   duration written at a call site is a second source of truth: it drifts from
   the beats it is supposed to describe, and the drift is invisible until
   something looks wrong and nobody can say which number is the real one.
   --------------------------------------------------------------------------- */

/* The one number every beat is derived from. */
export const BEAT = 1240;
export const atBeat = (fraction: number) => BEAT * fraction;

/* The beats, named. The body's poses, the mouth, the eyes and the picture all
   read from this, so a change to the choreography is one edit rather than a
   hunt for stray fractions. The picture leaves while the body is still
   gathering: overlapping actions are what keep the gesture from reading as a
   sequence of separate moves. */
export const PHASE = {
  commit: .10,     // the picture starts to flow
  gather: .14,     // the body has given back volume and leaned away
  open: .30,       // lips wide
  take: .66,       // the last of the picture is in; the lips start to close
  gulp: .76,       // lips shut, body at its fullest
  rebound: .86,    // one overshoot
  settle: .94,
};
