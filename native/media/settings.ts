import { MEDIA_PROVIDERS, type MediaProviderId, type MediaSettingsResponse } from '../../packages/canvas/src/capabilities/media'
import { galtaPaths } from '../paths'
import { MediaKeys } from './keys'
import { mediaProviders, orList } from './providers'

const isProvider = (value: unknown): value is MediaProviderId => MEDIA_PROVIDERS.some(provider => provider.id === value)

/** Settings' only way in. It is not an agent tool, and no answer carries a key. */
export async function mediaSettings(request: unknown, directory = galtaPaths.mediaDirectory, fetcher: typeof fetch = fetch): Promise<MediaSettingsResponse> {
  const keys = new MediaKeys(directory)
  try {
    const { action, provider, key } = (request ?? {}) as { action?: unknown; provider?: unknown; key?: unknown }
    if (action === 'status') return { ok: true, providers: await keys.status() }
    if (!isProvider(provider)) throw new Error(`Choose ${orList(MEDIA_PROVIDERS.map(({ name }) => name))}.`)
    if (action === 'disconnect') return { ok: true, providers: await keys.disconnect(provider) }
    if (action === 'connect') return { ok: true, providers: await keys.connect(mediaProviders(fetcher)[provider], key) }
    throw new Error('Unsupported settings request.')
  } catch (error) {
    const providers = await keys.status().catch(() => undefined)
    return { ok: false, error: error instanceof Error ? error.message : 'Settings could not be saved.', ...(providers ? { providers } : {}) }
  }
}
