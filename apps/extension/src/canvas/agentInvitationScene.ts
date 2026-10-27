import { convertToExcalidrawElements, FONT_FAMILY, restoreElements } from '@excalidraw/excalidraw'
import type { AppState } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { normalizeFreeDraw } from './freeDraw'
import { themeColor } from '../design/theme'
import { invitationMarks, openaiOutline } from './agentInvitationMarks'
import { ART, EYES, HEAD_POINTS, lipAt } from '../marks/geometry'
import { drawingPalette } from './drawingPalette'

type Point = readonly [number, number, number?]
type Curve = readonly [Point, Point, Point, Point]
function curve([a, b, c, d]: Curve): Point[] {
  return Array.from({ length: 49 }, (_, i) => {
    const t = i / 48, s = 1 - t
    return [s ** 3 * a[0] + 3 * s * s * t * b[0] + 3 * s * t * t * c[0] + t ** 3 * d[0], s ** 3 * a[1] + 3 * s * s * t * b[1] + 3 * s * t * t * c[1] + t ** 3 * d[1]]
  })
}

function disc([cx, cy]: Point, r: number): Point[] {
  return Array.from({ length: 40 }, (_, i): Point => [cx + r * Math.cos(i / 40 * 2 * Math.PI), cy + r * Math.sin(i / 40 * 2 * Math.PI)])
}

/** A rounded rectangle as one closed outline. */
function box(x: number, y: number, width: number, height: number, r: number): Point[] {
  const corners = [[x + width - r, y + r, -90], [x + width - r, y + height - r, 0], [x + r, y + height - r, 90], [x + r, y + r, 180]] as const
  const points = corners.flatMap(([cx, cy, from]) => Array.from({ length: 7 }, (_, i): Point => {
    const angle = (from + i * 15) * Math.PI / 180
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)]
  }))
  return [...points, points[0]!]
}

/** Points turned about a centre, for a card caught mid-drop. */
function turn(points: readonly Point[], [cx, cy]: Point, degrees: number): Point[] {
  const c = Math.cos(degrees * Math.PI / 180), s = Math.sin(degrees * Math.PI / 180)
  return points.map(([px, py]): Point => [cx + (px - cx) * c - (py - cy) * s, cy + (px - cx) * s + (py - cy) * c])
}

/** Short strokes along a path: a hand-drawn trail rather than one line. */
function dashes(path: readonly Point[], on: number, off: number): [Point, Point][] {
  const lengths = path.reduce<number[]>((all, point, i) => [...all, i ? all[i - 1]! + Math.hypot(point[0] - path[i - 1]![0], point[1] - path[i - 1]![1]) : 0], [])
  const at = (distance: number): Point => {
    let i = 1
    while (i < path.length - 1 && lengths[i]! < distance) i++
    const t = (distance - lengths[i - 1]!) / (lengths[i]! - lengths[i - 1]!), a = path[i - 1]!, b = path[i]!
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  }
  const runs: [Point, Point][] = []
  for (let distance = 0; distance + on <= lengths.at(-1)!; distance += on + off) runs.push([at(distance), at(distance + on)])
  return runs
}

/** Native shapes, ink and text share one connection action with the attached dock.
 * The camera transforms the composition once; each mark stays editable. */
export function createAgentInvitation(state: AppState) {
  const narrow = state.width < 600
  const width = narrow ? 300 : 640, height = narrow ? 472 : 452
  const scale = Math.max(.4, Math.min(1, (state.width - (narrow ? 100 : 48)) / width, (state.height - 150) / height))
  const z = state.zoom.value, unit = scale / z
  const x = ((state.width - width * scale) / 2 + (narrow ? 26 : 0)) / z - state.scrollX
  const y = ((state.height - height * scale) / 2 - 9 * scale) / z - state.scrollY
  const ink = themeColor('foreground'), soft = themeColor('muted-foreground'), paper = themeColor('background')
  const clay = drawingPalette.stroke.Clay
  const prefix = `guide-${crypto.randomUUID()}`
  const elements: ExcalidrawElement[] = []
  const actions = new Map<string, string>()
  const targets: { action: string; label: string; id: string }[] = []
  let sequence = 0
  const id = () => `${prefix}-${sequence++}`
  const brush = (samples: readonly Point[], options: { color?: string; weight?: number; group?: string; action?: string; fill?: string | undefined; measured?: boolean } = {}) => {
    // Dense input preserves corners through native brush smoothing. The third
    // value, when present, is the measured ink radius rather than a new brush.
    const points = samples.flatMap((point, i) => {
      if (!i) return [point]
      const previous = samples[i - 1]!, steps = Math.max(1, Math.ceil(Math.hypot(point[0] - previous[0], point[1] - previous[1]) / (options.measured ? .3 : 1)))
      return Array.from({ length: steps }, (_, j): Point => {
        const t = (j + 1) / steps
        return [previous[0] + (point[0] - previous[0]) * t, previous[1] + (point[1] - previous[1]) * t, (previous[2] ?? .5) + ((point[2] ?? .5) - (previous[2] ?? .5)) * t]
      })
    })
    const elementId = id(), weight = options.weight ?? 1.5
    const raw = { id: elementId, type: 'freedraw', x, y, angle: 0, points: points.map(([px, py]) => [px * unit, py * unit]),
      strokeWidth: weight * unit / 4.25, strokeColor: options.color ?? ink, roughness: 0,
      backgroundColor: options.fill ?? 'transparent', fillStyle: 'solid',
      simulatePressure: false, pressures: points.map((p, i) => options.measured
        ? Math.max(0, Math.min(1, (Math.asin(Math.min(.95, (p[2] ?? .5) / weight)) * 2 / Math.PI - .2) / .6))
        : .42 + .08 * Math.sin(i / Math.max(1, points.length - 1) * Math.PI) + .025 * Math.sin(i * .37)),
      lastCommittedPoint: [0, 0], groupIds: options.group ? [options.group] : [], customData: { galtaGuide: 'agent-invitation' }
    } as unknown as ExcalidrawElement
    elements.push(...restoreElements([normalizeFreeDraw(raw)], null))
    if (options.action) actions.set(elementId, options.action)
    return elementId
  }
  const text = (value: string, px: number, py: number, size: number, options: { color?: string; center?: boolean; serif?: boolean; group?: string; action?: string } = {}) => {
    const elementId = id()
    const [element] = convertToExcalidrawElements([{ id: elementId, type: 'text', x: x + px * unit, y: y + py * unit,
      text: value, fontSize: size * unit, fontFamily: options.serif ? FONT_FAMILY.Georgia : FONT_FAMILY.Helvetica, strokeColor: options.color ?? ink,
      textAlign: options.center ? 'center' : 'left', groupIds: options.group ? [options.group] : [], customData: { galtaGuide: 'agent-invitation' }
    }], { regenerateIds: false })
    elements.push(element!)
    if (options.action) actions.set(elementId, options.action)
  }
  const action = 'connect', group = `${prefix}-connect`
  // A cartoon of Galta itself: the page you browse, the canvas beside it, and
  // the loop between them, each step named once in the margin of the drawing.
  const agent = drawingPalette.stroke.Blue, markInk = themeColor('mark-ink'), markPaper = themeColor('mark-paper')
  const wx = narrow ? 10 : 60, wy = 34, ww = narrow ? 280 : 520, wh = 262, split = narrow ? wx : wx + 190
  const hit = brush([[wx - 6, wy - 50], [wx + ww + 6, wy - 50], [wx + ww + 6, wy + wh + 6], [wx - 6, wy + wh + 6], [wx - 6, wy - 50]], { group, action, color: paper, weight: .01, fill: paper })
  targets.push({ action, label: 'Connect through the Galta illustration', id: hit })
  const shape = (points: readonly Point[], color: string, options: { edge?: string; weight?: number } = {}) => {
    const elementId = id(), [sx, sy] = points[0]!
    const [element] = convertToExcalidrawElements([{ id: elementId, type: 'line', x: x + sx * unit, y: y + sy * unit,
      points: [...points, points[0]!].map(([px, py]) => [(px - sx) * unit, (py - sy) * unit]),
      strokeColor: options.edge ?? 'transparent', strokeWidth: (options.weight ?? 1) * unit, backgroundColor: color, fillStyle: 'solid', roughness: 0, roundness: null,
      groupIds: [group], customData: { galtaGuide: 'agent-invitation' }
    }], { regenerateIds: false })
    elements.push(element!)
    actions.set(elementId, action)
  }
  // Narrow layouts are drawn smaller, so the pen is a little heavier there.
  const pen = (points: readonly Point[], weight = 1.3, color = ink) => brush(points, { weight: weight * (narrow ? 1.5 : 1), color, group, action })
  const note = (step: number, label: string, nx: number, ny: number) => {
    text(String(step), nx, ny - 1.5, 13.5, { serif: true, group, action })
    text(label, nx + 13, ny, 12, { color: soft, group, action })
  }

  // Galta peeks over the window, watching the places its agent will fill.
  const size = narrow ? 58 : 70, k = size / ART.h, gx = wx + ww - (narrow ? 92 : 112), gy = wy - size * .64
  const place = ([ax, ay]: readonly [number, number]): Point => [gx + (ax - ART.x) * k, gy + (ay - ART.y) * k]
  const look: Point = [split + (narrow ? 150 : 170), wy + 110]
  shape(HEAD_POINTS.map(place), markInk)
  for (const eye of EYES) {
    const centre = place([eye.c[0]!, eye.c[1]!]), toward = [look[0] - centre[0], look[1] - centre[1]] as const, reach = Math.hypot(...toward), shift = (eye.r - eye.pr) * .8 * k
    shape(disc(centre, eye.r * k), markPaper)
    shape(disc([centre[0] + toward[0] / reach * shift, centre[1] + toward[1] / reach * shift], eye.pr * k), markInk)
  }
  shape(lipAt(.6).map(([lx, ly]) => place([lx!, ly!])), markPaper)

  // The window: browser chrome, the page on the left, Galta on the right.
  shape(box(wx, wy, ww, wh, 16), paper)
  pen(box(wx, wy, ww, wh, 16), 1.6)
  pen([[wx, wy + 26], [wx + ww, wy + 26]], 1.1)
  for (const dx of [16, 28, 40]) shape(disc([wx + dx, wy + 13], 3.2), soft)
  pen(box(wx + 56, wy + 8, narrow ? 110 : 150, 11, 5.5), 1, soft)
  if (!narrow) {
    pen([[split, wy + 26], [split, wy + wh]], 1.1)
    pen([[wx + 16, wy + 44], [wx + 112, wy + 44]], 2.4, soft)
    shape(box(wx + 16, wy + 56, 80, 54, 6), drawingPalette.fill.Sand)
    pen(box(wx + 16, wy + 56, 80, 54, 6), 1)
    pen([[wx + 22, wy + 102], [wx + 42, wy + 80], [wx + 56, wy + 93], [wx + 68, wy + 84], [wx + 90, wy + 102]], 1)
    shape(disc([wx + 76, wy + 70], 5), ink)
    for (const [ly, length] of [[126, 150], [136, 128], [146, 92], [232, 140], [242, 110]] as const) pen([[wx + 16, wy + ly], [wx + 16 + length, wy + ly]], 1, soft)
    shape(box(wx + 16, wy + 158, 150, 60, 6), drawingPalette.fill.Sage)
    pen(box(wx + 16, wy + 158, 150, 60, 6), 1)
    pen(curve([[wx + 30, wy + 208], [wx + 70, wy + 168], [wx + 110, wy + 216], [wx + 152, wy + 178]]), 1)
  }

  // 1. A picture travels from the page and lands on the canvas, still tilted.
  const card: Point = [split + 50, wy + 116]
  const from: Point = narrow ? [wx - 26, wy + 40] : [wx + 60, wy + 84]
  for (const dash of dashes(curve([from, [from[0] + 40, wy + 30], [card[0] - 50, wy + 36], [card[0] - 16, card[1] - 26]]), 5, 5)) pen(dash, 1.1, soft)
  shape(turn(box(card[0] - 30, card[1] - 22, 60, 44, 5), card, -8), drawingPalette.fill.Sand)
  pen(turn(box(card[0] - 30, card[1] - 22, 60, 44, 5), card, -8), 1.1)
  pen(turn([[card[0] - 24, card[1] + 16], [card[0] - 8, card[1] - 4], [card[0] + 2, card[1] + 6], [card[0] + 10, card[1] - 2], [card[0] + 26, card[1] + 16]], card, -8), 1)
  const pointer: Point[] = [[0, 0], [0, 16.5], [4.3, 12.6], [7.2, 19], [9.8, 17.9], [6.9, 11.6], [12.4, 11.5]]
  shape(pointer.map(([px, py]) => [card[0] + 22 + px, card[1] + 12 + py]), paper, { edge: ink, weight: 1.2 })
  note(1, 'Drag anything in', split + 14, wy + 158)

  // 3. Three places, held for what the agent makes. The only colour is the agent.
  const bw = narrow ? 42 : 46, step = bw + 10, results = [0, 1, 2].map(i => split + (narrow ? 122 : 138) + i * step), ry0 = wy + 100
  for (const px of results) {
    shape(box(px, ry0, bw, 38, 5), drawingPalette.fill.Blue)
    for (const dash of dashes(box(px, ry0, bw, 38, 5), 4, 3)) pen(dash, 1.1, agent)
  }
  // A working page, a film and a poster: what one sentence can become.
  const [page, film, poster] = results as [number, number, number]
  pen([[page + 6, ry0 + 9], [page + bw - 6, ry0 + 9]], 1, agent)
  pen([[page + 8, ry0 + 18], [page + 30, ry0 + 18]], 2, agent)
  pen([[page + 8, ry0 + 25], [page + bw - 10, ry0 + 25]], 1, agent)
  shape(box(page + 8, ry0 + 29, 14, 5, 2.5), agent)
  shape([[film + bw / 2 - 5, ry0 + 11], [film + bw / 2 - 5, ry0 + 27], [film + bw / 2 + 8, ry0 + 19]], agent)
  pen([[film + 6, ry0 + 33], [film + bw - 6, ry0 + 33]], 1, agent)
  pen([[film + 6, ry0 + 33], [film + 20, ry0 + 33]], 1.8, agent)
  text('A', poster + bw / 2, ry0 + 6, 20, { center: true, serif: true, color: agent, group, action })
  note(3, 'Watch it take shape', results[0]!, wy + 158)

  // 4. Time Machine: the ruler at the top of the canvas.
  const rx = wx + ww - 40, ry = wy + 52
  for (const i of [-3, -2, -1, 0, 1, 2, 3]) pen([[rx + i * 5, ry], [rx + i * 5, ry - (i ? 7 - Math.abs(i) : 13)]], i ? 1 : 1.5, i ? soft : ink)
  note(4, 'Go back to any moment', wx + ww - (narrow ? 150 : 162), wy + 62)

  // 2. The composer: say it, or sketch it.
  const cx0 = split + (narrow ? 18 : 30), cx1 = wx + ww - (narrow ? 18 : 30), cy = wy + wh - 50
  shape(box(cx0, cy, cx1 - cx0, 32, 16), ink)
  text(narrow ? 'Make a launch page from this' : 'Turn this into a launch page and a film', cx0 + 16, cy + 9.5, 11, { color: paper, group, action })
  shape(disc([cx1 - 16, cy + 16], 8), paper)
  pen([[cx1 - 16, cy + 21], [cx1 - 16, cy + 11]], 1.2)
  pen([[cx1 - 20, cy + 15], [cx1 - 16, cy + 11], [cx1 - 12, cy + 15]], 1.2)
  note(2, 'Say it, or sketch it', cx0, cy - 22)

  const headY = wy + wh + 34
  text(narrow ? 'Bring your agent\nto the canvas.' : 'Bring your agent to the canvas.', width / 2, headY, narrow ? 24 : 30, { center: true, serif: true })
  text(narrow ? 'Your local agent.\nA shared canvas.' : 'Your local agent. A shared canvas.', width / 2, headY + (narrow ? 66 : 44), 15, { center: true, color: soft })

  // Compatibility is a quiet signature, not three competing setup choices.
  const rowY = wy + wh + (narrow ? 150 : 124), markSize = 19, markScale = markSize / 24
  const marks = narrow ? [{ mark: 'openai' as const, x: 62 }, { mark: 'claude' as const, x: 119 }]
    : [{ mark: 'openai' as const, x: 164 }, { mark: 'claude' as const, x: 256 }]
  for (const { mark, x: mx } of marks) {
    if (mark === 'openai') {
      const [ox, oy] = openaiOutline[0]
      const [element] = convertToExcalidrawElements([{ id: id(), type: 'line',
        x: x + (mx + ox * markScale) * unit, y: y + (rowY + oy * markScale) * unit,
        points: openaiOutline.map(([px, py]) => [(px - ox) * markScale * unit, (py - oy) * markScale * unit]),
        strokeColor: 'transparent', backgroundColor: ink, fillStyle: 'solid', roughness: 0, roundness: null,
        customData: { galtaGuide: 'agent-invitation' }
      }], { regenerateIds: false })
      elements.push(element!)
    } else for (const stroke of invitationMarks[mark]) {
      const weight = Math.min(1.8, Math.max(...stroke.map(p => p[2]))) * markScale / .8
      brush(stroke.map(([px, py, radius]) => [mx + px * markScale, rowY + py * markScale, Math.min(1.8, radius) * markScale]), { measured: true, weight, color: mark === 'claude' ? clay : ink })
    }
    if (!narrow) text(mark === 'openai' ? 'Codex' : 'Claude Code', mx + 27, rowY + 2, 13, { color: soft })
  }
  text('& more', narrow ? 172 : 386, rowY + 2, 13, { color: soft })

  // A loose, native thread points toward the matching attached dock. It is
  // quiet on tall canvases and disappears where a short viewport needs space.
  const endY = (state.height - 76 - (y + state.scrollY) * z) / scale
  const startY = rowY + 43
  if (endY - startY > 58) {
    const cx = width / 2, dx = narrow ? 16 : 34
    for (const dash of dashes(curve([[cx + dx, startY], [cx + dx + 38, startY + (endY - startY) * .38], [cx - 24, endY - 41], [cx, endY - 12]]), 7, 7)) brush(dash, { color: soft, weight: 1.2 })
    brush([[cx - 9, endY - 9], [cx, endY], [cx + 4, endY - 12]], { color: soft, weight: 1.2 })
  }
  return { elements, actions, targets }
}
