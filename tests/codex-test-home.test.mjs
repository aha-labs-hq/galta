import { test, expect } from 'bun:test'
import { chmod, lstat, mkdir, mkdtemp, readFile, writeFile, stat, rm, symlink, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexTestEnvironment, codexTestHome, copyCodexTestAssets } from '../scripts/lib/codex-test-home'

test('inherited probe assets isolate plugin replacement and linked file mutations', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'galta-assets-fixture-'))
  const source = join(fixture, 'user'), home = join(fixture, 'probe'), shared = join(fixture, 'shared')
  try {
    await mkdir(join(source, 'plugins', 'cache'), { recursive: true }); await mkdir(home); await mkdir(shared)
    await writeFile(join(source, 'AGENTS.md'), 'user rules')
    await writeFile(join(source, 'plugins', 'cache', 'engine'), 'original engine')
    await utimes(join(source, 'plugins', 'cache', 'engine'), 1700000000, 1700000000)
    await writeFile(join(shared, 'skill'), 'original skill', { mode: 0o600 })
    await symlink(shared, join(source, 'skills'))
    await symlink(join(shared, 'skill'), join(source, 'plugins', 'linked-skill'))
    await copyCodexTestAssets(source, home)
    expect((await lstat(join(home, 'plugins'))).isSymbolicLink()).toBe(false)
    expect((await lstat(join(home, 'skills'))).isSymbolicLink()).toBe(false)
    expect((await lstat(join(home, 'plugins', 'linked-skill'))).isSymbolicLink()).toBe(false)
    expect((await stat(join(home, 'plugins', 'cache', 'engine'))).mtimeMs).toBe(1700000000000)
    await rm(join(home, 'plugins', 'cache'), { recursive: true })
    await writeFile(join(home, 'plugins', 'linked-skill'), 'probe mutation')
    await chmod(join(home, 'skills', 'skill'), 0o700)
    expect(await readFile(join(source, 'plugins', 'cache', 'engine'), 'utf8')).toBe('original engine')
    expect(await readFile(join(shared, 'skill'), 'utf8')).toBe('original skill')
    expect((await stat(join(shared, 'skill'))).mode & 0o777).toBe(0o600)
    expect(await readFile(join(home, 'AGENTS.md'), 'utf8')).toBe('user rules')
    await expect(lstat(join(home, 'rules'))).rejects.toThrow()
  } finally { await rm(fixture, { recursive: true, force: true }) }
})

test('inherited probe assets report broken links instead of silently skipping them', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'galta-assets-failure-'))
  try {
    const source = join(fixture, 'user'), home = join(fixture, 'probe')
    await mkdir(source); await mkdir(home)
    await symlink(join(fixture, 'missing'), join(source, 'plugins'))
    await expect(copyCodexTestAssets(source, home)).rejects.toThrow()
  } finally { await rm(fixture, { recursive: true, force: true }) }
})

test('native verification removes parent desktop connections while retaining provider credentials', () => {
  const inherited = { CODEX_APP_TOOLS_PIPE_PATH: '/parent/socket', CODEX_THREAD_ID: 'parent-thread', CODEX_HOME: '/parent/home', OPENAI_API_KEY: 'fixture-provider-key', PATH: '/bin' }
  const environment = { ...inherited, ...codexTestEnvironment('/test/codex', '/test') }
  expect(environment.CODEX_APP_TOOLS_PIPE_PATH).toBeUndefined()
  expect(environment.CODEX_THREAD_ID).toBeUndefined()
  expect(environment.CODEX_HOME).toBe('/test/codex')
  expect(environment.OPENAI_API_KEY).toBe('fixture-provider-key')
  expect(environment.PATH).toBe('/bin')
})

test('native verification isolates history and storage settings and removes copied credentials', async () => {
  const source = await mkdtemp(join(tmpdir(), 'galta-isolation-fixture-'))
  let isolated
  try {
    await writeFile(join(source, 'config.toml'), 'model="fixture"\nmodel_provider="custom"\nsqlite_home="/must-not-use"\n[model_providers.custom]\nname="Quoted \\"provider\\""\nbase_url="http://127.0.0.1:1234/v1"\nhttp_headers={"X-Test"="test"}\n[mcp_servers.private]\ncommand="never"\n')
    await writeFile(join(source, 'auth.json'), '{"fixture":"not-a-real-credential"}')
    await writeFile(join(source, 'state_5.sqlite'), 'not a real database')
    isolated = await codexTestHome(source)
    const config = Bun.TOML.parse(await readFile(join(isolated.home, 'config.toml'), 'utf8'))
    expect(config).toMatchObject({ model: 'fixture', model_provider: 'custom', model_providers: { custom: { name: 'Quoted "provider"', http_headers: { 'X-Test': 'test' } } }, cli_auth_credentials_store: 'file' })
    expect(config.sqlite_home).toBeUndefined(); expect(config.mcp_servers).toBeUndefined()
    expect((await stat(join(isolated.home, 'auth.json'))).mode & 0o777).toBe(0o600)
    await expect(stat(join(isolated.home, 'state_5.sqlite'))).rejects.toThrow()
    await isolated.close()
    await expect(stat(join(isolated.home, 'auth.json'))).rejects.toThrow()
    expect(await readFile(join(source, 'auth.json'), 'utf8')).toContain('not-a-real-credential')
  } finally { await rm(source, { recursive: true, force: true }); if (isolated) await rm(isolated.directory, { recursive: true, force: true }) }
})

test('native verification copies the configured model catalog into the isolated home', async () => {
  const source = await mkdtemp(join(tmpdir(), 'galta-catalog-fixture-'))
  let isolated
  try {
    const catalog = join(source, 'model-catalog.json')
    await writeFile(catalog, '{"models":[{"slug":"fixture-sol"}]}')
    await writeFile(join(source, 'config.toml'), `model="fixture-sol"\nmodel_catalog_json=${JSON.stringify(catalog)}\n`)
    isolated = await codexTestHome(source)
    const config = Bun.TOML.parse(await readFile(join(isolated.home, 'config.toml'), 'utf8'))
    expect(config.model_catalog_json).toBe(join(isolated.home, 'model-catalog.json'))
    expect(await readFile(config.model_catalog_json, 'utf8')).toBe('{"models":[{"slug":"fixture-sol"}]}')
    await isolated.close()
    await expect(stat(join(isolated.home, 'model-catalog.json'))).rejects.toThrow()
  } finally { await rm(source, { recursive: true, force: true }); if (isolated) await rm(isolated.directory, { recursive: true, force: true }) }
})
