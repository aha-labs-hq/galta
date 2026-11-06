import { runtimePort } from '../../apps/extension/src/shared/runtimePort'

/** Adapt native framing without registering or installing a browser host. */
export function nativePort(command: string[], env: Record<string, string | undefined>, onExit?: () => void) {
  const child = Bun.spawn(command, { env, stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
  let closed = false, write = Promise.resolve()
  const channel = runtimePort(command.at(-1)!, value => {
    const bytes = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32LE(bytes.length)
    write = write.then(async () => { await child.stdin.write(Buffer.concat([header, bytes])); await child.stdin.flush() }).catch(() => close())
  }, () => close())
  function close() {
    if (closed) return
    closed = true; child.stdin.end(); channel.ended()
    // EOF lets the relay reap its Codex child before the relay itself exits.
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3_000)
    void child.exited.finally(() => { clearTimeout(timeout); onExit?.() })
  }
  void (async () => {
    let buffer = Buffer.alloc(0)
    for await (const chunk of child.stdout) {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE()
        if (size > 1024 * 1024) throw new Error('Invalid native frame')
        if (buffer.length < size + 4) break
        channel.receive(JSON.parse(buffer.subarray(4, size + 4).toString()))
        buffer = buffer.subarray(size + 4)
      }
    }
  })().catch(error => console.error('Local native transport failed:', String(error))).finally(close)
  return channel.port
}
