import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { MediaGeneration } from '../native/media/service'
import { JobStore } from '../native/media/jobs'
import { callMediaTool } from '../native/media/tools'
import { parseMediaInput } from '../packages/canvas/src/capabilities/media'
import { KEY, MP4, PNG, providerFixture } from './helpers/media-fixture'

let root, workspace, media
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'galta-media-'))
  workspace = join(root, 'workspace'); media = join(root, 'media')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function generation(fixture, providers = ['byteplus']) {
  const service = new MediaGeneration(media, fixture.fetch)
  for (const provider of providers) await service.keys.connect(service.providers[provider], KEY)
  return service
}
const call = (service, name, args, ...bound) => callMediaTool(service, name, args, { workspace: bound.length ? bound[0] : workspace, signal: new AbortController().signal, maxWaitSeconds: 110 })
const job = result => result.structuredContent

test('an image is paid for once per requestId, lands in the workspace outputs, and is shown as a picture only on request', async () => {
  const fixture = providerFixture(), service = await generation(fixture)
  const first = await call(service, 'generate_image', { prompt: 'A glass vessel', ratio: '16:9', requestId: 'request-0001' })
  expect(first.isError).toBeUndefined()
  expect(job(first)).toMatchObject({ kind: 'image', status: 'succeeded', provider: 'byteplus', model: 'dola-seedream-5-0-pro-260628' })
  const [file] = job(first).files
  expect(file.path).toBe(join(workspace, 'outputs', `image-${job(first).id.slice(0, 8)}.png`))
  expect(await readFile(file.path)).toEqual(PNG)
  expect((await stat(file.path)).mode & 0o777).toBe(0o600)
  expect(first.content).toHaveLength(1)
  const previewed = await call(service, 'generation_get', { id: job(first).id, waitSeconds: 0, preview: true })
  expect(previewed.content[1]).toEqual({ type: 'image', mimeType: 'image/png', data: PNG.toString('base64') })
  const body = fixture.requests.find(request => request.method === 'POST').body
  expect(body).toMatchObject({ model: 'dola-seedream-5-0-pro-260628', size: '2K', watermark: false, response_format: 'url' })
  expect(body.prompt).toContain('16:9')

  const again = await call(service, 'generate_image', { prompt: 'A glass vessel', ratio: '16:9', requestId: 'request-0001' })
  expect(job(again).id).toBe(job(first).id)
  expect(fixture.count('POST', '/api/v3/images/generations')).toBe(1)
  await expect(call(service, 'generate_image', { prompt: 'Another vessel', requestId: 'request-0001' })).rejects.toThrow('different request')
  service.close()
})

test('a lost answer to a paid request is reported and never sent again', async () => {
  const fixture = providerFixture({ 'POST ark.ap-southeast.bytepluses.com/api/v3/images/generations': () => { throw new TypeError('socket hang up') } })
  const service = await generation(fixture)
  const result = job(await call(service, 'generate_image', { prompt: 'A vessel', requestId: 'request-0002' }))
  expect(result.status).toBe('interrupted')
  expect(result.error).toContain('not sent again')
  expect(job(await call(service, 'generation_get', { id: result.id, waitSeconds: 0 })).status).toBe('interrupted')
  expect(job(await call(service, 'generate_image', { prompt: 'A vessel', requestId: 'request-0002' })).status).toBe('interrupted')
  expect(fixture.count('POST', '/api/v3/images/generations')).toBe(1)
  service.close()
})

test('a refused request fails plainly and charges nothing', async () => {
  const fixture = providerFixture({ 'POST ark.ap-southeast.bytepluses.com/api/v3/images/generations': () => Response.json({ error: { message: 'The prompt was rejected' } }, { status: 400 }) })
  const service = await generation(fixture)
  const result = job(await call(service, 'generate_image', { prompt: 'A vessel', requestId: 'request-0003' }))
  expect(result).toMatchObject({ status: 'failed', error: 'BytePlus 400: The prompt was rejected', files: [] })
  service.close()
})

test('a video resumes from its task, and a failed download resumes without paying again', async () => {
  let polls = 0, downloads = 0
  const fixture = providerFixture({
    'GET ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks/task-1': () => ++polls < 2 ? Response.json({ status: 'running', progress: 40 }) : Response.json({ status: 'succeeded', content: { video_url: 'https://cdn.example/video.mp4' } }),
    'GET cdn.example/video.mp4': () => ++downloads < 2 ? new Response('busy', { status: 503 }) : new Response(MP4)
  })
  const service = await generation(fixture)
  const started = job(await call(service, 'generate_video', { prompt: 'The vessel turns', duration: 5, requestId: 'request-0004' }))
  expect(started.status).toBe('running')
  expect(fixture.requests.find(request => request.method === 'POST').body).toMatchObject({ model: 'dreamina-seedance-2-5-260628', ratio: '16:9', resolution: '720p', duration: 5, generate_audio: true, watermark: false })
  // Another Galta process sees the same job and finishes it.
  const other = new MediaGeneration(media, fixture.fetch)
  let finished = job(await call(other, 'generation_get', { id: started.id, waitSeconds: 25 }))
  if (finished.status === 'running') finished = job(await call(other, 'generation_get', { id: started.id, waitSeconds: 25 }))
  expect(finished.status).toBe('succeeded')
  expect(downloads).toBe(2)
  expect(await readFile(finished.files[0].path)).toEqual(MP4)
  expect(finished.files[0].path.endsWith('.mp4')).toBe(true)
  expect(fixture.count('POST', '/api/v3/contents/generations/tasks')).toBe(1)
  service.close(); other.close()
}, 30_000)

test('a download interrupted by a crash resumes over its partial file', async () => {
  const { saveMedia } = await import('../native/media/files')
  const outputs = join(workspace, 'outputs')
  await Bun.write(join(outputs, '.video-crashed.partial'), 'half a video')
  const saved = await saveMedia(outputs, 'video-crashed', 'video', MP4)
  expect(await readFile(saved.path)).toEqual(MP4)
  await expect(stat(join(outputs, '.video-crashed.partial'))).rejects.toThrow()
  // An output published before a crash is kept, never replaced.
  expect(await saveMedia(outputs, 'video-crashed', 'video', Buffer.concat([MP4, Buffer.from('other')]))).toEqual(saved)
  expect(await readFile(saved.path)).toEqual(MP4)
})

test('a submission left by a process that died is reported as interrupted, not resubmitted', async () => {
  const fixture = providerFixture(), service = await generation(fixture)
  const dead = Bun.spawnSync(['true']).pid
  const store = new JobStore(media), now = new Date().toISOString()
  const orphan = { id: crypto.randomUUID(), requestId: 'request-0005', fingerprint: 'x', kind: 'image', provider: 'byteplus', model: 'm', prompt: 'p', directory: workspace, status: 'running', files: [], createdAt: now, updatedAt: now }
  store.create(orphan, 4)
  store.close()
  // Hand the row to the dead process, as if it had crashed mid-submission.
  const { Database } = await import('bun:sqlite')
  const db = new Database(join(media, 'jobs.sqlite')); db.query('UPDATE jobs SET owner = ? WHERE id = ?').run(dead, orphan.id); db.close()
  const [listed] = job(await call(service, 'generation_list', {})).jobs
  expect(listed).toMatchObject({ id: orphan.id, status: 'interrupted' })
  expect(listed.error).toContain('not sent again')
  expect(fixture.requests.filter(request => request.method === 'POST')).toHaveLength(0)
  service.close()
})

test('nothing is fetched or offered for providers the user has not connected', async () => {
  const fixture = providerFixture(), service = new MediaGeneration(media, fixture.fetch)
  await expect(call(service, 'generate_image', { prompt: 'A vessel', requestId: 'request-0006' })).rejects.toThrow("Connect BytePlus, OpenRouter, fal, or Higgsfield under Generation in Galta's Settings to generate images")
  const none = job(await call(service, 'generation_models', {}))
  expect(none.providers.map(provider => provider.connected)).toEqual([false, false, false, false])
  expect(none.models).toEqual([])
  expect(fixture.requests).toHaveLength(0)
  await service.keys.connect(service.providers.byteplus, KEY)
  const videos = job(await call(service, 'generation_models', { kind: 'video', limit: 2 }))
  expect(videos.models.map(model => model.id)).toEqual(['dreamina-seedance-2-5-260628', 'dreamina-seedance-2-0-260128'])
  expect(videos.total).toBe(4)
  expect(videos.guide).toContain('Anchor first')
  expect(fixture.requests.filter(request => request.url.includes('openrouter.ai/api/v1/videos/models'))).toHaveLength(0)
  expect(job(await call(service, 'generation_models', {})).guide).toBeUndefined()
  service.close()
})

test('with no provider named, generation uses a connected one that makes the kind', async () => {
  const fixture = providerFixture(), service = await generation(fixture, ['openrouter'])
  await expect(call(service, 'generate_image', { prompt: 'A vessel', requestId: 'request-0022' })).rejects.toThrow('exact model id')
  const image = job(await call(service, 'generate_image', { model: 'vendor/image-model', prompt: 'A vessel', requestId: 'request-0023' }))
  expect(image).toMatchObject({ status: 'succeeded', provider: 'openrouter' })
  expect(fixture.requests.filter(request => request.url.includes('bytepluses.com'))).toHaveLength(0)
  service.close()
})

test('local references are read for the request, checked, and kept out of the job record', async () => {
  const fixture = providerFixture(), service = await generation(fixture)
  const reference = join(root, 'source.png'), text = join(root, 'notes.png')
  await writeFile(reference, PNG); await writeFile(text, 'not an image')
  const result = job(await call(service, 'generate_image', { prompt: 'Make it blue', references: [reference], requestId: 'request-0007' }))
  expect(result.status).toBe('succeeded')
  expect(fixture.requests.find(request => request.method === 'POST').body.image).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
  expect(await readFile(join(media, 'jobs.sqlite'), 'latin1')).not.toContain(PNG.toString('base64'))
  await expect(call(service, 'generate_image', { prompt: 'Make it blue', references: [text], requestId: 'request-0008' })).rejects.toThrow('PNG, JPEG or WebP')
  await expect(call(service, 'generate_image', { prompt: 'Make it blue', references: ['relative.png'], requestId: 'request-0009' })).rejects.toThrow('absolute file path')
  service.close()
})

test('BytePlus controls are checked before anything is paid for', async () => {
  const fixture = providerFixture(), service = await generation(fixture)
  await expect(call(service, 'generate_image', { prompt: 'A vessel', count: 2, requestId: 'request-0010' })).rejects.toThrow('does not support count')
  await expect(call(service, 'generate_image', { prompt: 'A vessel', size: '3K', requestId: 'request-0011' })).rejects.toThrow('size must be one of 1K, 2K')
  await expect(call(service, 'generate_video', { prompt: 'Turn', duration: 40, requestId: 'request-0012' })).rejects.toThrow('4–30 seconds')
  await expect(call(service, 'generate_video', { prompt: 'Edit', task: 'edit', requestId: 'request-0013' })).rejects.toThrow('referenceVideo and ratio adaptive')
  expect(fixture.requests.filter(request => request.method === 'POST')).toHaveLength(0)
  service.close()
})

test('OpenRouter needs an exact model, honours its catalogue, and sends its key only to its own content address', async () => {
  const fixture = providerFixture(), service = await generation(fixture, ['openrouter'])
  await expect(call(service, 'generate_image', { provider: 'openrouter', prompt: 'A vessel', requestId: 'request-0014' })).rejects.toThrow('exact model id')
  await expect(call(service, 'generate_image', { provider: 'openrouter', model: 'vendor/image-model', prompt: 'A vessel', quality: 'high', requestId: 'request-0015' })).rejects.toThrow('does not support quality')
  const reference = join(root, 'source.png'); await writeFile(reference, PNG)
  await expect(call(service, 'generate_image', { provider: 'openrouter', model: 'vendor/image-model', prompt: 'A vessel', references: [reference, reference], requestId: 'request-0021' })).rejects.toThrow('reference images must be between 0 and 1')
  const image = job(await call(service, 'generate_image', { provider: 'openrouter', model: 'vendor/image-model', prompt: 'A vessel', ratio: '16:9', size: '2K', references: [reference], requestId: 'request-0016' }))
  expect(image.status).toBe('succeeded')
  expect(fixture.requests.find(request => request.url.endsWith('/api/v1/images')).body).toEqual({ model: 'vendor/image-model', prompt: 'A vessel', aspect_ratio: '16:9', resolution: '2K', input_references: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } }] })
  const video = job(await call(service, 'generate_video', { provider: 'openrouter', model: 'vendor/video-model', prompt: 'Turn', duration: 5, requestId: 'request-0017' }))
  const done = video.status === 'succeeded' ? video : job(await call(service, 'generation_get', { id: video.id, waitSeconds: 25 }))
  expect(done.status).toBe('succeeded')
  expect(fixture.requests.find(request => request.url.startsWith('https://openrouter.ai/api/v1/videos/job-1/content')).authorization).toBe(`Bearer ${KEY}`)
  expect(fixture.requests.find(request => request.url.startsWith('https://storage.example/')).authorization).toBeNull()
  const speech = job(await call(service, 'generate_speech', { model: 'vendor/voice-model', text: 'Hello', voice: 'alloy', requestId: 'request-0018' }))
  expect(speech).toMatchObject({ status: 'succeeded', files: [{ mimeType: 'audio/mpeg' }] })
  await expect(call(service, 'generate_speech', { model: 'vendor/voice-model', text: 'Hello', voice: 'nova', requestId: 'request-0019' })).rejects.toThrow('voice must be one of alloy')
  service.close()
}, 30_000)

test('without a bound canvas, files go to Galta\'s own media folder', async () => {
  const fixture = providerFixture(), service = await generation(fixture)
  const result = job(await call(service, 'generate_image', { prompt: 'A vessel', requestId: 'request-0020' }, undefined))
  expect(result.files[0].path.startsWith(join(media, 'files'))).toBe(true)
  expect(result.files[0].artifactUri).toBeUndefined()
  service.close()
})

test('at most four generations run at once', async () => {
  const fixture = providerFixture({ 'GET ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks/task-1': () => Response.json({ status: 'running' }) })
  const service = await generation(fixture)
  for (let index = 0; index < 4; index++) expect(job(await call(service, 'generate_video', { prompt: `Turn ${index}`, requestId: `request-1${index}00` })).status).toBe('running')
  await expect(call(service, 'generate_video', { prompt: 'Turn 5', requestId: 'request-1500' })).rejects.toThrow('4 generations are already running')
  service.close()
})

test('the model list says what each model is best at, and nothing where no note is known', async () => {
  const fixture = providerFixture({ 'GET openrouter.ai/api/v1/images/models': () => Response.json({ data: [
    { id: 'openai/gpt-image-2', name: 'GPT Image 2', architecture: { output_modalities: ['image'] } },
    { id: 'recraft/recraft-v4-pro-vector', name: 'Recraft V4 Pro Vector', architecture: { output_modalities: ['image'] } },
    { id: 'vendor/image-model', name: 'Image Model', architecture: { output_modalities: ['image'] } }
  ] }) })
  const service = await generation(fixture, ['byteplus', 'openrouter'])
  const { models, guide } = job(await call(service, 'generation_models', { kind: 'image', limit: 100 }))
  expect(guide).toContain("Name each reference's role")
  const note = id => models.find(model => model.id === id)?.bestFor
  expect(note('dola-seedream-5-0-pro-260628')).toContain('compositions')
  expect(note('openai/gpt-image-2')).toContain('text')
  expect(note('recraft/recraft-v4-pro-vector')).toContain('SVG')
  expect(note('vendor/image-model')).toBeUndefined()
  service.close()
})

// A worker that only records its payload and stays until released, so a test can carry the job itself.
async function handedOff(kind, args) {
  const payload = join(root, `${kind}-payload.json`), fixture = providerFixture()
  const service = new MediaGeneration(media, fixture.fetch, { worker: ['/bin/sh', '-c', `cat > '${payload}.part' && mv '${payload}.part' '${payload}'; i=0; while [ ! -e '${payload}.done' ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done`] })
  await service.keys.connect(service.providers.byteplus, KEY)
  const job = await service.generate(kind, parseMediaInput(kind === 'image' ? 'generate_image' : 'generate_video', args), join(workspace, 'outputs'), 0)
  let handed
  for (let i = 0; i < 200 && !handed; i++) { await Bun.sleep(20); handed = await readFile(payload, 'utf8').then(JSON.parse, () => undefined) }
  return { service, fixture, job, prepared: handed.prepared, release: async () => { await writeFile(`${payload}.done`, ''); await service.idle() } }
}

test('a paid image is carried to its saved file even when the process that asked for it is killed', async () => {
  const posts = join(root, 'posts.log')
  // Its own process group, which is killed whole, as an agent host kills its MCP server.
  const asker = spawn(process.execPath, ['tests/helpers/media-asker.ts', media, join(workspace, 'outputs'), 'tests/helpers/media-worker.ts'],
    { detached: true, stdio: 'ignore', env: { ...process.env, GALTA_TEST_POSTS: posts, GALTA_TEST_DELAY: '1500' } })
  for (let i = 0; i < 200 && !(await stat(posts).catch(() => undefined)); i++) await Bun.sleep(25)
  process.kill(-asker.pid, 'SIGKILL')
  const store = new JobStore(media)
  let carried
  for (let i = 0; i < 200; i++) { carried = store.list(1)[0]?.job; if (carried?.status === 'succeeded') break; await Bun.sleep(25) }
  store.close()
  expect(carried).toMatchObject({ requestId: 'carried-0001', status: 'succeeded' })
  expect(await readFile(carried.files[0].path)).toEqual(PNG)
  expect((await readFile(posts, 'utf8')).trim().split('\n')).toHaveLength(1)
})

test('a worker carries a video through its task to saved files without anyone asking', async () => {
  const { service, fixture, job, prepared, release } = await handedOff('video', { prompt: 'A slow orbit', requestId: 'carried-video-1' })
  expect(job.status).toBe('running')
  await service.carry(job.id, prepared)
  const done = await service.wait(job.id, 0)
  expect(done.status).toBe('succeeded')
  expect(await readFile(done.files[0].path)).toEqual(MP4)
  expect(fixture.count('POST', '/api/v3/contents/generations/tasks')).toBe(1)
  await release(); service.close()
})

test('a worker sends nothing for a payload that does not match the job, or a job someone else settled', async () => {
  const { service, fixture, job, prepared, release } = await handedOff('image', { prompt: 'A vessel', requestId: 'carried-0002' })
  await service.carry(job.id, { ...prepared, body: { ...prepared.body, prompt: 'Something else' } })
  expect(fixture.count('POST', '/api/v3/images/generations')).toBe(0)
  const store = new JobStore(media), row = store.get(job.id)
  store.claim(row); row.job.status = 'interrupted'; store.save(row.job); store.release(job.id); store.close()
  await service.carry(job.id, prepared)
  expect(fixture.count('POST', '/api/v3/images/generations')).toBe(0)
  expect((await service.wait(job.id, 0)).status).toBe('interrupted')
  await release(); service.close()
})

test('a request whose worker never started, or ended before claiming it, was never sent and is carried here', async () => {
  for (const [worker, requestId] of [[['/nonexistent/galta-worker'], 'never-started'], [['/bin/sh', '-c', 'exit 0'], 'ended-early']]) {
    const fixture = providerFixture(), service = new MediaGeneration(media, fixture.fetch, { worker })
    await service.keys.connect(service.providers.byteplus, KEY)
    const done = await service.generate('image', parseMediaInput('generate_image', { prompt: 'A vessel', requestId }), join(workspace, 'outputs'), 10)
    expect(done.status).toBe('succeeded')
    expect(fixture.count('POST', '/api/v3/images/generations')).toBe(1)
    await service.idle(); service.close()
  }
})

test('the real worker entry leaves a job someone else settled untouched', async () => {
  const { service, job, prepared, release } = await handedOff('image', { prompt: 'A vessel', requestId: 'carried-0003' })
  const store = new JobStore(media), row = store.get(job.id)
  store.claim(row); row.job.status = 'interrupted'; store.save(row.job); store.release(job.id); store.close()
  const worker = Bun.spawn([process.execPath, 'native/mcp/main.ts'], { stdin: new TextEncoder().encode(JSON.stringify({ directory: media, job: job.id, prepared })), stdout: 'ignore', stderr: 'pipe', env: { ...process.env, GALTA_MEDIA_WORKER: '1' } })
  expect(await worker.exited).toBe(0)
  expect((await service.wait(job.id, 0)).status).toBe('interrupted')
  await release(); service.close()
})

test('a wait ends when its call is cancelled, and never outlasts what the caller allows', async () => {
  const { service, job, release } = await handedOff('video', { prompt: 'A slow orbit', requestId: 'carried-video-2' })
  const cancelled = new AbortController(), started = Date.now()
  setTimeout(() => cancelled.abort(), 200)
  await callMediaTool(service, 'generation_get', { id: job.id, waitSeconds: 100 }, { workspace, signal: cancelled.signal, maxWaitSeconds: 110 })
  expect(Date.now() - started).toBeLessThan(1500)
  const bounded = Date.now()
  await callMediaTool(service, 'generation_get', { id: job.id, waitSeconds: 100 }, { workspace, signal: new AbortController().signal, maxWaitSeconds: 1 })
  expect(Date.now() - bounded).toBeLessThan(2500)
  await release(); service.close()
})
