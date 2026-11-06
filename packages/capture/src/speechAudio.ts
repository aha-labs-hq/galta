/** Audio preparation and clock mapping. No language, pointer or intent inference. */
export const SPEECH_SAMPLE_RATE = 16_000
export type AudioRegion = { start: number; end: number; outputStart: number }
export type PreparedSpeechAudio = {
  wav: Uint8Array; duration: number; regions: AudioRegion[]
  activity: { start: number; end: number }[]; removedSilence: number
}

/** Keep PCM unchanged; remove only quiet gaps with generous consonant padding. */
export function prepareSpeechAudio(source: Float32Array): PreparedSpeechAudio {
  if (!source.length || source.length > 960_000) throw new Error('Recording audio must be between 0 and 60 seconds.')
  const rate = SPEECH_SAMPLE_RATE, hop = 320, energy: number[] = []
  for (let start = 0; start < source.length; start += hop) {
    const end = Math.min(source.length, start + hop); let sum = 0
    for (let i = start; i < end; i++) { const sample = source[i]!; if (!Number.isFinite(sample)) throw new Error('Invalid audio sample.'); sum += sample * sample }
    energy.push(10 * Math.log10(Math.max(1e-12, sum / (end - start))))
  }
  const ordered = [...energy].sort((a, b) => a - b)
  const floor = ordered[Math.floor(ordered.length / 5)]!, foreground = ordered[Math.floor((ordered.length - 1) * .95)]!
  const threshold = Math.min(-35, Math.max(-65, floor + 12, foreground - 20))
  const runs: { start: number; end: number; peak: number }[] = []
  energy.forEach((db, i) => {
    if (db < threshold - 6) return
    const last = runs.at(-1)
    if (last && i - last.end <= 10) { last.end = i + 1; last.peak = Math.max(last.peak, db) }
    else runs.push({ start: i, end: i + 1, peak: db })
  })
  const activity = runs.filter(run => run.peak >= threshold && run.end - run.start >= 5)
    .map(run => ({ start: run.start * hop / rate, end: Math.min(source.length, run.end * hop) / rate }))
  // Activity is evidence, not a speech detector. Quiet/short sounds that fail
  // its gate must still reach Whisper. Only crop below a conservative floor.
  const quietThreshold = Math.min(-60, threshold - 12)
  let regions: AudioRegion[] = []
  energy.forEach((db, i) => {
    if (db < quietThreshold) return
    const start = Math.max(0, i * hop - 5600), end = Math.min(source.length, (i + 1) * hop + 5600), last = regions.at(-1)
    if (last && start <= last.end) last.end = end
    else regions.push({ start, end, outputStart: 0 })
  })
  let kept = regions.reduce((n, r) => n + r.end - r.start, 0)
  if (!kept || source.length - kept < 8000) { regions = [{ start: 0, end: source.length, outputStart: 0 }]; kept = source.length }
  const wav = new Uint8Array(44 + kept * 2), view = new DataView(wav.buffer)
  const text = (offset: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)) }
  text(0, 'RIFF'); view.setUint32(4, wav.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, kept * 2, true)
  let output = 0
  for (const region of regions) {
    region.outputStart = output
    for (let i = region.start; i < region.end; i++, output++) {
      const sample = Math.max(-1, Math.min(1, source[i]!))
      view.setInt16(44 + output * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true)
    }
  }
  return { wav, duration: source.length / rate, regions, activity, removedSilence: (source.length - kept) / rate }
}

/** A word crossing a splice has multiple source spans, never an invented midpoint. */
export function originalSpeechSpans(regions: AudioRegion[], start: number, end: number) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Invalid speech timing.')
  return regions.flatMap(region => {
    const from = region.outputStart / SPEECH_SAMPLE_RATE, to = from + (region.end - region.start) / SPEECH_SAMPLE_RATE
    const a = Math.max(start, from), b = Math.min(end, to)
    if (b <= a) return []
    const offset = (region.start - region.outputStart) / SPEECH_SAMPLE_RATE
    return [{ start: a + offset, end: b + offset }]
  })
}
