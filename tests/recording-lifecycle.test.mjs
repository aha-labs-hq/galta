import { test, expect } from 'bun:test'
import { Window } from 'happy-dom'
import { CanvasRecording } from '../apps/extension/src/recording/CanvasRecording.ts'

async function fixture(run) {
  const dom = new Window(), tracks = [], recorders = []
  class Track extends EventTarget {
    readyState = 'live'
    stop() { this.readyState = 'ended' }
    constructor(kind) { super(); this.kind = kind; tracks.push(this) }
  }
  class Stream {
    tracks = []
    getTracks() { return this.tracks }
    getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio') }
    addTrack(track) { this.tracks.push(track) }
  }
  class Recorder {
    static isTypeSupported() { return true }
    state = 'inactive'
    mimeType = 'video/webm'
    constructor() { recorders.push(this) }
    start() { this.state = 'recording'; queueMicrotask(() => this.onstart?.()) }
    stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['media']) }); this.onstop?.() }) }
  }
  const create = dom.document.createElement.bind(dom.document)
  dom.document.createElement = (tag, ...args) => {
    const node = create(tag, ...args)
    if (tag === 'canvas') {
      node.getContext = () => ({ canvas: node, fillRect() {}, drawImage() {} })
      node.captureStream = () => { const stream = new Stream(); stream.addTrack(new Track('video')); return stream }
    }
    return node
  }
  let grant, requests = 0
  class AudioMeter {
    createAnalyser() { return { fftSize: 256, getFloatTimeDomainData(values) { values.fill(0) }, disconnect() {} } }
    createMediaStreamSource() { return { connect() {} } }
    async resume() {}
    async close() {}
  }
  let background = '#171717', documentState = { elements: [], files: {} }, previews = 0
  const globals = {
    AudioContext: AudioMeter,
    window: dom, document: dom.document, MediaRecorder: Recorder,
    navigator: { mediaDevices: { getUserMedia: () => { requests++; return new Promise(resolve => { grant = resolve }) } } },
    getComputedStyle: () => ({ getPropertyValue: name => name.includes('size') ? '6px' : name === '--stroke-surface' ? '1px' : background }),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, FileReader: class {
      readAsDataURL(blob) { void blob.arrayBuffer().then(buffer => { this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`; this.onload?.() }) }
    },
  }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const surface = create('section')
  surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 480 })
  const scene = { snapshot: () => ({ document: structuredClone(documentState) }), surface: { x: 0, y: 0, width: 640, height: 480, zoom: 1 }, visibleGeometry: () => ({ ids: [], objects: [] }), preview: async () => new Blob([`picture-${++previews}`], { type: 'image/png' }) }
  const session = new CanvasRecording(surface, scene, 'test-project', () => { void session.stop() })
  try {
    await run({ session, scene, tracks, recorders, previews: () => previews, document: value => { documentState = value }, background: value => { background = value }, grant: () => { const stream = new Stream(); stream.addTrack(new Track('audio')); grant(stream) }, requests: () => requests })
  } finally {
    session.cancel(); await dom.happyDOM.abort()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
}

test('cancelling a pending permission releases a microphone granted afterwards', async () => fixture(async ({ session, tracks, grant }) => {
  const start = session.start(true)
  session.cancel()
  await expect(start).rejects.toThrow('Recording cancelled')
  grant(); await Promise.resolve()
  expect(tracks).toHaveLength(1)
  expect(tracks[0].readyState).toBe('ended')
}))

test('stop releases audio and video and preserves one bounded result', async () => fixture(async ({ session, tracks, grant }) => {
  const start = session.start(true); grant(); await start
  const first = session.stop(), second = session.stop()
  expect(first).toBe(second)
  const result = await first
  expect(result.packet.microphone).toBe(true)
  expect(result.packet.projectId).toBe('test-project')
  expect(result.media.size).toBeGreaterThan(0)
  expect(result.packet.duration).toBeGreaterThanOrEqual(0)
  expect(tracks.map(track => track.readyState)).toEqual(['ended', 'ended'])
  await expect(session.start(true)).rejects.toThrow('already been used')
}))

test('a silent recording never requests microphone access and cancel releases video', async () => fixture(async ({ session, tracks, requests }) => {
  await session.start(false); session.cancel()
  expect(requests()).toBe(0)
  expect(tracks.map(track => track.readyState)).toEqual(['ended'])
}))

test('a recorder error rejects the result and releases its source', async () => fixture(async ({ session, tracks, recorders }) => {
  await session.start(false)
  recorders[0].onerror()
  await expect(session.stop()).rejects.toThrow('could not finish')
  expect(tracks.map(track => track.readyState)).toEqual(['ended'])
}))


test('unchanged artwork reuses its picture while retaining new observation times', async () => fixture(async ({ session, previews }) => {
  await session.start(false); await session.sampling
  const original = session.packet.frames[0]
  await session.sample(); await session.sample()
  expect(previews()).toBe(1)
  expect(session.packet.frames).toHaveLength(3)
  expect(session.packet.frames.map(frame => frame.id)).toEqual(['frame-1', 'frame-2', 'frame-3'])
  expect(session.packet.frames.every(frame => frame.dataUrl === original.dataUrl && frame.t >= original.t)).toBe(true)
  session.cancel(); expect(session.picture).toBeUndefined()
}))

test('drawing, assets, camera, viewport and theme each invalidate the observation', async () => fixture(async ({ session, scene, document, background, previews }) => {
  await session.start(false); await session.sampling
  document({ elements: [{ id: 'ink', points: [[0, 0], [10, 20]] }], files: {} }); await session.sample()
  document({ elements: [{ id: 'ink', points: [[0, 0], [10, 21]] }], files: {} }); await session.sample()
  document({ elements: [{ id: 'ink', points: [[0, 0], [10, 21]] }], files: { image: { dataURL: 'changed-image' } } }); await session.sample()
  scene.surface.x = 10; await session.sample()
  scene.surface.zoom = 2; await session.sample()
  scene.surface.width = 800; await session.sample()
  background('#fff'); await session.sample()
  expect(previews()).toBe(8)
  expect(new Set(session.packet.frames.map(frame => frame.dataUrl)).size).toBe(8)
  await session.sample(); expect(previews()).toBe(8)
}))

test('cancel aborts an in-flight evidence export and cannot repopulate its cache', async () => fixture(async ({ session, scene }) => {
  let signal
  scene.preview = (...args) => new Promise((resolve, reject) => {
    signal = args[5]; signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  await session.start(false); session.cancel(); await session.sampling
  expect(signal.aborted).toBe(true)
  expect(session.packet.frames).toHaveLength(0)
  expect(session.picture).toBeUndefined()
}))
