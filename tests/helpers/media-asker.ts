/** An agent's MCP process asking for an image through a detached worker;
 * a test kills it mid-request, as an agent host does when it closes. */
import { MediaGeneration } from '../../native/media/service'
import { parseMediaInput } from '../../packages/canvas/src/capabilities/media'
import { KEY, providerFixture } from './media-fixture'

const [media, outputs, worker] = Bun.argv.slice(2)
const fixture = providerFixture()
const service = new MediaGeneration(media!, fixture.fetch, { worker: [process.execPath, worker!] })
await service.keys.connect(service.providers.byteplus, KEY)
await service.generate('image', parseMediaInput('generate_image', { prompt: 'A glass vessel', requestId: 'carried-0001' }), outputs!, 60)
