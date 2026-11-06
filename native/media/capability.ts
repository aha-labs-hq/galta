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
  const tools = async () => {
    const connected = new Set((await keys.status()).filter(state => state.connected).map(state => state.id))
    if (!connected.size) return []
    const kinds = new Set(MEDIA_PROVIDERS.filter(provider => connected.has(provider.id)).flatMap(provider => provider.kinds))
    return MEDIA_TOOLS.filter(tool => !MAKES[tool.name] || kinds.has(MAKES[tool.name]!))
  }
  return {
    tools,
    owns: isMediaTool,
    writesFiles: name => name in MAKES,
    call: (name, args, scope) => callMediaTool(service ??= new MediaGeneration(directory), name as Parameters<typeof callMediaTool>[1], args, scope),
    watch(changed) {
      let timer: ReturnType<typeof setTimeout> | undefined, watcher: FSWatcher
      let stopped = false
      // Match the server's unavailable-capability behavior on an unreadable file.
      const signature = async () => (await tools().catch(() => [])).map(tool => tool.name).join('\n')
      let current = signature()
      const refresh = () => {
        // Serialize reads so a slow read cannot announce an older tool list.
        current = current.then(async before => {
          if (stopped) return before
          const after = await signature()
          if (!stopped && after !== before) changed()
          return after
        })
      }
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        // Keys are replaced by rename, so watch the directory, not the file.
        // A coalesced event can name only the temporary file (or no file).
        // Treat every event as an invalidation; notify only when tools differ.
        // Watching never keeps the process alive after its host has gone.
        watcher = watch(directory, { persistent: false }, () => {
          clearTimeout(timer)
          timer = setTimeout(refresh, 100)
        })
      } catch { return () => {} }
      watcher.on('error', () => watcher.close())
      return () => { stopped = true; clearTimeout(timer); watcher.close() }
    }
  }
}
