/** Native messaging permits only 1 MiB per host message. Artifacts use the same
 * ordered transport as all other RPC messages, without a second delivery API. */
const CHUNK_SIZE = 192_000
const MAX_LENGTH = 48_000_000
export function encodeNativeMessages(value: unknown): unknown[] {
  const text = JSON.stringify(value)
  if (text.length > MAX_LENGTH) throw new Error('Codex message exceeds the 48 MB transport limit')
  if (text.length <= CHUNK_SIZE) return [value]
  const id = crypto.randomUUID()
  const count = Math.ceil(text.length / CHUNK_SIZE)
  return Array.from({ length: count }, (_, index) => ({ method: 'galta/transport/chunk', params: { id, index, count, data: text.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE) } }))
}

export class NativeMessageDecoder {
  private active: { id: string; count: number; parts: string[]; length: number } | null = null
  reset() { this.active = null }
  push(message: any): unknown | undefined {
    if (message?.method !== 'galta/transport/chunk') {
      if (this.active) { this.reset(); throw new Error('Interrupted Codex message') }
      return message
    }
    const p = message.params
    if (!p || typeof p.id !== 'string' || !Number.isInteger(p.count) || p.count < 2 || p.count > Math.ceil(MAX_LENGTH / CHUNK_SIZE) || !Number.isInteger(p.index) || typeof p.data !== 'string' || p.data.length > CHUNK_SIZE) {
      this.reset(); throw new Error('Invalid Codex message fragment')
    }
    if (!this.active && p.index === 0) this.active = { id: p.id, count: p.count, parts: [], length: 0 }
    const a = this.active
    if (!a || a.id !== p.id || a.count !== p.count || p.index !== a.parts.length) {
      this.reset(); throw new Error('Out-of-order Codex message fragment')
    }
    a.length += p.data.length
    if (a.length > MAX_LENGTH) { this.reset(); throw new Error('Codex message exceeds the transport limit') }
    a.parts.push(p.data)
    if (a.parts.length !== a.count) return undefined
    this.reset()
    return JSON.parse(a.parts.join(''))
  }
}
