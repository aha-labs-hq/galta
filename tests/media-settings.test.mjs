import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mediaSettings } from '../native/media/settings'
import { KEY, providerFixture } from './helpers/media-fixture'

let directory
beforeEach(async () => { directory = join(await mkdtemp(join(tmpdir(), 'galta-media-settings-')), 'media') })
afterEach(async () => { await rm(join(directory, '..'), { recursive: true, force: true }) })
const settings = (request, fetcher = providerFixture().fetch) => mediaSettings(request, directory, fetcher)

test('a key is stored only after the provider accepts it, privately, and is never returned', async () => {
  expect(await settings({ action: 'status' })).toEqual({ ok: true, providers: [{ id: 'byteplus', connected: false }, { id: 'openrouter', connected: false }, { id: 'fal', connected: false }, { id: 'higgsfield', connected: false }] })
  const refused = await settings({ action: 'connect', provider: 'byteplus', key: 'wrong-key' })
  expect(refused).toMatchObject({ ok: false, error: "BytePlus didn't accept this key." })
  await expect(stat(join(directory, 'keys.json'))).rejects.toThrow()

  const fixture = providerFixture()
  const connected = await settings({ action: 'connect', provider: 'openrouter', key: `  ${KEY}\n` }, fixture.fetch)
  expect(connected).toEqual({ ok: true, providers: [{ id: 'byteplus', connected: false }, { id: 'openrouter', connected: true }, { id: 'fal', connected: false }, { id: 'higgsfield', connected: false }] })
  expect(fixture.requests).toEqual([{ url: 'https://openrouter.ai/api/v1/key', method: 'GET', authorization: `Bearer ${KEY}`, body: undefined }])
  expect(JSON.stringify(connected)).not.toContain(KEY)
  expect(JSON.stringify(await settings({ action: 'status' }))).not.toContain(KEY)
  expect((await stat(join(directory, 'keys.json'))).mode & 0o777).toBe(0o600)
  expect((await stat(directory)).mode & 0o777).toBe(0o700)
  expect(JSON.parse(await readFile(join(directory, 'keys.json'), 'utf8')).openrouter.key).toBe(KEY)

  expect(await settings({ action: 'disconnect', provider: 'openrouter' })).toEqual({ ok: true, providers: [{ id: 'byteplus', connected: false }, { id: 'openrouter', connected: false }, { id: 'fal', connected: false }, { id: 'higgsfield', connected: false }] })
  expect(await readFile(join(directory, 'keys.json'), 'utf8')).not.toContain(KEY)
})

test('connection problems, malformed keys and unknown requests are explained without storing anything', async () => {
  const offline = (async () => { throw new TypeError('network down') })
  expect(await settings({ action: 'connect', provider: 'byteplus', key: KEY }, offline)).toMatchObject({ ok: false, error: "Couldn't reach BytePlus. Check your connection and try again." })
  const unavailable = (async () => new Response('', { status: 503 }))
  expect(await settings({ action: 'connect', provider: 'byteplus', key: KEY }, unavailable)).toMatchObject({ ok: false, error: 'BytePlus is unavailable right now (503). Try again.' })
  expect(await settings({ action: 'connect', provider: 'byteplus', key: 'two words' })).toMatchObject({ ok: false, error: 'Paste the API key exactly as the provider shows it.' })
  expect(await settings({ action: 'connect', provider: 'elsewhere', key: KEY })).toMatchObject({ ok: false, error: 'Choose BytePlus, OpenRouter, fal, or Higgsfield.' })
  expect(await settings({ action: 'export' })).toMatchObject({ ok: false })
  expect((await settings({ action: 'status' })).providers.every(provider => !provider.connected)).toBe(true)
})
