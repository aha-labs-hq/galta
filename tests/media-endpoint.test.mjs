import { test, expect } from 'bun:test'
import { Endpoint, resultFiles } from '../native/media/providers/endpoint'
import { parseMediaInput } from '../packages/canvas/src/capabilities/media'

const image = input => ({ kind: 'image', input: parseMediaInput('generate_image', { prompt: 'A vessel', requestId: 'request-0001', ...input }) })
const video = input => ({ kind: 'video', input: parseMediaInput('generate_video', { prompt: 'It turns', requestId: 'request-0001', ...input }) })
const speech = input => ({ kind: 'speech', input: parseMediaInput('generate_speech', { model: 'vendor/voice', text: 'Hello', voice: 'Rachel', requestId: 'request-0001', ...input }) })
const endpoint = (makes, properties, required = []) => new Endpoint('vendor/model', makes, { type: 'object', properties, required })
const text = { type: 'string' }, list = maxItems => ({ type: 'array', items: text, ...(maxItems ? { maxItems } : {}) })
const urls = ['https://example.com/a.png', 'https://example.com/b.png']

test('a duration is written as the model takes it and checked against what it allows', () => {
  expect(endpoint('video', { duration: { type: 'string', enum: ['5', '10'] } }).body(video({ duration: 10 })).duration).toBe('10')
  expect(endpoint('video', { duration: { type: 'string', enum: ['4s', '8s'] } }).body(video({ duration: 8 })).duration).toBe('8s')
  expect(endpoint('video', { duration: { type: 'integer', minimum: 4, maximum: 30 } }).body(video({ duration: 12 })).duration).toBe(12)
  expect(endpoint('video', { duration: { type: 'string', enum: ['auto', '5'] } }).body(video({ duration: -1 })).duration).toBe('auto')
  expect(() => endpoint('video', { duration: { type: 'string', enum: ['5', '10'] } }).body(video({ duration: 7 }))).toThrow('duration must be one of 5, 10 for this model')
  expect(() => endpoint('video', { duration: { type: 'integer', minimum: 4, maximum: 30 } }).body(video({ duration: -1 }))).toThrow('duration must be from 4 to 30 for this model')
})

test('sound, tiers and tasks take the model\'s own spelling', () => {
  expect(endpoint('video', { sound: { type: 'string', enum: ['on', 'off'] } }).body(video({ audio: false })).sound).toBe('off')
  expect(endpoint('video', { generate_audio: { type: 'boolean' } }).body(video({ audio: false })).generate_audio).toBe(false)
  expect(endpoint('image', { resolution: { type: 'string', enum: ['1k', '2k'] } }).body(image({ size: '2K' })).resolution).toBe('2k')
  const recraft = endpoint('image', { output_format: { type: 'string', enum: ['jpg', 'png'] } })
  expect(recraft.body(image({ format: 'jpeg' })).output_format).toBe('jpg')
  expect(recraft.controls().format).toEqual(['jpeg', 'png'])
  expect(endpoint('video', { task: { type: 'string', enum: ['reference', 'editing', 'extension'] }, video_urls: list() }).body(video({ task: 'edit', referenceVideo: ['https://example.com/v.mp4'] })).task).toBe('editing')
})

test('references go to a list, or one alone to a single field; a field the model requires is filled first', () => {
  expect(endpoint('image', { image_urls: list(3) }).body(image({ references: urls })).image_urls).toEqual(urls)
  expect(endpoint('image', { image_url: text }).body(image({ references: [urls[0]] })).image_url).toBe(urls[0])
  expect(() => endpoint('image', { image_url: text }).body(image({ references: urls }))).toThrow('references takes only one for this model')
  expect(() => endpoint('image', { image_urls: list(1) }).body(image({ references: urls }))).toThrow('references takes at most 1 for this model')
  // An edit's source video is the one it requires.
  const edit = endpoint('video', { video_url: text, video_urls: list() }, ['video_url'])
  expect(edit.body(video({ referenceVideo: ['https://example.com/source.mp4'] }))).toEqual({ video_url: 'https://example.com/source.mp4' })
  expect(endpoint('video', { video_urls: list() }).body(video({ referenceVideo: ['https://example.com/source.mp4'] }))).toEqual({ video_urls: ['https://example.com/source.mp4'] })
})

test('a ratio becomes one of the named sizes, and an exact size its pixels', () => {
  const sized = endpoint('image', { image_size: { anyOf: [{ type: 'object', properties: { width: { type: 'integer' }, height: { type: 'integer' } } }, { type: 'string', enum: ['square_hd', 'landscape_16_9', 'portrait_16_9'] }] } })
  expect(sized.body(image({ ratio: '16:9' })).image_size).toBe('landscape_16_9')
  expect(sized.body(image({ size: '1536x1024' })).image_size).toEqual({ width: 1536, height: 1024 })
  expect(() => sized.body(image({ ratio: '4:3' }))).toThrow('ratio must be one of 1:1, 16:9, 9:16 for this model')
  expect(() => sized.body(image({ ratio: '16:9', size: '1536x1024' }))).toThrow('Give ratio or an exact size, not both')
  expect(sized.controls()).toEqual({ ratio: ['1:1', '16:9', '9:16'], size: 'WIDTHxHEIGHT' })
})

test('controls the model lacks, BytePlus asset references and unfilled requirements are refused', () => {
  expect(() => endpoint('image', { prompt: text }).body(image({ quality: 'high' }))).toThrow('vendor/model does not take quality')
  expect(() => endpoint('video', { video_urls: list() }).body(video({ referenceVideo: ['asset://clip-1'] }))).toThrow('asset:// references are BytePlus')
  expect(() => endpoint('video', { start_image_url: text }, ['start_image_url']).body(video({}))).toThrow('vendor/model needs firstFrame')
  expect(() => endpoint('image', { prompt: text, preset_id: text }, ['prompt', 'preset_id']).body(image({}))).toThrow('needs preset_id, which Galta cannot set')
})

test('a schema\'s conditional constraints do not hide its fields, and a wrapped reference is followed', () => {
  const conditional = new Endpoint('vendor/edit', 'image', { type: 'object', required: ['prompt', 'image_urls'], allOf: [{ if: { properties: { a: { const: true } } }, then: { required: ['b'] } }], properties: { prompt: text, image_urls: list(3) } })
  expect(conditional.body(image({ references: urls }))).toEqual({ prompt: 'A vessel', image_urls: urls })
  const wrapped = new Endpoint('vendor/model', 'image', { allOf: [{ $ref: '#/$defs/Input' }] }, { Input: { type: 'object', properties: { prompt: text } } })
  expect(wrapped.body(image({}))).toEqual({ prompt: 'A vessel' })
})

test('a model that takes no words is asked without them', () => {
  expect(endpoint('image', { image_url: text }, ['image_url']).body(image({ references: [urls[0]] }))).toEqual({ image_url: urls[0] })
})

test('speech finds where the model keeps the words and the voice, and asks for a file', () => {
  const minimax = new Endpoint('vendor/voice', 'speech', { $ref: '#/components/schemas/Input' }, {
    Input: { type: 'object', required: ['prompt'], properties: { prompt: text, voice_setting: { $ref: '#/components/schemas/VoiceSetting' }, output_format: { type: 'string', enum: ['url', 'hex'] } } },
    VoiceSetting: { type: 'object', properties: { voice_id: text } }
  })
  expect(minimax.body(speech({}))).toEqual({ prompt: 'Hello', voice_setting: { voice_id: 'Rachel' }, output_format: 'url' })
  expect(() => endpoint('speech', { prompt: text, voice: { type: 'string', enum: ['af_heart', 'am_adam'] } }).body(speech({}))).toThrow('voice must be one of af_heart, am_adam for this model')
})

test('the controls a model takes are described in Galta\'s terms', () => {
  const kling = endpoint('video', { image_url: text, last_image_url: text, sound: { type: 'string', enum: ['on', 'off'] }, duration: { type: 'string', enum: ['5', '10'] }, task: { type: 'string', enum: ['reference', 'extension'] } }, ['image_url'])
  expect(kling.controls()).toEqual({ firstFrame: 'required', lastFrame: true, task: ['reference', 'extend'], duration: [5, 10], audio: true })
})

test('results give their files in the shapes providers use', () => {
  expect(resultFiles({ images: [{ url: 'https://a.example/1.png' }, { url: 'https://a.example/2.png' }], seed: 3 })).toEqual([{ url: 'https://a.example/1.png' }, { url: 'https://a.example/2.png' }])
  expect(resultFiles({ image: { url: 'https://a.example/cut.png' }, mask_image: { url: 'https://a.example/mask.png' } })).toEqual([{ url: 'https://a.example/cut.png' }])
  expect(resultFiles({ video: { url: 'https://a.example/v.mp4' } })).toEqual([{ url: 'https://a.example/v.mp4' }])
  expect(resultFiles({ audio_url: 'https://a.example/s.mp3' })).toEqual([{ url: 'https://a.example/s.mp3' }])
  expect(resultFiles({ status: 'completed', status_url: 'https://a.example/status' })).toEqual([])
})
