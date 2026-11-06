import type { RecordingPacket, RecordingPointer, RecordingSpan, RecordingView } from './recording'

export type RecordingMoment = RecordingSpan & {
  id: number; kind: 'audio' | 'speech' | 'pointer'; words: number[]; frameId: string
  pointer: { t: number; worldX: number; worldY: number }[]; pointerSamples: number
}
const sameView = (a: RecordingView, b: RecordingView) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.zoom === b.zoom
type Section = RecordingSpan & { kind: RecordingMoment['kind'] }
function mergeAdjacent(intervals: Section[]): Section[] {
  const merged: Section[] = []
  for (const span of [...intervals].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1)
    if (last && last.kind === span.kind && span.start - last.end < .3) last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }
  return merged
}

/** Bounded geometric simplification, without smoothing or inferred targets.
 * Split at the largest screen-space error; keep actual observations only. */
function path(points: RecordingPointer[], zoom: number, middle: number) {
  if (points.length <= 2) return points
  const anchor = points.filter(p => p.t <= middle).length - 1
  const chosen = new Set([0, points.length - 1, Math.max(0, anchor)])
  while (chosen.size < 16) {
    const sorted = [...chosen].sort((a, b) => a - b)
    let best = -1, error = 8 / zoom
    for (let j = 1; j < sorted.length; j++) {
      const from = sorted[j - 1]!, to = sorted[j]!, a = points[from]!, b = points[to]!
      const dx = b.worldX - a.worldX, dy = b.worldY - a.worldY, length = dx * dx + dy * dy
      for (let i = from + 1; i < to; i++) {
        const p = points[i]!, t = length ? Math.max(0, Math.min(1, ((p.worldX - a.worldX) * dx + (p.worldY - a.worldY) * dy) / length)) : 0
        const distance = Math.hypot(p.worldX - a.worldX - dx * t, p.worldY - a.worldY - dy * t)
        if (distance > error) { error = distance; best = i }
      }
    }
    if (best < 0) break
    chosen.add(best)
  }
  return [...chosen].sort((a, b) => a - b).map(i => points[i]!)
}

/** Temporal joins happen before pointer downsampling. Audio activity is not a
 * word boundary: a recognizer segment can belong to several moments. A pointer
 * stays put until a new event, leave, or observed camera change. */
export function recordingTimeline(packet: Pick<RecordingPacket, 'duration' | 'frames' | 'pointers' | 'transcript'>): { moments: RecordingMoment[]; observed: number } {
  const words = packet.transcript.words
  const activity = packet.transcript.audio?.activity
  const kind = activity?.length ? 'audio' : words.length ? 'speech' : 'pointer'
  const speech = mergeAdjacent(words.flatMap(word => word.spans ?? [{ start: word.start, end: word.end }]).map(span => ({ ...span, kind: 'speech' })))
  let intervals: Section[] = (activity?.length ? activity : speech).map(span => ({ ...span, kind }))
  // Energy can miss a quiet utterance that ASR recovered. Keep each unmatched
  // span as recognizer evidence, without claiming an acoustic observation or
  // stretching a coarse ASR segment across several distinct pointing moments.
  if (activity?.length) intervals.push(...speech.filter(span => !activity.some(a => span.start < a.end + .12 && span.end > a.start - .12)).map(span => ({ ...span, kind: 'speech' as const })))
  if (!intervals.length && packet.pointers.some(p => p.kind !== 'leave')) intervals = [{ start: 0, end: packet.duration, kind }]
  const merged = mergeAdjacent(intervals)
  const sections: Section[] = [...merged]
  // Silent pointing can precede the spoken operation. Preserve motion outside
  // speech windows too; otherwise a good transcript would still erase context.
  if (kind !== 'pointer') {
    let from = 0
    for (const next of [...merged, { start: packet.duration + .25, end: packet.duration }]) {
      const end = Math.max(from, next.start - .25)
      const points = packet.pointers.filter(p => p.t >= from && p.t <= end && p.kind !== 'leave')
      const first = points[0]
      if (end > from && first && (points.some(p => p.kind === 'down' || p.kind === 'up') || points.some(p => Math.hypot(p.x - first.x, p.y - first.y) >= 24))) sections.push({ start: from, end, kind: 'pointer' })
      from = next.end + .25
    }
    sections.sort((a, b) => a.start - b.start)
  }
  const windows = sections.flatMap(span => {
    const count = Math.max(1, Math.ceil((span.end - span.start) / 3))
    const edges = new Set([span.start, span.end, ...Array.from({ length: count - 1 }, (_, i) => span.start + (span.end - span.start) * (i + 1) / count),
      ...packet.pointers.filter(p => p.kind === 'leave' && p.t > span.start && p.t < span.end).map(p => p.t)])
    const sorted = [...edges].sort((a, b) => a - b)
    return sorted.slice(1).map((end, i) => ({ start: sorted[i]!, end, kind: span.kind }))
  })
  const indices = windows.length <= 24 ? windows.map((_, i) => i) : Array.from({ length: 24 }, (_, i) => Math.round(i * (windows.length - 1) / 23))
  const moments: RecordingMoment[] = []
  for (const index of indices) {
    const window = windows[index]!, middle = (window.start + window.end) / 2
    const frame = packet.frames.reduce<RecordingPacket['frames'][number] | undefined>((best, f) => !best || Math.abs(f.t - middle) < Math.abs(best.t - middle) ? f : best, undefined)
    if (!frame) continue
    const leaves = packet.pointers.filter(p => p.kind === 'leave')
    const previousLeave = leaves.filter(p => p.t <= window.start).at(-1)?.t ?? 0
    const nextLeave = leaves.find(p => p.t >= window.end)?.t ?? packet.duration
    const from = Math.max(previousLeave, window.start - .25), to = Math.min(nextLeave, window.end + .25)
    const held = packet.pointers.filter(p => p.t <= from).at(-1)
    const observed = packet.pointers.filter(p => p.t > from && p.t <= to)
    const points = [
      ...(held && held.kind !== 'leave' && !observed.some(p => p.t <= window.start) && sameView(held.view, frame.view) ? [held] : []),
      ...observed.filter(p => p.kind !== 'leave')
    ]
    if (window.kind === 'pointer' && !points.length) continue
    moments.push({ ...window, id: moments.length + 1, frameId: frame.id,
      words: words.flatMap((word, i) => (word.spans ?? [word]).some(span => span.start < window.end + .12 && span.end > window.start - .12) ? [i] : []),
      pointer: path(points, frame.view.zoom, middle).map(p => ({ t: p.t, worldX: p.worldX, worldY: p.worldY })), pointerSamples: points.length })
  }
  return { moments, observed: windows.length }
}
