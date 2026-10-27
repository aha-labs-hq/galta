import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { notarize, notaryCredentials } from '../scripts/distribution/notarize.ts'

test('notarization requires an explicit profile and absolute keychain', () => {
  for (const env of [{}, { GALTA_NOTARY_PROFILE: 'release' }, { GALTA_NOTARY_PROFILE: 'release', GALTA_NOTARY_KEYCHAIN: 'login.keychain-db' }])
    expect(() => notaryCredentials(env)).toThrow('absolute GALTA_NOTARY_KEYCHAIN')
})

for (const outcome of ['Accepted', 'Invalid', 'timeout']) test(`notarization retains the submission and ${outcome} result without resubmitting`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galta-notary-test-'))
  const id = '12345678-1234-1234-1234-123456789abc'
  const calls = []
  const credentials = { profile: 'release', keychain: '/test/login.keychain-db' }
  const spawn = spyOn(Bun, 'spawn').mockImplementation(args => {
    calls.push(args)
    const submit = args[2] === 'submit'
    return {
      stdout: new Blob([JSON.stringify(submit ? { id } : { id, status: outcome === 'timeout' ? 'In Progress' : outcome })]).stream(),
      stderr: new Blob([!submit && outcome === 'timeout' ? 'Wait timed out' : '']).stream(),
      exited: Promise.resolve(!submit && outcome === 'timeout' ? 1 : 0),
    }
  })
  try {
    const result = notarize('/test/Galta.zip', credentials, directory)
    if (outcome === 'Accepted') expect(await result).toBe(id)
    else await expect(result).rejects.toThrow(outcome === 'timeout' ? 'Notarization result failed' : 'Invalid')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('--no-wait')
    expect(calls[1].slice(2, 6)).toEqual(['wait', id, '--timeout', '30m'])
    for (const args of calls) expect(args.slice(-6)).toEqual(['--keychain-profile', 'release', '--keychain', credentials.keychain, '--output-format', 'json'])
    const submission = JSON.parse(await readFile(join(directory, 'Galta.zip.submission.json'), 'utf8'))
    const wait = JSON.parse(await readFile(join(directory, 'Galta.zip.result.json'), 'utf8'))
    expect(JSON.parse(submission.stdout).id).toBe(id)
    expect(JSON.parse(wait.stdout).status).toBe(outcome === 'timeout' ? 'In Progress' : outcome)
    expect(wait.exitCode).toBe(outcome === 'timeout' ? 1 : 0)
  } finally {
    spawn.mockRestore()
    await rm(directory, { recursive: true, force: true })
  }
})
