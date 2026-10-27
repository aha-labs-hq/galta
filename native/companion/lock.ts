/** Kernel-owned lock: released on crashes, with no stale-file deletion race. */
export async function lockActivation(path: string, executable: string) {
  const child = Bun.spawn([executable, path], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  const errors = new Response(child.stderr).text()
  const reader = child.stdout.getReader()
  const first = await reader.read()
  reader.releaseLock()
  if (first.done || first.value[0] !== 49) {
    child.stdin.end(); await child.exited
    throw new Error((await errors).trim() || 'Unable to lock the installation')
  }
  return async () => { child.stdin.end(); await child.exited; await errors }
}
