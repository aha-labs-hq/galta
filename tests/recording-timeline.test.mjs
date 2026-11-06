import { test, expect } from 'bun:test'
import { recordingTimeline } from '../packages/capture/src/recordingTimeline.ts'

const view = { x: 0, y: 0, width: 1200, height: 800, zoom: 1 }
const point = (t, x, kind = 'move', viewport = view) => ({ t, x, y: 50, worldX: x, worldY: 50, kind, buttons: 0, view: viewport })
const packet = {
  duration: 12, frames: [{ id: 'f', t: 0, view }],
  transcript: { status: 'available', text: 'here here make them larger', words: [
    { text: 'here', start: 1, end: 1.4 }, { text: 'here make', start: 4, end: 7.4, spans: [{ start: 4, end: 4.4 }, { start: 7, end: 7.4 }] },
    { text: ' them larger', start: 7.4, end: 8 }
  ], audio: { activity: [{ start: 1, end: 1.4 }, { start: 4, end: 4.4 }, { start: 7, end: 8 }], removedSilence: 3 } },
  pointers: [point(.5, 200), point(3.5, 800)]
}
test('separated utterances keep separate references, including a stationary pointer during a shared action', () => {
  const result = recordingTimeline(packet)
  expect(result.moments).toHaveLength(3)
  expect(result.moments.map(m => m.pointer[0].worldX)).toEqual([200, 800, 800])
  expect(result.moments.map(m => m.words)).toEqual([[0], [1], [1, 2]])
  expect(result.moments[2].pointer[0].t).toBe(3.5)
})
test('a leave or camera change invalidates a held world position', () => {
  const leave = recordingTimeline({ ...packet, pointers: [...packet.pointers, point(6, 800, 'leave')] })
  expect(leave.moments[2].pointer).toHaveLength(0)
  const pan = recordingTimeline({ ...packet, frames: [...packet.frames, { id: 'pan', t: 6, view: { ...view, x: 400 } }] })
  expect(pan.moments[2].pointer).toHaveLength(0)
})
test('unrecognized activity remains visible as a gap; it does not borrow the next phrase', () => {
  const result = recordingTimeline({ ...packet, transcript: { ...packet.transcript, words: [packet.transcript.words[2]] } })
  expect(result.moments[0].words).toEqual([])
  expect(result.moments[0].kind).toBe('audio')
})
test('recognized quiet speech keeps its own pointer when the energy detector misses it', () => {
  const result = recordingTimeline({ ...packet, transcript: { ...packet.transcript,
    audio: { activity: [{ start: 1, end: 1.4 }, { start: 7, end: 8 }], removedSilence: 3 }
  } })
  const quiet = result.moments.find(m => m.start === 4 && m.end === 4.4)
  expect(quiet?.kind).toBe('speech')
  expect(quiet?.words).toEqual([1])
  expect(quiet?.pointer[0].worldX).toBe(800)
  // A discontinuous recognizer span must not fill the intervening pause.
  expect(result.moments.some(m => m.start < 5 && m.end > 6)).toBe(false)
})
test('a broad recognizer segment does not merge distinct acoustic pointing moments', () => {
  const result = recordingTimeline({ ...packet, transcript: { ...packet.transcript,
    words: [{ text: 'here here make them larger', start: .8, end: 8.2 }]
  } })
  expect(result.moments.map(m => [m.kind, m.start, m.end])).toEqual([
    ['audio', 1, 1.4], ['audio', 4, 4.4], ['audio', 7, 8]
  ])
})
test('contiguous ASR tokens extending beyond activity do not invent extra utterances', () => {
  const result = recordingTimeline({ ...packet, transcript: { ...packet.transcript,
    words: [{ text: 'make', start: 1, end: 1.3 }, { text: ' larger', start: 1.3, end: 1.7 }, { text: '.', start: 1.7, end: 1.9 }],
    audio: { activity: [{ start: 1.1, end: 1.5 }], removedSilence: 0 }
  } })
  expect(result.moments.filter(m => m.kind !== 'pointer').map(m => [m.kind, m.start, m.end])).toEqual([['audio', 1.1, 1.5]])
})
test('several silent indications before a spoken operation are not dropped', () => {
  const result = recordingTimeline({ ...packet,
    transcript: { status: 'available', text: 'change their color', words: [{ text: 'change their color', start: 10, end: 11 }], audio: { activity: [{ start: 10, end: 11 }], removedSilence: 0 } },
    pointers: [point(1, 100), point(2, 150), point(4, 500), point(5, 550), point(7, 900), point(8, 950)] })
  const points = result.moments.filter(m => m.kind === 'pointer').flatMap(m => m.pointer)
  for (const x of [100, 500, 900]) expect(points.some(p => p.worldX === x)).toBe(true)
})
test('silent pointing, moving paths and long continuous speech have bounded chronological coverage', () => {
  const pointers = Array.from({ length: 600 }, (_, i) => ({ ...point(i / 50, 500 + Math.cos(i / 10) * 100), worldY: 200 + Math.sin(i / 10) * 100 }))
  for (const transcript of [{ status: 'none', text: '', words: [] }, { status: 'available', text: 'continuous', words: [{ text: 'continuous', start: 0, end: 12 }], audio: { activity: [{ start: 0, end: 12 }], removedSilence: 0 } }]) {
    const result = recordingTimeline({ ...packet, pointers, transcript })
    expect(result.moments.length).toBeGreaterThan(1)
    expect(result.moments.length).toBeLessThanOrEqual(24)
    expect(result.moments.every(m => m.pointer.length <= 16)).toBe(true)
    expect(result.moments.at(-1).end).toBe(12)
  }
})
