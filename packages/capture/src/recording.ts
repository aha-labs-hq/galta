/** Observations, never inferred intent. All t values share the session's media clock. */
import type { SpeechLocale } from './speech'
export type RecordingView = { x: number; y: number; width: number; height: number; zoom: number }
export type RecordingPointer = { t: number; x: number; y: number; worldX: number; worldY: number; buttons: number; kind: 'move' | 'down' | 'up' | 'leave'; view: RecordingView }
export type RecordingSpan = { start: number; end: number }
export type RecordingWord = RecordingSpan & { text: string; confidence?: number | undefined; spans?: RecordingSpan[] | undefined }
export type RecordingAudio = { activity: RecordingSpan[]; removedSilence: number }
export type RecordingFrame = { id: string; t: number; view: RecordingView; dataUrl: string; objectIds: string[]; unrenderedIds: string[]; objects?: { id: string; bounds: { x: number; y: number; width: number; height: number } }[] }
export type RecordingPacket = {
  schema: 'galta.recording/1'; id: string; projectId: string; duration: number
  clock: { source: 'performance.now'; origin: 'media-recorder-start'; audioOffset: number }
  surface: 'galta-canvas'; microphone: boolean; speechLocale?: SpeechLocale; frames: RecordingFrame[]; pointers: RecordingPointer[]
  transcript: { status: 'none' | 'available' | 'failed'; text: string; words: RecordingWord[]; provider?: 'apple' | 'cloudflare'; locale?: string; error?: string; audio?: RecordingAudio; contextText?: string }
  limitations: string[]
}
export const RECORDING_LIMITS = { seconds: 60, pointerHz: 30, frames: 120, evidence: 8, frameBytes: 600_000, bytes: 32 * 1024 * 1024 } as const

/** Deterministic initial budget: endpoints, utterance boundaries and pointer
 * travel. Selection is evidence retrieval, not a target or gesture classifier. */
export function selectRecordingFrames(packet: Pick<RecordingPacket, 'frames' | 'pointers' | 'transcript'>, budget = RECORDING_LIMITS.evidence): RecordingFrame[] {
  if (!Number.isInteger(budget) || budget < 1) throw new Error('A positive frame budget is required')
  const frames = packet.frames
  if (frames.length <= budget) return [...frames]
  const chosen = new Set<number>([0])
  if (budget > 1) chosen.add(frames.length - 1)
  const anchors = packet.transcript.audio?.activity.length ? packet.transcript.audio.activity.map(span => (span.start + span.end) / 2)
    : packet.transcript.words.flatMap((word, index, words) => index === 0 || word.start - words[index - 1]!.end > .5 ? [word.start, word.end] : [])
  for (const t of anchors) {
    if (chosen.size === budget) break
    let closest = 0
    frames.forEach((frame, i) => { if (Math.abs(frame.t - t) < Math.abs(frames[closest]!.t - t)) closest = i })
    chosen.add(closest)
  }
  while (chosen.size < budget) {
    let best = -1, score = -1
    frames.forEach((frame, i) => {
      if (chosen.has(i)) return
      const distance = Math.min(...[...chosen].map(j => Math.abs(frame.t - frames[j]!.t)))
      const recent = packet.pointers.filter(p => p.t >= frame.t - .5 && p.t <= frame.t)
      const first = recent[0], last = recent.at(-1)
      const motion = first && last ? Math.min(1, Math.hypot(last.x - first.x, last.y - first.y) / 150) : 0
      const value = distance * (1 + motion * .35)
      if (value > score) { score = value; best = i }
    })
    if (best < 0) break
    chosen.add(best)
  }
  return [...chosen].sort((a, b) => a - b).map(i => frames[i]!)
}

export function validateRecordingWords(words: readonly RecordingWord[], duration: number): RecordingWord[] {
  if (!Number.isFinite(duration) || duration < 0) throw new Error('Invalid recording duration')
  let previous = 0
  return words.map(word => {
    if (!word.text || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < previous || word.start >= duration || word.end <= word.start || word.end > duration + .15) throw new Error('Speech timing does not match this recording')
    previous = word.start
    if (word.spans) {
      validateRecordingSpans(word.spans, duration)
      if (Math.abs(word.spans[0]!.start - word.start) > .001 || Math.abs(word.spans.at(-1)!.end - word.end) > .001) throw new Error('Speech intervals do not match their segment')
    }
    return { ...word, end: Math.min(duration, word.end), ...(word.spans ? { spans: word.spans.map(span => ({ ...span, end: Math.min(duration, span.end) })) } : {}) }
  })
}

export function validateRecordingSpans(spans: readonly RecordingSpan[], duration: number): RecordingSpan[] {
  let previous = 0
  return spans.map(span => {
    if (!Number.isFinite(span.start) || !Number.isFinite(span.end) || span.start < previous || span.start >= duration || span.end <= span.start || span.end > duration + .15) throw new Error('Audio intervals do not match this recording')
    previous = span.end
    return { start: span.start, end: Math.min(duration, span.end) }
  })
}
