/** A generation worker for tests: the real carry path over the provider
 * fixture, logging each paid request so a test can count them across processes. */
import { appendFileSync } from 'node:fs'
import { MediaGeneration } from '../../native/media/service'
import { providerFixture } from './media-fixture'

const { directory, job, prepared } = JSON.parse(await Bun.stdin.text())
const delay = Number(process.env.GALTA_TEST_DELAY ?? 0)
const fixture = providerFixture({ 'POST ark.ap-southeast.bytepluses.com/api/v3/images/generations': async () => {
  appendFileSync(process.env.GALTA_TEST_POSTS!, 'POST\n')
  await Bun.sleep(delay)
  return Response.json({ data: [{ url: 'https://cdn.example/image.png' }] })
} })
const generation = new MediaGeneration(directory, fixture.fetch)
try { await generation.carry(job, prepared) } finally { generation.close() }
