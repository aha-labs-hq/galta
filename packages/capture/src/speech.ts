import { z } from 'zod'

import { SPEECH_AUDIO_BYTES } from './cloudSpeech'
export { SPEECH_AUDIO_BYTES } from './cloudSpeech'
export const speechRequestSchema = z.strictObject({
  id: z.string().uuid(), locale: z.enum(['zh-CN', 'en-US', 'ja-JP', 'ko-KR']).optional(),
  wav: z.string().min(60).max(Math.ceil(SPEECH_AUDIO_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/)
})
export type SpeechRequest = z.infer<typeof speechRequestSchema>
export type SpeechLocale = NonNullable<SpeechRequest['locale']>
export const recordingSpanSchema = z.strictObject({ start: z.number().nonnegative(), end: z.number().nonnegative() })
export const recordingWordSchema = z.strictObject({ text: z.string().max(1000), start: z.number().nonnegative(), end: z.number().nonnegative(), confidence: z.number().min(0).max(1).optional(), spans: z.array(recordingSpanSchema).min(2).max(120).optional() })
export const speechAudioSchema = z.strictObject({ activity: z.array(recordingSpanSchema).max(200), removedSilence: z.number().nonnegative().max(60) })
export const speechResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), id: z.string().uuid(), text: z.string().max(20_000), duration: z.number().positive().max(60.1),
    words: z.array(recordingWordSchema).max(2000), audio: speechAudioSchema.optional(), contextText: z.string().max(20_000).optional(),
    provider: z.literal('apple'), onDevice: z.literal(true), locale: z.string().max(20) }),
  z.strictObject({ ok: z.literal(false), error: z.string().max(2000) })
])
export type SpeechResponse = z.infer<typeof speechResponseSchema>
