import { test, expect } from 'bun:test'
import { embeddedCodexEnvironment } from '../native/adapters/codex/environment'

test('embedded chat owns one stable state root across restart, independent of the launching desktop', () => {
  const inherited = { PATH: '/bin', CODEX_HOME: '/desktop', CODEX_SQLITE_HOME: '/desktop-db', CODEX_APP_TOOLS_PIPE_PATH: '/desktop.sock', CODEX_THREAD_ID: 'desktop-thread', CODEX_ACCESS_TOKEN: 'fixture-token', OPENAI_API_KEY: 'fixture-key', OPENAI_BASE_URL: 'https://fixture.invalid' }
  const a = embeddedCodexEnvironment('/galta/runtime', inherited)
  expect(a.directory).toBe('/galta/runtime/codex')
  expect(a.environment).toEqual({ PATH: '/bin', CODEX_HOME: a.directory, CODEX_SQLITE_HOME: a.directory })
  expect(embeddedCodexEnvironment('/galta/runtime', { PATH: '/bin' })).toEqual(a)
  expect(embeddedCodexEnvironment('/test/runtime', inherited).directory).not.toBe(a.directory)
  expect(inherited.CODEX_HOME).toBe('/desktop')
})
