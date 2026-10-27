/** A throwaway Galta media setup per test, so tests that wait on a provider's
 * queue can run side by side without sharing jobs or files. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MediaGeneration } from '../../native/media/service'
import { callMediaTool } from '../../native/media/tools'
import type { MediaProviderId } from '../../packages/canvas/src/capabilities/media'
import { KEY, PNG, providerFixture } from './media-fixture'

export async function scratch<T>(run: (space: {
  root: string; media: string
  connected(provider: MediaProviderId, fixture: ReturnType<typeof providerFixture>): Promise<MediaGeneration>
  call(service: MediaGeneration, name: Parameters<typeof callMediaTool>[1], args: unknown): Promise<any>
  png(name: string): Promise<string>
}) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'galta-media-'))
  const media = join(root, 'media'), workspace = join(root, 'workspace')
  try {
    return await run({
      root, media,
      async connected(provider, fixture) {
        const service = new MediaGeneration(media, fixture.fetch)
        await service.keys.connect(service.providers[provider], KEY)
        return service
      },
      call: async (service, name, args) => (await callMediaTool(service, name, args, { workspace, signal: new AbortController().signal, maxWaitSeconds: 110 })).structuredContent,
      async png(name) { const path = join(root, name); await writeFile(path, PNG); return path }
    })
  } finally { await rm(root, { recursive: true, force: true }) }
}
