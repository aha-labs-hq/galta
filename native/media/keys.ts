import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GENERATION_SETTINGS, MEDIA_PROVIDERS, type MediaProviderId, type MediaProviderState } from '../../packages/canvas/src/capabilities/media'
import type { MediaProvider } from './providers/provider'

type Stored = Partial<Record<MediaProviderId, { key: string; connectedAt: string }>>

/**
 * The user's provider keys, private to this OS user: one 0600 file in a 0700
 * directory, protected by file permissions rather than encryption or the
 * Keychain. Only Settings writes it. Generation reads it per call,
 * so a key connected or removed in Settings applies to the next request.
 */
export class MediaKeys {
  private readonly file: string
  constructor(private readonly directory: string) { this.file = join(directory, 'keys.json') }

  private async read(): Promise<Stored> {
    let text: string
    try { text = await readFile(this.file, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
    try { return JSON.parse(text) as Stored }
    catch { throw new Error(`Galta's provider keys are unreadable. Reconnect your providers under ${GENERATION_SETTINGS}; the damaged file is ${this.file}`) }
  }

  private async write(stored: Stored) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
    const temporary = `${this.file}.${process.pid}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(stored), { mode: 0o600, flag: 'wx' })
      await rename(temporary, this.file)
    } finally { await rm(temporary, { force: true }) }
  }

  async key(provider: MediaProviderId): Promise<string | undefined> { return (await this.read())[provider]?.key }

  async status(): Promise<MediaProviderState[]> {
    const stored = await this.read()
    return MEDIA_PROVIDERS.map(({ id }) => ({ id, connected: Boolean(stored[id]?.key) }))
  }

  /** A key is stored only after the provider accepted it on a free, read-only request. */
  async connect(provider: Pick<MediaProvider, 'id' | 'name' | 'check'>, key: unknown): Promise<MediaProviderState[]> {
    const value = typeof key === 'string' ? key.trim() : ''
    if (!value || value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) throw new Error('Paste the API key exactly as the provider shows it.')
    let verdict: Awaited<ReturnType<MediaProvider['check']>>
    try { verdict = await provider.check(value) }
    catch { throw new Error(`Couldn't reach ${provider.name}. Check your connection and try again.`) }
    if (verdict === 'refused') throw new Error(`${provider.name} didn't accept this key.`)
    if (verdict !== 'accepted') throw new Error(`${provider.name} is unavailable right now (${verdict.unavailable}). Try again.`)
    await this.write({ ...await this.read(), [provider.id]: { key: value, connectedAt: new Date().toISOString() } })
    return this.status()
  }

  async disconnect(provider: MediaProviderId): Promise<MediaProviderState[]> {
    const { [provider]: _removed, ...rest } = await this.read()
    await this.write(rest)
    return this.status()
  }
}
