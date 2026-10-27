import { link, mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { MediaKind } from '../../packages/canvas/src/capabilities/media'

export const MAX_MEDIA_BYTES = 512 * 1024 * 1024
export type MediaFile = { path: string; mimeType: string }
type Format = { mimeType: string; extension: string; kind: MediaKind }

/** Identify media by its bytes, never by what a provider says it sent. */
export function sniff(bytes: Uint8Array): Format | undefined {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return { mimeType: 'image/png', extension: 'png', kind: 'image' }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mimeType: 'image/jpeg', extension: 'jpg', kind: 'image' }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { mimeType: 'image/webp', extension: 'webp', kind: 'image' }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return { mimeType: 'audio/wav', extension: 'wav', kind: 'speech' }
  if (ascii(4, 8) === 'ftyp') return ascii(8, 12) === 'qt  ' ? { mimeType: 'video/quicktime', extension: 'mov', kind: 'video' } : { mimeType: 'video/mp4', extension: 'mp4', kind: 'video' }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return { mimeType: 'video/webm', extension: 'webm', kind: 'video' }
  if (ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0 && ((bytes[1] ?? 0) & 0x06) !== 0)) return { mimeType: 'audio/mpeg', extension: 'mp3', kind: 'speech' }
  return undefined
}

/** Write one generated output into `directory` as `<stem>.<extension>`. The
 * file appears complete or not at all, and an existing file is never replaced. */
export async function saveMedia(directory: string, stem: string, kind: MediaKind, source: Uint8Array | ReadableStream<Uint8Array>): Promise<MediaFile> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const partial = join(directory, `.${stem}.partial`)
  // Only the job's owner writes this stem, so a partial file is a crashed attempt.
  await rm(partial, { force: true })
  const file = await open(partial, 'wx', 0o600)
  let format: Format | undefined
  try {
    let size = 0, head = new Uint8Array(0)
    const write = async (chunk: Uint8Array) => {
      size += chunk.byteLength
      if (size > MAX_MEDIA_BYTES) throw new Error(`The generated file exceeds ${MAX_MEDIA_BYTES / 1024 / 1024} MB`)
      if (head.length < 16) head = Uint8Array.from([...head, ...chunk.subarray(0, 16 - head.length)])
      await file.write(chunk)
    }
    if (source instanceof Uint8Array) await write(source)
    else for await (const chunk of source) await write(chunk)
    format = sniff(head)
    if (!format || format.kind !== kind) throw new Error(`The provider returned ${format ? format.mimeType : 'unrecognised data'} instead of ${kind === 'speech' ? 'audio' : `a ${kind}`}`)
    await file.close()
    const path = join(directory, `${stem}.${format.extension}`)
    // link() publishes the finished file and never replaces one. The stem is
    // the job's own, so an existing file is this output, completed by an
    // attempt that stopped before recording it.
    await link(partial, path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    await rm(partial, { force: true })
    return { path, mimeType: format.mimeType }
  } catch (error) {
    await file.close().catch(() => undefined)
    await rm(partial, { force: true })
    throw error
  }
}

/** Provider output links are HTTPS by contract; anything else is refused. */
export async function openOutput(url: string, fetchOutput: (url: string) => Promise<Response>): Promise<ReadableStream<Uint8Array>> {
  if (new URL(url).protocol !== 'https:') throw new Error('The provider returned a non-HTTPS file address')
  const response = await fetchOutput(url)
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(`Downloading the generated file failed (HTTP ${response.status})`)
  }
  return response.body
}
