/** dataURL is accepted only at legacy/editor and portable-file boundaries. */
export type CanvasAsset = { id: string; mimeType: string; created: number; blob?: Blob; dataURL?: string; lastRetrieved?: number }
export type CanvasAssets = Record<string, CanvasAsset>
const normalized = new WeakMap<object, CanvasAsset>()

export function assetBlob(file: CanvasAsset): Blob {
  if (file.blob instanceof Blob) return file.blob
  const cached = normalized.get(file)
  if (cached?.blob) return cached.blob
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(file.dataURL ?? '')
  if (!match) throw new Error(`Missing binary canvas asset: ${file.id}`)
  const decoded = atob(match[2]!), bytes = new Uint8Array(decoded.length)
  // TypedArray.from(string) first collects the iterable's every character.
  // A large video must allocate only its byte buffer, not a per-byte JS list.
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i)
  const blob = new Blob([bytes], { type: match[1]! })
  const { dataURL: _, ...metadata } = file
  normalized.set(file, { ...metadata, blob })
  return blob
}
export function normalizeAsset(file: CanvasAsset): CanvasAsset {
  if (file.blob && !file.dataURL) return file
  const cached = normalized.get(file)
  if (cached) return cached
  const blob = assetBlob(file)
  const { dataURL: _, ...metadata } = file
  const result = { ...metadata, blob }
  normalized.set(file, result)
  return result
}
export const normalizeAssets = (files: CanvasAssets): CanvasAssets => Object.fromEntries(Object.entries(files).map(([id, file]) => [id, normalizeAsset(file)]))

/** JSON is a compatibility boundary (clipboard and .galta export), never the
 * persistence format. Encode each immutable file once per operation. */
export async function portableAsset(file: CanvasAsset): Promise<CanvasAsset> {
  const { blob: _, ...metadata } = file
  const bytes = new Uint8Array(await assetBlob(file).arrayBuffer()), chunks: string[] = []
  for (let i = 0; i < bytes.length; i += 32768) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)))
  return { ...metadata, dataURL: `data:${file.mimeType};base64,${btoa(chunks.join(''))}` }
}

/** Enforce the limit while receiving, including chunked/incorrect-length
 * responses. An oversized download must never allocate its complete body. */
export async function readResponseBlob(response: Response, limit: number, message: string): Promise<Blob> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw new Error(message)
  }
  if (!response.body) return response.blob()
  let size = 0
  const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength
      if (size > limit) throw new Error(message)
      controller.enqueue(chunk)
    }
  }))
  return new Blob([await new Response(bounded).blob()], { type: response.headers.get('content-type') ?? '' })
}

/** Runtime URLs have an explicit owner. They never enter a saved document. */
export class AssetURLs {
  private readonly entries = new Map<Blob, string>()
  url(file: CanvasAsset): string {
    const blob = assetBlob(file)
    let url = this.entries.get(blob)
    if (!url) { url = URL.createObjectURL(blob); this.entries.set(blob, url) }
    return url
  }
  release() { for (const url of this.entries.values()) URL.revokeObjectURL(url); this.entries.clear() }
}
