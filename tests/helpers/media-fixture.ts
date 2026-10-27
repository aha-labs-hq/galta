/** Provider fixtures for generation tests: no network, no charges. Each
 * route can be replaced per test; every request is recorded. */
export const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('fixture image')])
export const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisomfixture video')])
export const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.from('fixture speech')])
export const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVEfmt fixture speech')])
export const KEY = 'valid-provider-key'

const json = (schema: Record<string, unknown>) => ({ content: { 'application/json': { schema } } })
const text = { type: 'string' }, image = { properties: { images: { type: 'array' } } }
/** fal endpoints as its catalogue publishes them: a category, an OpenAPI input, and a result. */
export const FAL_ENDPOINTS: Record<string, { name: string; category: string; input: Record<string, unknown>; output: Record<string, unknown>; definitions?: Record<string, unknown>; path?: string; status?: string }> = {
  'fal-ai/test-image': { name: 'Test Image', category: 'text-to-image', output: image,
    input: { type: 'object', required: ['prompt'], properties: { prompt: text, image_size: { anyOf: [{ $ref: '#/components/schemas/ImageSize' }, { type: 'string', enum: ['square_hd', 'square', 'portrait_4_3', 'portrait_16_9', 'landscape_4_3', 'landscape_16_9'] }] }, num_images: { type: 'integer', minimum: 1, maximum: 4 }, seed: { anyOf: [{ type: 'integer' }, { type: 'null' }] }, output_format: { type: 'string', enum: ['jpeg', 'png'] } } },
    definitions: { ImageSize: { type: 'object', properties: { width: { type: 'integer' }, height: { type: 'integer' } } } } },
  'fal-ai/nano-banana/edit': { name: 'Nano Banana Edit', category: 'image-to-image', output: image,
    input: { type: 'object', required: ['prompt', 'image_urls'], properties: { prompt: text, image_urls: { type: 'array', items: text, maxItems: 2 }, aspect_ratio: { anyOf: [{ type: 'string', enum: ['auto', '1:1', '16:9'] }, { type: 'null' }] }, resolution: { type: 'string', enum: ['1K', '2K'] } } } },
  'fal-ai/old-image': { name: 'Old Image', category: 'text-to-image', status: 'deprecated', output: image, input: { properties: { prompt: text } } },
  'fal-ai/test-video/image-to-video': { name: 'Test Video', category: 'image-to-video', output: { properties: { video: { type: 'object' } } },
    input: { type: 'object', required: ['start_image_url'], properties: { prompt: { anyOf: [text, { type: 'null' }] }, start_image_url: text, end_image_url: { anyOf: [text, { type: 'null' }] }, duration: { type: 'string', enum: ['5', '10'] }, generate_audio: { type: 'boolean' }, aspect_ratio: { type: 'string', enum: ['16:9', '9:16'] } } } },
  'fal-ai/test-voice': { name: 'Test Voice', category: 'text-to-speech', output: { properties: { audio: { type: 'object' } } },
    input: { type: 'object', required: ['prompt'], properties: { prompt: text, voice_setting: { $ref: '#/components/schemas/VoiceSetting' }, output_format: { type: 'string', enum: ['url', 'hex'], default: 'hex' } } },
    definitions: { VoiceSetting: { type: 'object', properties: { voice_id: text, speed: { type: 'number' } } } } }
}

function falCatalogue(url: URL) {
  const ids = url.searchParams.getAll('endpoint_id')
  if (ids.length) {
    if (ids.some(id => !FAL_ENDPOINTS[id])) return Response.json({ error: { type: 'not_found', message: 'Endpoint(s) not found' } }, { status: 404 })
    return Response.json({ models: ids.map(id => {
      const { name, category, input, output, definitions, path = id } = FAL_ENDPOINTS[id]!
      return { endpoint_id: id, metadata: { display_name: name, category, status: 'active' }, openapi: {
        paths: { [`/${path}`]: { post: { requestBody: json({ $ref: '#/components/schemas/Input' }) } }, [`/${path}/requests/{request_id}`]: { get: { responses: { 200: json({ $ref: '#/components/schemas/Output' }) } } } },
        components: { schemas: { Input: input, Output: output, ...definitions } }
      } }
    }) })
  }
  const category = url.searchParams.get('category')
  return Response.json({ has_more: false, models: Object.entries(FAL_ENDPOINTS).filter(([, model]) => model.category === category)
    .map(([id, { name, category, status = 'active' }]) => ({ endpoint_id: id, metadata: { display_name: name, category, status } })) })
}
/** fal's queue answers with addresses keyed on owner/alias, without the endpoint's sub-path. */
const falQueued = (app: string, id: string) => Response.json({ request_id: id, status: 'IN_QUEUE', response_url: `https://queue.fal.run/${app}/requests/${id}`, status_url: `https://queue.fal.run/${app}/requests/${id}/status` })
const higgsfieldQueued = (id: string) => Response.json({ status: 'queued', request_id: id, status_url: `https://api.higgsfield.ai/requests/${id}/status` })

type Route = (request: { url: URL; method: string; headers: Headers; body: any; raw: RequestInit['body'] }) => Response | Promise<Response>
export type Recorded = { url: string; method: string; authorization: string | null; body: any }

export function providerFixture(overrides: Record<string, Route> = {}) {
  const requests: Recorded[] = []
  const authorized = (headers: Headers, scheme = 'Bearer') => headers.get('authorization') === `${scheme} ${KEY}`
  let uploads = 0
  const routes: Record<string, Route> = {
    'GET ark.ap-southeast.bytepluses.com/api/v3/models': ({ headers }) => authorized(headers) ? Response.json({ data: [] }) : Response.json({ error: { message: 'bad key' } }, { status: 401 }),
    'POST ark.ap-southeast.bytepluses.com/api/v3/images/generations': () => Response.json({ data: [{ url: 'https://cdn.example/image.png' }] }),
    'POST ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks': () => Response.json({ id: 'task-1' }),
    'GET ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks/task-1': () => Response.json({ status: 'succeeded', content: { video_url: 'https://cdn.example/video.mp4' } }),
    'GET cdn.example/image.png': () => new Response(PNG),
    'GET cdn.example/video.mp4': () => new Response(MP4),
    'GET openrouter.ai/api/v1/key': ({ headers }) => authorized(headers) ? Response.json({ data: {} }) : Response.json({ error: { message: 'bad key' } }, { status: 401 }),
    'GET openrouter.ai/api/v1/images/models': () => Response.json({ data: [{ id: 'vendor/image-model', name: 'Image Model', architecture: { output_modalities: ['image'] }, supported_parameters: { aspect_ratio: { type: 'enum', values: ['1:1', '16:9'] }, resolution: { type: 'enum', values: ['1K', '2K'] }, n: { type: 'range', min: 1, max: 2 }, input_references: { type: 'range', min: 0, max: 1 } } }] }),
    'GET openrouter.ai/api/v1/videos/models': () => Response.json({ data: [{ id: 'vendor/video-model', name: 'Video Model', supported_durations: [5, 10] }] }),
    'GET openrouter.ai/api/v1/models': () => Response.json({ data: [{ id: 'vendor/voice-model', name: 'Voice Model', architecture: { output_modalities: ['speech'] }, supported_voices: ['alloy'] }] }),
    'POST openrouter.ai/api/v1/images': () => Response.json({ data: [{ b64_json: PNG.toString('base64'), media_type: 'image/png' }] }),
    'POST openrouter.ai/api/v1/videos': () => Response.json({ id: 'job-1', status: 'pending' }, { status: 202 }),
    'GET openrouter.ai/api/v1/videos/job-1': () => Response.json({ id: 'job-1', status: 'completed', unsigned_urls: ['https://openrouter.ai/api/v1/videos/job-1/content?index=0'] }),
    'GET openrouter.ai/api/v1/videos/job-1/content': () => new Response(null, { status: 302, headers: { location: 'https://storage.example/job-1.mp4' } }),
    'GET storage.example/job-1.mp4': () => new Response(MP4),
    'POST openrouter.ai/api/v1/audio/speech': () => new Response(MP3, { headers: { 'content-type': 'audio/mpeg' } }),
    'GET api.fal.ai/v1/models/pricing': ({ headers }) => authorized(headers, 'Key') ? Response.json({ prices: [] }) : Response.json({ error: { type: 'authorization_error', message: 'Invalid API key' } }, { status: 401 }),
    'GET api.fal.ai/v1/models': ({ url }) => falCatalogue(url),
    'POST queue.fal.run/fal-ai/test-image': () => falQueued('fal-ai/test-image', 'fal-image-1'),
    'GET queue.fal.run/fal-ai/test-image/requests/fal-image-1/status': () => Response.json({ status: 'COMPLETED' }),
    'GET queue.fal.run/fal-ai/test-image/requests/fal-image-1': () => Response.json({ images: [{ url: 'https://v3b.fal.media/files/image.png' }], seed: 7 }),
    'POST queue.fal.run/fal-ai/nano-banana/edit': () => falQueued('fal-ai/nano-banana', 'fal-edit-1'),
    'GET queue.fal.run/fal-ai/nano-banana/requests/fal-edit-1/status': () => Response.json({ status: 'COMPLETED' }),
    'GET queue.fal.run/fal-ai/nano-banana/requests/fal-edit-1': () => Response.json({ images: [{ url: 'https://v3b.fal.media/files/image.png' }] }),
    'GET v3b.fal.media/files/image.png': () => new Response(PNG),
    'POST queue.fal.run/fal-ai/test-video/image-to-video': () => falQueued('fal-ai/test-video', 'fal-video-1'),
    'GET queue.fal.run/fal-ai/test-video/requests/fal-video-1/status': () => Response.json({ status: 'COMPLETED' }),
    'GET queue.fal.run/fal-ai/test-video/requests/fal-video-1': () => Response.json({ video: { url: 'https://v3b.fal.media/files/video.mp4' } }),
    'GET v3b.fal.media/files/video.mp4': () => new Response(MP4),
    'POST queue.fal.run/fal-ai/test-voice': () => falQueued('fal-ai/test-voice', 'fal-voice-1'),
    'GET queue.fal.run/fal-ai/test-voice/requests/fal-voice-1/status': () => Response.json({ status: 'COMPLETED' }),
    'GET queue.fal.run/fal-ai/test-voice/requests/fal-voice-1': () => Response.json({ audio: { url: 'https://v3b.fal.media/files/voice.wav' } }),
    'GET v3b.fal.media/files/voice.wav': () => new Response(WAV),
    'GET api.higgsfield.ai/requests/00000000-0000-4000-8000-000000000000/status': ({ headers }) => authorized(headers, 'Key') ? Response.json({ detail: 'Request not found' }, { status: 404 }) : Response.json({ detail: 'Invalid credentials' }, { status: 401 }),
    'POST api.higgsfield.ai/files/generate-upload-url': ({ body }) => {
      uploads++
      return Response.json({ public_url: `https://cdn.higgsfield.example/upload-${uploads}`, upload_url: `https://upload.higgsfield.example/upload-${uploads}`, upload_headers: { 'Content-Type': body.content_type, 'x-amz-tagging': 'retention=temporary' } })
    },
    'PUT upload.higgsfield.example/*': () => new Response(null, { status: 200 }),
    'POST api.higgsfield.ai/higgsfield-ai/soul/v2/standard': () => higgsfieldQueued('hf-image-0001'),
    'POST api.higgsfield.ai/alibaba/qwen-image-3/edit': () => higgsfieldQueued('hf-image-0001'),
    'GET api.higgsfield.ai/requests/hf-image-0001/status': () => Response.json({ status: 'completed', request_id: 'hf-image-0001', images: [{ url: 'https://cdn.example/image.png' }] }),
    'POST api.higgsfield.ai/bytedance/seedance-2.5/image-to-video': () => higgsfieldQueued('hf-video-0001'),
    'GET api.higgsfield.ai/requests/hf-video-0001/status': () => Response.json({ status: 'completed', request_id: 'hf-video-0001', video: { url: 'https://cdn.example/video.mp4' } }),
    ...overrides
  }
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const method = init.method ?? 'GET', headers = new Headers(init.headers)
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    requests.push({ url: url.href, method, authorization: headers.get('authorization'), body })
    const route = routes[`${method} ${url.host}${url.pathname}`] ?? routes[`${method} ${url.host}/*`]
    if (!route) return new Response('not found', { status: 404 })
    return route({ url, method, headers, body, raw: init.body })
  }) as typeof fetch
  const count = (method: string, path: string) => requests.filter(request => request.method === method && new URL(request.url).pathname === path).length
  return { fetch: fetcher, requests, routes, count }
}
