import { RECORDING_LIMITS, type RecordingPacket, type RecordingView } from '@galta/capture'
import type { CanvasScene, SceneSnapshot } from '../canvas/scene'
import { documentEquals } from '../canvas/documentEquality'
import { themeColor, themeLength } from '../design/theme'
import { CanvasPixels } from './CanvasPixels'

export type RecordingResult = { packet: RecordingPacket; media: Blob }
const dataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob)
})

async function boundedPicture(blob: Blob): Promise<Blob> {
  if (blob.size <= RECORDING_LIMITS.frameBytes) return blob
  const source = await createImageBitmap(blob), canvas = new OffscreenCanvas(source.width, source.height)
  try {
    for (let scale = 1; scale >= .25; scale *= .75) {
      canvas.width = Math.max(1, Math.round(source.width * scale)); canvas.height = Math.max(1, Math.round(source.height * scale))
      canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height)
      const picture = await canvas.convertToBlob({ type: 'image/jpeg', quality: .7 })
      if (picture.size <= RECORDING_LIMITS.frameBytes) return picture
    }
    throw new Error('The evidence picture exceeds its size budget.')
  } finally { source.close() }
}

/** One bounded recording, including silent pointing. Owns every acquired track
 * and listener, and freezes observations before asynchronous image encoding. */
export class CanvasRecording {
  private meter: AudioContext | undefined
  private analyser: AnalyserNode | undefined
  private samples: Float32Array | undefined
  // Sample only when the visible pointer asks. Video's 15 fps clock must not
  // throttle voice feedback, and an off-canvas pointer needs no audio metering.
  get level() {
    if (!this.analyser || !this.samples) return 0
    this.analyser.getFloatTimeDomainData(this.samples)
    let sum = 0
    for (const value of this.samples) sum += value * value
    return Math.min(1, Math.sqrt(sum / this.samples.length) * 6)
  }
  private stream?: MediaStream
  private recorder?: MediaRecorder
  private chunks: Blob[] = []
  private output = document.createElement('canvas')
  private animation = 0
  private nextVideoFrame = 0
  private pixels: CanvasPixels | undefined
  private sampleTimer = 0
  private limitTimer = 0
  private started = 0
  private end = 0
  private active = false
  private used = false
  private cancelled = false
  private bytes = 0
  private lastMove = -Infinity
  private sampling: Promise<void> = Promise.resolve()
  private completion?: Promise<RecordingResult>
  private resolve?: (value: RecordingResult) => void
  private reject?: (error: Error) => void
  private startReject: ((error: Error) => void) | undefined
  private marker: { x: number; y: number } | undefined
  private markerStyle?: { color: string; edge: string; radius: number; stroke: number }
  readonly packet: RecordingPacket
  constructor(private surface: HTMLElement, private scene: CanvasScene, projectId: string, private onLimit: () => void) {
    this.packet = { schema: 'galta.recording/1', id: crypto.randomUUID(), projectId, duration: 0,
      clock: { source: 'performance.now', origin: 'media-recorder-start', audioOffset: 0 }, surface: 'galta-canvas', microphone: false, frames: [], pointers: [],
      transcript: { status: 'none', text: '', words: [] }, limitations: [
        'Records the Galta canvas, not other tabs or the desktop.',
        'Video contains native canvas pixels; DOM page/video overlays and interface labels are not composited. Evidence images use static posters where supported.',
        'Video shows a neutral pointer marker; evidence images keep original pixels with pointer observations stored separately.',
        'Speech times are model estimates; hardware audio latency is not calibrated.'
      ] }
  }
  get elapsed() { return this.started ? (this.active ? performance.now() - this.started : this.end) / 1000 : 0 }
  private view(): RecordingView { const { x, y, width, height, zoom } = this.scene.surface; return { x, y, width, height, zoom } }
  async start(microphone: boolean) {
    if (this.used || this.cancelled) throw new Error('This recording has already been used.')
    this.used = true
    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/mp4'].find(type => MediaRecorder.isTypeSupported(type))
    if (!mimeType) throw new Error('This browser cannot record the canvas.')
    let microphoneStream: MediaStream | undefined
    try {
      if (microphone) microphoneStream = await this.openMicrophone()
      if (this.cancelled) { microphoneStream?.getTracks().forEach(track => track.stop()); throw new DOMException('Recording cancelled', 'AbortError') }
      const rect = this.surface.getBoundingClientRect(), scale = Math.min(1, 1400 / rect.width)
      this.output.width = Math.max(2, Math.floor(rect.width * scale / 2) * 2)
      this.output.height = Math.max(2, Math.floor(rect.height * scale / 2) * 2)
      this.packet.microphone = microphone
      this.markerStyle = { color: themeColor('foreground'), edge: themeColor('background'), radius: themeLength('--recording-marker-size') / 2, stroke: themeLength('--stroke-surface') }
      this.pixels = new CanvasPixels(this.surface)
      this.paint(performance.now())
      this.stream = this.output.captureStream(15)
      for (const track of microphoneStream?.getAudioTracks() ?? []) this.stream.addTrack(track)
      if (microphoneStream) {
        this.meter = new AudioContext()
        this.analyser = this.meter.createAnalyser(); this.analyser.fftSize = 256
        this.samples = new Float32Array(this.analyser.fftSize)
        this.meter.createMediaStreamSource(microphoneStream).connect(this.analyser)
        void this.meter.resume().catch(() => undefined)
      }
      const recorder = this.recorder = new MediaRecorder(this.stream, { mimeType, videoBitsPerSecond: 2_500_000 })
      this.completion = new Promise<RecordingResult>((resolve, reject) => { this.resolve = resolve; this.reject = reject })
      // A late recorder error must never become an unhandled rejection while
      // the user is still recording; stop() retains the original rejection.
      void this.completion.catch(() => undefined)
      recorder.ondataavailable = event => {
        if (event.data.size) { this.chunks.push(event.data); this.bytes += event.data.size }
        if (this.active && this.bytes >= RECORDING_LIMITS.bytes) { this.packet.limitations.push('Stopped at the recording size limit.'); this.onLimit() }
      }
      recorder.onerror = () => {
        const error = new Error('The browser could not finish this recording.')
        this.cancelled = true; this.previewAbort.abort()
        this.reject?.(error); this.startReject?.(error)
        if (this.active) this.onLimit()
        this.end = this.started ? performance.now() - this.started : 0; this.active = false
        this.cleanup()
      }
      recorder.onstop = () => { void this.sampling.then(() => {
        this.packet.duration = this.end / 1000
        this.resolve?.({ packet: this.packet, media: new Blob(this.chunks, { type: recorder.mimeType }) })
      }).catch(error => this.reject?.(error)).finally(() => { this.chunks = [] }) }
      await new Promise<void>((resolve, reject) => {
        this.startReject = reject
        recorder.onstart = () => {
          if (this.cancelled) { this.cleanup(); reject(new DOMException('Recording cancelled', 'AbortError')); return }
          this.started = performance.now(); this.active = true
          for (const type of ['pointermove', 'pointerdown', 'pointerup', 'pointerleave']) this.surface.addEventListener(type, this.pointer as EventListener, true)
          this.sampling = this.sample()
          this.sampleTimer = window.setInterval(() => { if (!this.takingSample) this.sampling = this.sample() }, 500)
          this.limitTimer = window.setTimeout(() => this.onLimit(), RECORDING_LIMITS.seconds * 1000)
          document.addEventListener('visibilitychange', this.visibility)
          window.addEventListener('blur', this.clearMarker)
          for (const track of this.stream!.getTracks()) track.addEventListener('ended', this.trackEnded)
          this.startReject = undefined
          resolve()
        }
        try { recorder.start(250) } catch (error) { reject(error) }
      })
    } catch (error) { microphoneStream?.getTracks().forEach(track => track.stop()); this.cleanup(); throw error }
  }
  private openMicrophone(): Promise<MediaStream> {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error?: Error, stream?: MediaStream) => {
        if (settled) { stream?.getTracks().forEach(track => track.stop()); return }
        settled = true; clearTimeout(timer); this.startReject = undefined
        if (error) reject(error)
        else resolve(stream!)
      }
      const timer = window.setTimeout(() => finish(new Error('The microphone did not respond. Check microphone access in your browser, then try again.')), 15_000)
      this.startReject = error => finish(error)
      try {
        navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }).then(stream => finish(undefined, stream), error => finish(error))
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
    })
  }
  private pointer = (event: PointerEvent) => {
    if (!this.active) return
    const t = this.elapsed, target = event.target
    const onCanvas = target instanceof Element && !!target.closest('.excalidraw__canvas')
    const kind = event.type === 'pointerleave' || !onCanvas ? 'leave' : ({ pointermove: 'move', pointerdown: 'down', pointerup: 'up' } as const)[event.type as 'pointermove']
    const rect = this.pixels!.bounds
    this.marker = kind === 'leave' || event.pointerType === 'touch' ? undefined : { x: event.clientX - rect.left, y: event.clientY - rect.top }
    if (kind === 'move' && t - this.lastMove < 1 / RECORDING_LIMITS.pointerHz) return
    if (kind === 'move') this.lastMove = t
    if (kind === 'leave' && this.packet.pointers.at(-1)?.kind === 'leave') return
    const world = this.scene.point({ x: event.clientX, y: event.clientY })
    this.packet.pointers.push({ t, x: event.clientX - rect.left, y: event.clientY - rect.top, worldX: world.x, worldY: world.y, buttons: event.buttons, kind, view: this.view() })
  }
  private clearMarker = () => { this.marker = undefined }
  private visibility = () => {
    if (document.hidden && this.active) { this.packet.limitations.push('Stopped when the recording view became hidden.'); this.onLimit() }
  }
  private trackEnded = () => {
    if (this.active) { this.packet.limitations.push('Stopped because a media source disconnected.'); this.onLimit() }
  }
  private takingSample = false
  private readonly previewAbort = new AbortController()
  // One immutable observation, never a second scene. Pointing and speaking do
  // not change the artwork: retain its pixels while every timestamp stays new.
  private picture: { document: SceneSnapshot['document']; view: RecordingView; background: string;
    value: Pick<RecordingPacket['frames'][number], 'dataUrl' | 'objectIds' | 'unrenderedIds' | 'objects'> } | undefined
  private async sample() {
    if (!this.active || this.takingSample || this.packet.frames.length >= RECORDING_LIMITS.frames) return
    this.takingSample = true
    try {
      const t = this.elapsed, view = this.view(), document = this.scene.snapshot().document, background = themeColor('background')
      const cached = this.picture
      if (cached && background === cached.background && documentEquals(view, cached.view) && documentEquals(document, cached.document)) {
        this.packet.frames.push({ id: `frame-${this.packet.frames.length + 1}`, t, view, ...cached.value })
        return
      }
      const { ids: objectIds, objects } = this.scene.visibleGeometry(80), unrenderedIds: string[] = []
      const blob = await this.scene.preview([], 'low', view, unrenderedIds, undefined, this.previewAbort.signal)
      if (this.cancelled) return
      const picture = blob ?? await new Promise<Blob>((resolve, reject) => this.output.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not capture this frame')), 'image/jpeg', .8))
      const bounded = await boundedPicture(picture)
      if (bounded !== picture && !this.packet.limitations.includes('Some evidence pictures were recompressed or downsampled to fit the picture budget.')) this.packet.limitations.push('Some evidence pictures were recompressed or downsampled to fit the picture budget.')
      const image = await dataUrl(bounded)
      if (!this.cancelled) {
        const value = { dataUrl: image, objectIds, unrenderedIds, objects }
        this.packet.frames.push({ id: `frame-${this.packet.frames.length + 1}`, t, view, ...value })
        // A fallback video frame may contain its neutral pointer marker and is
        // not a semantic preview. Never cache that under a document identity.
        if (this.active && blob) this.picture = { document, view, background, value }
      }
    } catch {
      if (!this.cancelled) this.packet.limitations.push(`No evidence picture at ${this.elapsed.toFixed(2)} seconds.`)
    } finally { this.takingSample = false }
  }
  private paint = (now: number) => {
    this.animation = requestAnimationFrame(this.paint)
    // Keep an independent deadline; resetting it to now + interval would
    // accumulate jitter and accidentally drop to 12 fps on a 60 Hz display.
    if (now + .5 < this.nextVideoFrame) return
    this.nextVideoFrame += 1000 / 15
    if (this.nextVideoFrame <= now) this.nextVideoFrame = now + 1000 / 15
    const context = this.output.getContext('2d')!, rect = this.pixels!.bounds
    this.pixels!.draw(context)
    const sx = this.output.width / rect.width, sy = this.output.height / rect.height
    if (this.marker && this.markerStyle) {
      context.save(); context.scale(sx, sy)
      context.fillStyle = this.markerStyle.color; context.strokeStyle = this.markerStyle.edge; context.lineWidth = this.markerStyle.stroke
      context.beginPath(); context.arc(this.marker.x, this.marker.y, this.markerStyle.radius, 0, Math.PI * 2); context.fill(); context.stroke(); context.restore()
    }
  }
  stop(): Promise<RecordingResult> {
    if (!this.completion || !this.recorder) return Promise.reject(new Error('The recording has not started.'))
    if (this.active) {
      this.end = performance.now() - this.started; this.active = false
      this.cleanup()
      if (this.recorder.state !== 'inactive') this.recorder.stop()
    }
    return this.completion
  }
  cancel() {
    this.cancelled = true; this.previewAbort.abort()
    this.startReject?.(new DOMException('Recording cancelled', 'AbortError'))
    if (this.active) { this.end = performance.now() - this.started; this.active = false }
    this.cleanup()
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop()
  }
  private cleanup() {
    cancelAnimationFrame(this.animation); clearInterval(this.sampleTimer); clearTimeout(this.limitTimer)
    for (const type of ['pointermove', 'pointerdown', 'pointerup', 'pointerleave']) this.surface.removeEventListener(type, this.pointer as EventListener, true)
    document.removeEventListener('visibilitychange', this.visibility); window.removeEventListener('blur', this.clearMarker)
    this.stream?.getTracks().forEach(track => { track.removeEventListener('ended', this.trackEnded); track.stop() })
    this.marker = undefined; this.picture = undefined
    this.pixels?.dispose(); this.pixels = undefined
    this.analyser?.disconnect(); this.analyser = undefined; this.samples = undefined
    if (this.meter) { void this.meter.close().catch(() => undefined); this.meter = undefined }
  }
}
