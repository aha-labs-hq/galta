import { rename, rm, writeFile } from 'node:fs/promises'

/** Every running command line, executable path included. */
export async function runningCommands() {
  const ps = Bun.spawn(['/bin/ps', '-axww', '-o', 'comm=', '-o', 'args='], { stdout: 'pipe', stderr: 'pipe' })
  const [code, output, errors] = await Promise.all([ps.exited, new Response(ps.stdout).text(), new Response(ps.stderr).text()])
  if (code !== 0) throw new Error(`Running processes could not be listed. ${errors.trim()}`)
  return output
}

/** A private file that is replaced whole or not at all. */
export async function atomicFile(path: string, contents: string) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  try { await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' }); await rename(temporary, path) }
  finally { await rm(temporary, { force: true }) }
}
