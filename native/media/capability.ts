import { mkdirSync, watch, type FSWatcher } from 'node:fs'
import { MEDIA_PROVIDERS, MEDIA_TOOLS, isMediaTool, type MediaKind } from '../../packages/canvas/src/capabilities/media'
import type { Capability } from '../mcp/capability'
import { MediaKeys } from './keys'
import { MediaGeneration } from './service'
import { callMediaTool } from './tools'

const MAKES: Record<string, MediaKind> = { generate_image: 'image', generate_video: 'video', generate_speech: 'speech' }

/** Media generation as a capability: listed only for what the connected
 * providers can make. With nothing connected it has no tools at all. */
export function mediaCapability({ directory, generation }: { directory: string; generation?: MediaGeneration }): Capability {
  const keys = new MediaKeys(directory)
  let service = generation
  return {
    async tools() {
      const connected = new Set((await keys.status()).filter(state => state.connected).map(state => state.id))
      if (!connected.size) return []
      const kinds = new Set(MEDIA_PROVIDERS.filter(provider => connected.has(provider.id)).flatMap(provider => provider.kinds))
      return MEDIA_TOOLS.filter(tool => !MAKES[tool.name] || kinds.has(MAKES[tool.name]!))
    },
    owns: isMediaTool,
    writesFiles: name => name in MAKES,
    call: (name, args, scope) => callMediaTool(service ??= new MediaGeneration(directory), name as Parameters<typeof callMediaTool>[1], args, scope),
    watch(changed) {
      let timer: ReturnType<typeof setTimeout> | undefined, watcher: FSWatcher
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        // Keys are replaced by rename, so watch the directory, not the file.
        // Watching never keeps the process alive after its host has gone.
        watcher = watch(directory, { persistent: false }, (_event, file) => {
          if (file !== 'keys.json') return
          clearTimeout(timer)
          timer = setTimeout(changed, 100)
        })
      } catch { return () => {} }
      watcher.on('error', () => watcher.close())
      return () => { clearTimeout(timer); watcher.close() }
    }
  }
}
