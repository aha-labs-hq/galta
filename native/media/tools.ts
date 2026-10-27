import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { MEDIA_WAIT_SECONDS, parseMediaInput, type MediaToolName } from '../../packages/canvas/src/capabilities/media'
import { canonicalManagedArtifactReference } from '../../packages/canvas/src/artifactPaths'
import type { ToolContent, ToolResult } from '../../packages/canvas/src/index'
import type { Job } from './jobs'
import type { MediaGeneration } from './service'
import type { CallScope } from '../mcp/capability'

const PREVIEW_BYTES = 2 * 1024 * 1024

/** What an agent sees of a job: no request ids, fingerprints or owners. */
function view(job: Job) {
  return {
    id: job.id, kind: job.kind, status: job.status, provider: job.provider, model: job.model,
    ...(job.progress !== undefined ? { progress: job.progress } : {}),
    ...(job.error ? { error: job.error } : {}),
    files: job.files.map(file => {
      const artifactUri = canonicalManagedArtifactReference(file.path)
      return { path: file.path, mimeType: file.mimeType, ...(artifactUri.startsWith('galta-workspace:') ? { artifactUri } : {}) }
    }),
    createdAt: job.createdAt
  }
}

/** Results are files. Pictures cost image tokens, so a finished image comes
 * back as a picture only when the agent asks; looking at it placed on the
 * canvas is the cheaper default. Video and speech are always files. */
async function result(job: Job, preview = false): Promise<ToolResult> {
  const content: ToolContent[] = [{ type: 'text', text: JSON.stringify(view(job)) }]
  let budget = PREVIEW_BYTES
  for (const file of preview && job.status === 'succeeded' ? job.files : []) {
    if (!file.mimeType.startsWith('image/')) continue
    const size = await stat(file.path).then(info => info.size, () => Infinity)
    if (size > budget) continue
    content.push({ type: 'image', mimeType: file.mimeType, data: (await readFile(file.path)).toString('base64') })
    budget -= size
  }
  return { content, structuredContent: view(job) }
}

/** Files go to the bound execution's workspace, or without one to Galta's own
 * media folder. Waits stop when the caller cancels and never outlast what the
 * caller allows a call to block. */
export async function callMediaTool(generation: MediaGeneration, name: MediaToolName, args: unknown, { workspace, signal, maxWaitSeconds }: CallScope): Promise<ToolResult> {
  const directory = workspace ? join(workspace, 'outputs') : generation.files
  const patience = (seconds: number) => Math.min(seconds, maxWaitSeconds)
  switch (name) {
    case 'generation_models': {
      const models = await generation.models(parseMediaInput(name, args))
      return { content: [{ type: 'text', text: JSON.stringify(models) }], structuredContent: models }
    }
    case 'generate_image': return result(await generation.generate('image', parseMediaInput(name, args), directory, patience(MEDIA_WAIT_SECONDS), signal))
    case 'generate_video': return result(await generation.generate('video', parseMediaInput(name, args), directory, patience(MEDIA_WAIT_SECONDS), signal))
    case 'generate_speech': return result(await generation.generate('speech', parseMediaInput(name, args), directory, patience(MEDIA_WAIT_SECONDS), signal))
    case 'generation_get': {
      const { id, waitSeconds, preview } = parseMediaInput(name, args)
      return result(await generation.wait(id, patience(waitSeconds), undefined, signal), preview)
    }
    case 'generation_list': {
      const jobs = generation.list(parseMediaInput(name, args).limit).map(view)
      return { content: [{ type: 'text', text: JSON.stringify({ jobs }) }], structuredContent: { jobs } }
    }
  }
}
