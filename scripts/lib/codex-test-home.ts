import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

// Only provider/auth preferences cross this boundary. Never inherit history,
// project roots, storage paths, MCP servers, plugins or desktop settings.
const providerKeys = ['model', 'model_provider', 'model_providers', 'model_reasoning_effort', 'forced_login_method', 'forced_chatgpt_workspace_id']
const inlineToml = (value: any): string => {
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(inlineToml).join(', ')}]`
  if (value && typeof value === 'object') return `{ ${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)} = ${inlineToml(entry)}`).join(', ')} }`
  throw new Error('Unsupported provider configuration in test Codex home')
}
export function codexTestEnvironment(home: string, directory: string): Record<string, string | undefined> {
  // Provider authentication is shared; the parent's desktop session is not.
  const disconnected = Object.fromEntries(['CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_PERMISSION_PROFILE'].map(key => [key, undefined]))
  return { ...disconnected, CODEX_HOME: home, GALTA_WORKSPACE_DIRECTORY: join(directory, 'workspaces'), GALTA_RUNTIME_DIRECTORY: join(directory, 'runtime'), GALTA_BRIDGE_DIRECTORY: join(directory, 'bridges') }
}
export async function codexTestHome(source = process.env.CODEX_HOME ?? join(homedir(), '.codex')) {
  const directory = await mkdtemp(join(tmpdir(), 'galta-codex-test-')), home = join(directory, 'codex')
  await mkdir(home, { mode: 0o700 })
  const optionalRead = async (path: string) => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  const config = Bun.TOML.parse(await optionalRead(join(source, 'config.toml'))) as Record<string, unknown>
  const entries = providerKeys.filter(key => config[key] !== undefined).map(key => `${key} = ${inlineToml(config[key])}`)
  const catalogSource = typeof config.model_catalog_json === 'string' ? config.model_catalog_json : undefined
  const catalogTarget = join(home, 'model-catalog.json')
  let catalogCopied = false
  if (catalogSource) {
    try {
      await copyFile(catalogSource, catalogTarget)
      entries.push(`model_catalog_json = ${JSON.stringify(catalogTarget)}`)
      catalogCopied = true
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const content = entries.join('\n')
  await writeFile(join(home, 'config.toml'), content + '\ncli_auth_credentials_store = "file"\n', { mode: 0o600 })
  try { await copyFile(join(source, 'auth.json'), join(home, 'auth.json')); await chmod(join(home, 'auth.json'), 0o600) }
  catch (error: any) { if (error.code !== 'ENOENT') throw error }
  return {
    directory, home,
    environment: codexTestEnvironment(home, directory),
    async close() {
      await rm(join(home, 'auth.json'), { force: true })
      await rm(join(home, 'config.toml'), { force: true })
      if (catalogCopied) await rm(catalogTarget, { force: true })
    }
  }
}
