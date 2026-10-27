import type { Subprocess } from 'bun'
import { NativeMessageDecoder } from '../../packages/runtime/src/transport'

/** Exercise the actual framed executable, including startup errors and timeouts. */
export class NativeClient {
  private readonly child: Subprocess<'pipe', 'pipe', 'pipe'>
  private readonly pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>()
  private readonly decoder = new NativeMessageDecoder()
  private nextId = 0
  private readonly reading: Promise<void>
  private readonly errors: Promise<string>
  constructor(command: string, origin: string, env: Record<string, string | undefined>, private readonly onNotification?: (message: any) => void) {
    this.child = Bun.spawn([command, origin], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    this.errors = new Response(this.child.stderr).text()
    this.reading = this.read().catch(error => { for (const call of this.pending.values()) call.reject(error); this.pending.clear() })
  }
  private async read() {
    let buffer = Buffer.alloc(0)
    for await (const chunk of this.child.stdout) {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0)
        if (length > 1024 * 1024) throw new Error('Oversized native reply')
        if (buffer.length < length + 4) break
        const part = JSON.parse(buffer.subarray(4, 4 + length).toString())
        buffer = buffer.subarray(4 + length)
        const value = this.decoder.push(part) as { id?: string; method?: string; result?: unknown; error?: { message: string } } | undefined
        if (value?.method && value.id === undefined) this.onNotification?.(value)
        if (!value?.id) continue
        const call = this.pending.get(String(value.id))
        this.pending.delete(String(value.id))
        if (value.error) call?.reject(new Error(value.error.message))
        else call?.resolve(value.result)
      }
    }
    if (this.pending.size) throw new Error(`Native host exited before replying: ${(await this.errors).slice(-1000)}`)
  }
  notify(method: string, params?: unknown) { this.send({ method, params }) }
  private send(value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value)), frame = Buffer.alloc(bytes.length + 4)
    frame.writeUInt32LE(bytes.length); bytes.copy(frame, 4); this.child.stdin.write(frame)
  }
  async request(method: string, params?: unknown): Promise<any> {
    const id = String(++this.nextId)
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject })
        timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`Native request timed out: ${method}`)) }, 15_000)
        this.send({ id, method, params })
      })
    } finally { clearTimeout(timeout) }
  }
  async close() { this.child.stdin.end(); this.child.kill(); await this.child.exited; await this.reading }
}
