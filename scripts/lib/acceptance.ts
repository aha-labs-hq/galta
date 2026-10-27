import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

/** The browser suite's two servers: Vite for the development fixtures, and the
 * production build server. Their ports derive from the checkout's path, so
 * worktrees can run the suite side by side and a run never reaches another
 * checkout's server. Commands run from the repository root. */
const base = 20_000 + Number.parseInt(createHash('sha256').update(process.cwd()).digest('hex').slice(0, 8), 16) % 10_000 * 2
function port(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be an integer from 1 to 65535`)
  return value
}
export const devPort = port('GALTA_TEST_PORT', base)
export const devOrigin = `http://127.0.0.1:${devPort}`
export const acceptancePort = port('GALTA_ACCEPTANCE_PORT', base + 1)
export const acceptanceOrigin = `http://127.0.0.1:${acceptancePort}`
/** The production build the server and the extension tests load. */
export const acceptanceBuild = resolve(process.env.GALTA_ACCEPTANCE_BUILD ?? 'apps/extension/release')
