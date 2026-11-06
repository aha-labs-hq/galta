import { test, expect } from 'bun:test'
import { selectRecordingFrames, validateRecordingWords } from '../packages/capture/src/recording.ts'

const frames = Array.from({ length: 30 }, (_, i) => ({ id: `f${i}`, t: i / 2, dataUrl: `pixels-${i}`, objectIds: [], unrenderedIds: [], view: { x: 0, y: 0, width: 100, height: 100, zoom: 1 } }))
const packet = { frames, pointers: [], transcript: { status: 'available', text: 'A B', words: [{ text: 'A', start: 3, end: 4 }, { text: 'B', start: 9, end: 10 }] } }
test('recording evidence retains endpoints and separated speech windows within its budget', () => {
  const selected = selectRecordingFrames(packet)
  expect(selected).toHaveLength(8)
  expect(selected[0]).toBe(frames[0]); expect(selected.at(-1)).toBe(frames.at(-1))
  for (const t of [3, 4, 9, 10]) expect(selected.some(frame => frame.t === t)).toBe(true)
  expect(new Set(selected.map(frame => frame.id)).size).toBe(selected.length)
  expect(selected.map(frame => frame.t)).toEqual(selected.map(frame => frame.t).sort((a, b) => a - b))
  expect(packet.frames).toHaveLength(30)
})
test('silent pointing has a complete bounded evidence selection without fabricated speech', () => {
  const selected = selectRecordingFrames({ ...packet, transcript: { status: 'none', text: '', words: [] }, pointers: [{ t: 6, x: 0, y: 0 }, { t: 6.4, x: 200, y: 20 }] }, 3)
  expect(selected).toHaveLength(3)
  expect(selected[0].t).toBe(0); expect(selected.at(-1).t).toBe(14.5)
  expect(() => selectRecordingFrames(packet, 0)).toThrow()
})
test('speech cannot create end-of-recording coverage from impossible timestamps', () => {
  for (const timestamp of [[29.38, 29.38], [8, 7], [-1, 2], [NaN, 2], [14.9, 15], [14.75, 14.8], [14.7, 14.8]]) {
    expect(() => validateRecordingWords([{ text: 'word', start: timestamp[0], end: timestamp[1] }], 14.7)).toThrow()
  }
  expect(() => validateRecordingWords([{ text: 'a', start: 6, end: 7 }, { text: 'b', start: 3, end: 4 }], 14.7)).toThrow()
  const original = [{ text: ' original ', start: 3, end: 4, confidence: .3 }]
  expect(validateRecordingWords(original, 14.7)).toEqual(original)
  expect(validateRecordingWords(original, 14.7)).not.toBe(original)
  expect(() => validateRecordingWords(original, NaN)).toThrow()
  expect(validateRecordingWords([{ text: 'end', start: 14.6, end: 14.8 }], 14.7)[0].end).toBe(14.7)
})

test('agent evidence bounds pictures and pointer observations without changing the original packet', async () => {
  const { prepareRecordingEvidence, validateRecordingEvidence } = await import('../packages/capture/src/recordingEvidence.ts')
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXp0AAAAASUVORK5CYII='
  const source = { ...packet, id: crypto.randomUUID(), projectId: 'project', duration: 60, microphone: false, limitations: [], transcript: { status: 'none', text: '', words: [] },
    frames: frames.map(frame => ({ ...frame, dataUrl: image })),
    pointers: Array.from({ length: 1800 }, (_, i) => ({ t: i / 30, x: i, y: 0, worldX: i, worldY: 0, buttons: i === 240 ? 1 : 0, kind: i === 240 ? 'down' : i === 241 ? 'up' : 'move', view: frames[0].view })) }
  const evidence = await prepareRecordingEvidence(source)
  expect(evidence.frames).toHaveLength(1); expect(evidence.frames[0].observedAt).toHaveLength(8); expect(evidence.pointers).toHaveLength(128)
  expect(evidence.observed).toEqual({ frames: 30, pointers: 1800, moments: 20 })
  expect(evidence.pointers.some(point => point.kind === 'down' && point.t === 8)).toBe(true)
  expect(evidence.pointers[0]).toEqual(source.pointers[0]); expect(evidence.pointers.at(-1)).toEqual(source.pointers.at(-1))
  expect(source.pointers).toHaveLength(1800)
  await expect(validateRecordingEvidence(evidence, 'project')).resolves.toEqual(evidence)
  await expect(validateRecordingEvidence({ ...evidence, pointers: [{ ...evidence.pointers[0], t: 61 }] }, 'project')).rejects.toThrow('duration')
  const separate = await prepareRecordingEvidence({ ...source, frames: [
    { ...source.frames[0], id: 'initial', t: 0 },
    { ...source.frames[0], id: 'moved-view', t: 10, view: { ...source.frames[0].view, x: 100 } },
    { ...source.frames[0], id: 'changed-object', t: 20, objects: [{ id: 'new-object', bounds: { x: 0, y: 0, width: 1, height: 1 } }] }
  ] })
  // Shared pixels do not authorize collapsing distinct scene observations.
  expect(separate.frames.map(f => f.id)).toEqual(['initial', 'moved-view', 'changed-object'])
  expect(separate.frames.every(f => f.sha256 === evidence.frames[0].sha256)).toBe(true)
  await expect(validateRecordingEvidence(separate, 'project')).resolves.toEqual(separate)
})
