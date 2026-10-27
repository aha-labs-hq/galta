import type { MediaProviderId } from '../../../packages/canvas/src/capabilities/media'
import { BytePlus } from './byteplus'
import { Fal } from './fal'
import { Higgsfield } from './higgsfield'
import { OpenRouter } from './openrouter'
import type { MediaProvider } from './provider'

/** Names joined as alternatives: "BytePlus, fal, or Higgsfield". */
export const orList = (names: readonly string[]) => new Intl.ListFormat('en', { type: 'disjunction' }).format(names)

/** The adapter for every provider in MEDIA_PROVIDERS. */
export function mediaProviders(fetcher: typeof fetch = fetch): Record<MediaProviderId, MediaProvider> {
  return { byteplus: new BytePlus(fetcher), openrouter: new OpenRouter(fetcher), fal: new Fal(fetcher), higgsfield: new Higgsfield(fetcher) }
}
