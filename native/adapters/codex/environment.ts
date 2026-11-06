import { join } from 'node:path'

/** Built-in chat owns its state. Never borrow a desktop connection, credentials,
 * provider configuration or SQLite location from the launching process. */
export function embeddedCodexEnvironment(runtimeDirectory: string, inherited: NodeJS.ProcessEnv) {
  const environment = { ...inherited }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('CODEX_') && key !== 'CODEX_CA_CERTIFICATE' || key === 'OPENAI_API_KEY' || key === 'OPENAI_BASE_URL') delete environment[key]
  }
  const directory = join(runtimeDirectory, 'codex')
  return { directory, environment: { ...environment, CODEX_HOME: directory, CODEX_SQLITE_HOME: directory } }
}
