import { test, expect } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { mediaCapability } from '../native/media/capability'
import { mediaSettings } from '../native/media/settings'
import { KEY, MP4, PNG, providerFixture } from './helpers/media-fixture'
import { scratch } from './helpers/media-scratch'

const posts = fixture => fixture.requests.filter(request => request.method === 'POST')
const sent = (fixture, path) => posts(fixture).filter(request => request.url === `https://api.higgsfield.ai/${path}`)

test('a Higgsfield key is checked on a request no account has, and Higgsfield offers images and video but no speech', () => scratch(async ({ media }) => {
  expect(await mediaSettings({ action: 'connect', provider: 'higgsfield', key: 'id:wrong' }, media, providerFixture().fetch)).toMatchObject({ ok: false, error: "Higgsfield didn't accept this key." })
  const fixture = providerFixture()
  expect(await mediaSettings({ action: 'connect', provider: 'higgsfield', key: KEY }, media, fixture.fetch)).toMatchObject({ ok: true })
  expect(fixture.requests).toEqual([{ url: 'https://api.higgsfield.ai/requests/00000000-0000-4000-8000-000000000000/status', method: 'GET', authorization: `Key ${KEY}`, body: undefined }])
  expect((await mediaCapability({ directory: media }).tools()).map(tool => tool.name)).toEqual(['generation_models', 'generate_image', 'generate_video', 'generation_get', 'generation_list'])
}))

test('Higgsfield lists the models its docs describe, with the controls each takes', () => scratch(async ({ connected, call }) => {
  const service = await connected('higgsfield', providerFixture())
  const { models } = await call(service, 'generation_models', { provider: 'higgsfield', kind: 'image', limit: 100 })
  const soul = models.find(model => model.id === 'higgsfield-ai/soul/v2/standard')
  expect(soul).toMatchObject({ name: 'Soul 2', controls: { ratio: ['9:16', '16:9', '4:3', '3:4', '1:1', '2:3', '3:2'], size: ['720p', '1080p'], count: [1, 4], seed: [1, 1000000] } })
  expect(soul.bestFor).toContain('Photoreal')
  expect(models.find(model => model.id === 'alibaba/qwen-image-3/edit').controls.references).toBe('required')
  const { models: videos } = await call(service, 'generation_models', { provider: 'higgsfield', kind: 'video', limit: 100 })
  expect(videos.find(model => model.id === 'bytedance/seedance-2.5/image-to-video').controls).toMatchObject({ firstFrame: 'required', lastFrame: true, duration: [4, 30], audio: true })
  expect(videos.find(model => model.id === 'bytedance/seedance-2.5/video-edit').controls.referenceVideo).toBe('required')
  service.close()
}))

// The tests below wait on Higgsfield's queue, so they run side by side.
test.concurrent('a Higgsfield image is checked before it is paid for and sent in the model\'s own fields', () => scratch(async ({ connected, call, png }) => {
  const fixture = providerFixture(), service = await connected('higgsfield', fixture)
  const image = args => call(service, 'generate_image', { provider: 'higgsfield', prompt: 'A vessel', ...args })
  await expect(image({ requestId: 'hf-request-1' })).rejects.toThrow('Higgsfield needs an exact model id')
  await expect(image({ model: 'higgsfield-ai/soul/v2/standard', count: 2, requestId: 'hf-request-2' })).rejects.toThrow('count must be one of 1, 4 for this model')
  await expect(image({ model: 'higgsfield-ai/soul/v2/standard', references: [await png('source.png')], requestId: 'hf-request-3' })).rejects.toThrow('does not take references')
  await expect(image({ model: 'bytedance/seedance-2.5/image-to-video', requestId: 'hf-request-4' })).rejects.toThrow('Unknown Higgsfield image model')
  expect(posts(fixture)).toHaveLength(0)
  const done = await image({ model: 'higgsfield-ai/soul/v2/standard', ratio: '3:2', size: '1080p', count: 4, requestId: 'hf-request-5' })
  expect(done).toMatchObject({ status: 'succeeded', provider: 'higgsfield', model: 'higgsfield-ai/soul/v2/standard' })
  expect(await readFile(done.files[0].path)).toEqual(PNG)
  expect(posts(fixture)).toEqual([{ url: 'https://api.higgsfield.ai/higgsfield-ai/soul/v2/standard', method: 'POST', authorization: `Key ${KEY}`, body: { prompt: 'A vessel', aspect_ratio: '3:2', resolution: '1080p', batch_size: 4 } }])
  expect(fixture.requests.find(request => request.url.startsWith('https://cdn.example/')).authorization).toBeNull()
  service.close()
}), 30_000)

test.concurrent('local references reach Higgsfield\'s storage only as the request is sent, never with the key, and a retry pays nothing more', () => scratch(async ({ connected, call, png }) => {
  const fixture = providerFixture(), service = await connected('higgsfield', fixture)
  let upload
  const store = fixture.routes['PUT upload.higgsfield.example/*']
  fixture.routes['PUT upload.higgsfield.example/*'] = request => { upload = request; return store(request) }
  const reference = await png('source.png')
  const args = { model: 'alibaba/qwen-image-3/edit', prompt: 'Make it blue', references: [reference, reference], requestId: 'hf-upload-1' }
  const done = await call(service, 'generate_image', args)
  expect(done.status).toBe('succeeded')
  expect(fixture.count('POST', '/files/generate-upload-url')).toBe(1)
  expect(sent(fixture, 'alibaba/qwen-image-3/edit')[0].body.image_urls).toEqual(['https://cdn.higgsfield.example/upload-1', 'https://cdn.higgsfield.example/upload-1'])
  expect(upload.headers.get('authorization')).toBeNull()
  expect(upload.headers.get('x-amz-tagging')).toBe('retention=temporary')
  expect(Buffer.from(upload.raw)).toEqual(PNG)
  expect((await call(service, 'generate_image', args)).id).toBe(done.id)
  expect(fixture.count('POST', '/files/generate-upload-url')).toBe(1)
  expect(sent(fixture, 'alibaba/qwen-image-3/edit')).toHaveLength(1)
  service.close()
}), 30_000)

test.concurrent('a reference Higgsfield cannot store fails the request before anything is paid for', () => scratch(async ({ connected, call, png }) => {
  const fixture = providerFixture({ 'POST api.higgsfield.ai/files/generate-upload-url': () => Response.json({ detail: 'Unsupported content type' }, { status: 400 }) })
  const service = await connected('higgsfield', fixture)
  const failed = await call(service, 'generate_image', { model: 'alibaba/qwen-image-3/edit', prompt: 'Make it blue', references: [await png('source.png')], requestId: 'hf-upload-2' })
  expect(failed.status).toBe('failed')
  expect(failed.error).toContain('nothing was sent')
  expect(failed.error).toContain('Unsupported content type')
  expect(sent(fixture, 'alibaba/qwen-image-3/edit')).toHaveLength(0)
  service.close()
}), 30_000)

test.concurrent('a Higgsfield video starts from its uploaded frame, and moderation ends a request without charge', () => scratch(async ({ connected, call, png }) => {
  const fixture = providerFixture(), service = await connected('higgsfield', fixture), frame = await png('frame.png')
  const video = args => call(service, 'generate_video', { model: 'bytedance/seedance-2.5/image-to-video', prompt: 'It turns', firstFrame: frame, ...args })
  await expect(video({ ratio: '16:9', requestId: 'hf-video-0' })).rejects.toThrow('does not take ratio')
  const started = await video({ duration: 8, audio: false, requestId: 'hf-video-1' })
  expect(sent(fixture, 'bytedance/seedance-2.5/image-to-video')[0].body).toEqual({ prompt: 'It turns', image_url: 'https://cdn.higgsfield.example/upload-1', duration: 8, generate_audio: false })
  const done = started.status === 'succeeded' ? started : await call(service, 'generation_get', { id: started.id, waitSeconds: 25 })
  expect(done.status).toBe('succeeded')
  expect(await readFile(done.files[0].path)).toEqual(MP4)

  fixture.routes['GET api.higgsfield.ai/requests/hf-video-0001/status'] = () => Response.json({ status: 'nsfw', request_id: 'hf-video-0001' })
  const moderated = await video({ duration: 5, requestId: 'hf-video-2' })
  const refused = moderated.status !== 'running' ? moderated : await call(service, 'generation_get', { id: moderated.id, waitSeconds: 25 })
  expect(refused).toMatchObject({ status: 'failed', error: 'Higgsfield moderation refused the request or its result; it was not charged' })
  service.close()
}), 40_000)
