import { test, expect } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webAccount } from '../scripts/web/account.ts'

test('local web sign-in uses the shared account lifecycle, persists privately and returns no session token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galta-account-test-')), original = globalThis.fetch
  let changes = 0
  try {
    globalThis.fetch = async url => {
      const path = new URL(url).pathname
      if (path.endsWith('/sign-in/email-otp')) return Response.json({ user: { id: 'u1', email: 'fixture@example.test', name: '' } }, { headers: { 'set-auth-token': 'private.session' } })
      if (path.endsWith('/sign-out')) return Response.json({ success: true })
      throw new Error('Unexpected network call')
    }
    const service = webAccount(directory, () => changes++)
    expect(await service.handleAccount({ action: 'status' })).toMatchObject({ ok: true, state: { user: null } })
    const result = await service.handleAccount({ action: 'verify-code', email: 'fixture@example.test', code: '123456' })
    expect(result).toMatchObject({ ok: true, state: { user: { id: 'u1' } } })
    expect(JSON.stringify(result)).not.toContain('private.session')
    const file = join(directory, 'account.json')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(file, 'utf8')).token).toBe('private.session')
    const reloaded = webAccount(directory, () => changes++)
    expect(await reloaded.handleAccount({ action: 'status' })).toMatchObject({ ok: true, state: { user: { id: 'u1' } } })
    await reloaded.handleAccount({ action: 'sign-out' })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({})
    expect(changes).toBe(2)
  } finally { globalThis.fetch = original; await rm(directory, { recursive: true, force: true }) }
})
