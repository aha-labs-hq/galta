import { test, expect } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { mediaSettings } from '../native/media/settings'
import { KEY, MP4, PNG, WAV, providerFixture } from './helpers/media-fixture'
import { scratch } from './helpers/media-scratch'

const posts = fixture => fixture.requests.filter(request => request.method === 'POST')
const data = `data:image/png;base64,${PNG.toString('base64')}`

test('a fal key is checked on its free price list, sent as fal expects it', () => scratch(async ({ media }) => {
  expect(await mediaSettings({ action: 'connect', provider: 'fal', key: 'wrong-key' }, media, providerFixture().fetch)).toMatchObject({ ok: false, error: "fal didn't accept this key." })
  const fixture = providerFixture()
  expect(await mediaSettings({ action: 'connect', provider: 'fal', key: KEY }, media, fixture.fetch)).toMatchObject({ ok: true })
  expect(fixture.requests).toEqual([{ url: 'https://api.fal.ai/v1/models/pricing?endpoint_id=fal-ai/flux/dev', method: 'GET', authorization: `Key ${KEY}`, body: undefined }])
}))

test('fal lists the models of a kind with what each takes, leaving out deprecated ones', () => scratch(async ({ connected, call }) => {
  const service = await connected('fal', providerFixture())
  const { models, guide } = await call(service, 'generation_models', { provider: 'fal', kind: 'image' })
  expect(models.map(model => [model.id, model.controls.input])).toEqual([['fal-ai/test-image', 'text'], ['fal-ai/nano-banana/edit', 'image']])
  expect(models[1].bestFor).toContain('faithful')
  expect(guide).toContain('each task is its own model id')
  service.close()
}))

// The tests below wait on fal's queue, so they run side by side.
test.concurrent('a fal image is checked against its model before it is paid for, queued once with no fallback, and downloaded without the key', () => scratch(async ({ connected, call }) => {
  const fixture = providerFixture(), service = await connected('fal', fixture)
  let headers
  const queue = fixture.routes['POST queue.fal.run/fal-ai/test-image']
  fixture.routes['POST queue.fal.run/fal-ai/test-image'] = request => { headers = request.headers; return queue(request) }
  const image = args => call(service, 'generate_image', { provider: 'fal', prompt: 'A vessel', ...args })
  await expect(image({ requestId: 'fal-request-1' })).rejects.toThrow('fal needs an exact model id')
  await expect(image({ model: 'fal-ai/test-image', quality: 'high', requestId: 'fal-request-2' })).rejects.toThrow('fal-ai/test-image does not take quality')
  await expect(image({ model: 'fal-ai/test-video/image-to-video', requestId: 'fal-request-3' })).rejects.toThrow('makes video, not images')
  await expect(image({ model: 'fal-ai/unknown', requestId: 'fal-request-4' })).rejects.toThrow('Unknown fal model fal-ai/unknown')
  await expect(image({ model: 'fal-ai/nano-banana/edit', requestId: 'fal-request-5' })).rejects.toThrow('needs references')
  expect(posts(fixture)).toHaveLength(0)

  const done = await image({ model: 'fal-ai/test-image', ratio: '16:9', count: 2, seed: 7, requestId: 'fal-request-6' })
  expect(done).toMatchObject({ status: 'succeeded', provider: 'fal', model: 'fal-ai/test-image' })
  expect(await readFile(done.files[0].path)).toEqual(PNG)
  expect(posts(fixture)).toEqual([{ url: 'https://queue.fal.run/fal-ai/test-image', method: 'POST', authorization: `Key ${KEY}`, body: { prompt: 'A vessel', image_size: 'landscape_16_9', num_images: 2, seed: 7 } }])
  expect(headers.get('x-app-fal-disable-fallback')).toBe('true')
  expect(fixture.requests.filter(request => request.authorization).every(request => /^https:\/\/(api\.fal\.ai|queue\.fal\.run)\//.test(request.url))).toBe(true)
  expect(fixture.requests.find(request => request.url.startsWith('https://v3b.fal.media/')).authorization).toBeNull()
  expect((await image({ model: 'fal-ai/test-image', ratio: '16:9', count: 2, seed: 7, requestId: 'fal-request-6' })).id).toBe(done.id)
  expect(posts(fixture)).toHaveLength(1)
  service.close()
}), 30_000)

test.concurrent('a fal edit takes local references and fal\'s own spelling of a tier', () => scratch(async ({ connected, call, png }) => {
  const fixture = providerFixture(), service = await connected('fal', fixture)
  const done = await call(service, 'generate_image', { model: 'fal-ai/nano-banana/edit', prompt: 'Make it blue', references: [await png('source.png')], ratio: '16:9', size: '2k', requestId: 'fal-edit-1' })
  expect(done.status).toBe('succeeded')
  expect(posts(fixture)[0].body).toEqual({ prompt: 'Make it blue', image_urls: [data], aspect_ratio: '16:9', resolution: '2K' })
  // The result is read where fal's queue keeps it, under owner/alias rather than the endpoint's sub-path.
  expect(fixture.requests.some(request => request.url === 'https://queue.fal.run/fal-ai/nano-banana/requests/fal-edit-1')).toBe(true)
  service.close()
}), 30_000)

test.concurrent('a fal video goes to the frames its model names and resumes from the address fal gave', () => scratch(async ({ connected, call, png }) => {
  let polls = 0
  const fixture = providerFixture({ 'GET queue.fal.run/fal-ai/test-video/requests/fal-video-1/status': () => Response.json({ status: ++polls < 2 ? 'IN_PROGRESS' : 'COMPLETED' }) })
  const service = await connected('fal', fixture), frame = await png('frame.png')
  const video = args => call(service, 'generate_video', { provider: 'fal', model: 'fal-ai/test-video/image-to-video', prompt: 'It turns', ...args })
  await expect(video({ requestId: 'fal-video-0' })).rejects.toThrow('needs firstFrame')
  await expect(video({ firstFrame: frame, duration: 7, requestId: 'fal-video-00' })).rejects.toThrow('duration must be one of 5, 10')
  const started = await video({ firstFrame: frame, lastFrame: frame, duration: 10, audio: false, requestId: 'fal-video-1' })
  expect(posts(fixture)[0].body).toEqual({ prompt: 'It turns', start_image_url: data, end_image_url: data, duration: '10', generate_audio: false })
  const done = started.status === 'succeeded' ? started : await call(service, 'generation_get', { id: started.id, waitSeconds: 25 })
  expect(done.status).toBe('succeeded')
  expect(await readFile(done.files[0].path)).toEqual(MP4)
  service.close()
}), 30_000)

test.concurrent('fal speech finds where its model keeps the words and the voice, and keeps a WAV', () => scratch(async ({ connected, call }) => {
  const fixture = providerFixture(), service = await connected('fal', fixture)
  const spoken = await call(service, 'generate_speech', { model: 'fal-ai/test-voice', text: 'Hello there', voice: 'Wise_Woman', requestId: 'fal-voice-1' })
  expect(spoken).toMatchObject({ status: 'succeeded', provider: 'fal', files: [{ mimeType: 'audio/wav' }] })
  expect(spoken.files[0].path.endsWith('.wav')).toBe(true)
  expect(await readFile(spoken.files[0].path)).toEqual(WAV)
  expect(posts(fixture)[0].body).toEqual({ prompt: 'Hello there', voice_setting: { voice_id: 'Wise_Woman' }, output_format: 'url' })
  service.close()
}), 30_000)

test.concurrent('a request fal finishes with an error fails, and an address outside fal\'s queue never gets the key', () => scratch(async ({ connected, call, png }) => {
  const fixture = providerFixture({
    'GET queue.fal.run/fal-ai/test-image/requests/fal-image-1/status': () => Response.json({ status: 'COMPLETED', error: 'Content policy violation', error_type: 'content_policy_violation' }),
    'GET queue.fal.run/fal-ai/test-voice/requests/fal-voice-1': () => Response.json({ detail: [{ msg: 'Text is too long', type: 'value_error' }] }, { status: 422 }),
    'POST queue.fal.run/fal-ai/nano-banana/edit': () => Response.json({ request_id: 'x-1', response_url: 'https://elsewhere.example/fal-ai/nano-banana/requests/x-1' })
  })
  const service = await connected('fal', fixture)
  const [policy, invalid, lost] = await Promise.all([
    call(service, 'generate_image', { model: 'fal-ai/test-image', prompt: 'A vessel', requestId: 'fal-fail-1' }),
    call(service, 'generate_speech', { model: 'fal-ai/test-voice', text: 'Hello', voice: 'Wise_Woman', requestId: 'fal-fail-2' }),
    png('source.png').then(reference => call(service, 'generate_image', { model: 'fal-ai/nano-banana/edit', prompt: 'Make it blue', references: [reference], requestId: 'fal-fail-3' }))
  ])
  expect(policy).toMatchObject({ status: 'failed', error: 'fal: Content policy violation' })
  expect(invalid).toMatchObject({ status: 'failed', error: 'fal 422: Text is too long' })
  expect(lost.status).toBe('interrupted')
  expect(lost.error).toContain('not sent again')
  expect(fixture.requests.some(request => request.url.includes('elsewhere.example'))).toBe(false)
  service.close()
}), 30_000)
