import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { MEDIA_EMBEDDED_BYTES, MEDIA_REFERENCE_BYTES } from '../../packages/canvas/src/capabilities/media'
import { sniff } from './files'

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/

/** Turn each reference into something a provider can fetch: HTTPS stays as
 * it is; a local file or data URL becomes a checked image data URL. The
 * bytes are read for this request only and never stored with the job. */
export async function resolveReferences(values: readonly string[]): Promise<string[]> {
  let total = 0
  const resolved: string[] = []
  for (const value of values) {
    if (value.startsWith('https://')) { resolved.push(value); continue }
    const data = DATA_URL.exec(value)
    const bytes = data ? Buffer.from(data[2]!, 'base64') : isAbsolute(value) ? await readImage(value) : undefined
    if (!bytes) throw new Error('A reference must be an absolute file path, an HTTPS URL or an image data URL')
    if (!bytes.length || bytes.length > MEDIA_REFERENCE_BYTES) throw new Error(`Each reference image must be at most ${MEDIA_REFERENCE_BYTES / 1024 / 1024} MB`)
    total += bytes.length
    if (total > MEDIA_EMBEDDED_BYTES) throw new Error(`Reference images may total at most ${MEDIA_EMBEDDED_BYTES / 1024 / 1024} MB; use smaller files`)
    const format = sniff(bytes)
    if (format?.kind !== 'image' || (data && data[1] !== format.mimeType)) throw new Error('A reference must contain PNG, JPEG or WebP data')
    resolved.push(`data:${format.mimeType};base64,${bytes.toString('base64')}`)
  }
  return resolved
}

async function readImage(path: string): Promise<Buffer> {
  // A non-blocking open refuses FIFOs and devices instead of waiting on them.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => { throw new Error(`Cannot read the reference image ${path}`) })
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new Error(`${path} is not a file`)
    if (info.size > MEDIA_REFERENCE_BYTES) throw new Error(`Each reference image must be at most ${MEDIA_REFERENCE_BYTES / 1024 / 1024} MB`)
    return await file.readFile()
  } finally { await file.close() }
}
