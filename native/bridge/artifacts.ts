import { mkdir, realpath, readFile, open, link, unlink, lstat, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, dirname, basename, extname, isAbsolute, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { imageSize } from 'image-size'
import { DOMParser } from '@xmldom/xmldom'
import { galtaWorkspaceDirectory } from '../paths'
import { MAX_HTML_BYTES, MAX_VIDEO_BYTES, managedArtifactReference, resolveManagedArtifactPath, validateHtml, sourceImageFormat, sourceImageFormats } from '../../packages/canvas/src/index'

const root = process.env.GALTA_WORKSPACE_DIRECTORY ?? galtaWorkspaceDirectory
function belongsTo(directory: string, path: string): boolean {
  const relation = relative(directory, path)
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))
}
function imageMime(bytes: Buffer, svg = false) {
  if (bytes.length > 32_000_000) return null
  try {
    const { type, width, height } = imageSize(bytes)
    if (type !== 'svg' && width > 0 && height > 0) return sourceImageFormats.find(format => format.type === type)?.mimeType ?? null
    svg ||= type === 'svg'
  } catch { /* SVG can use browser-default dimensions or relative sizing. */ }
  if (!svg) return null
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const document = new DOMParser({ onError: () => { throw new Error('Invalid SVG') } }).parseFromString(source, 'image/svg+xml')
    const element = document.documentElement
    return element?.localName === 'svg' && element.namespaceURI === 'http://www.w3.org/2000/svg' ? 'image/svg+xml' : null
  } catch { return null }
}

function artifactMime(path: string, bytes: Buffer): string {
  const extension = extname(path).toLowerCase()
  const image = imageMime(bytes, extension === '.svg')
  if (image) return image
  // Chunk headers need not contain an entire image document. Full validation
  // occurs on image reads and publication; this path also serves ordinary files.
  const imageFormat = sourceImageFormats.find(format => format.extensions.includes(extension.slice(1)))
  if (imageFormat) return imageFormat.mimeType
  if (extension === '.html' || extension === '.htm') return 'text/html'
  if (['.mp4', '.m4v', '.mov'].includes(extension) || bytes.toString('ascii', 4, 8) === 'ftyp') return extension === '.mov' || bytes.toString('ascii', 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4'
  if (extension === '.webm' || bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3) return 'video/webm'
  if (extension === '.ogv' || bytes.toString('ascii', 0, 4) === 'OggS') return 'video/ogg'
  return ({ '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip' } as Record<string, string>)[extension] ?? 'application/octet-stream'
}

function artifactIdentity(info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
}
function inside(directory: string, path: string): boolean {
  const relation = relative(directory, path)
  return relation !== '' && relation !== '..' && !relation.startsWith('..' + '/') && !isAbsolute(relation)
}
function insideOrRoot(directory: string, path: string): boolean {
  const relation = relative(directory, path)
  return relation === '' || (relation !== '..' && !relation.startsWith('..' + '/') && !isAbsolute(relation))
}

/** Validate existing destination ancestors before creating anything. A
 * recursive mkdir followed by realpath can leave directories outside the
 * workspace even when the final operation is rejected through a symlink. */
async function prepareDestinationParent(parent: string, workspace: string): Promise<string> {
  const missing: string[] = []
  let cursor = parent
  while (true) {
    try {
      const info = await lstat(cursor)
      if (info.isSymbolicLink()) {
        const actual = await realpath(cursor)
        throw new Error(insideOrRoot(workspace, actual) ? 'The destination directory must be a real directory inside this workspace' : 'The destination directory is outside this workspace')
      }
      if (!info.isDirectory()) throw new Error('The destination directory must be a real directory inside this workspace')
      const actual = await realpath(cursor)
      if (actual !== cursor || !insideOrRoot(workspace, actual)) throw new Error('The destination directory is outside this workspace')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const next = dirname(cursor)
      if (next === cursor) throw new Error('The destination directory is outside this workspace')
      missing.unshift(basename(cursor))
      cursor = next
    }
  }
  for (const segment of missing) {
    cursor = join(cursor, segment)
    await mkdir(cursor, { mode: 0o700 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
    const info = await lstat(cursor)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The destination directory must be a real directory inside this workspace')
    const actual = await realpath(cursor)
    if (actual !== cursor || !insideOrRoot(workspace, actual)) throw new Error('The destination directory is outside this workspace')
  }
  return realpath(parent)
}
/** A project's working directory is named by its id alone, so every browser
 * and profile shares it for the same id. */
function workspaceKey(projectId: string) {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('Project id is required')
  return new Bun.CryptoHasher('sha256').update(projectId).digest('hex').slice(0, 32)
}

/** The fixed id every browser profile gives its first canvas. Its directory
 * may belong to a canvas in another browser, so it is never removed. */
export const SHARED_PROJECT_ID = 'default-project'

export async function openCreativeWorkspace(projectId: string): Promise<string> {
  const key = workspaceKey(projectId)
  const cwd = join(root, key)
  await mkdir(cwd, { recursive: true, mode: 0o700 })
  await mkdir(join(cwd, 'sources'), { recursive: true, mode: 0o700 })
  await mkdir(join(cwd, 'outputs'), { recursive: true, mode: 0o700 })
  return cwd
}

/** Remove a deleted canvas's working directory and its delivery snapshots.
 * A directory that is already gone is fine; anything that is not a real
 * directory directly under the workspace root is refused before removing
 * anything. Returns false for the shared first-canvas id, which is kept. */
export async function removeCreativeWorkspace(projectId: string): Promise<boolean> {
  const key = workspaceKey(projectId)
  if (projectId === SHARED_PROJECT_ID) return false
  const directories = [join(root, key), join(root, '.deliveries', key)], present: string[] = []
  for (const directory of directories) {
    const info = await lstat(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
    if (!info) continue
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('This canvas\'s files are not where Galta keeps them. Nothing was removed.')
    present.push(directory)
  }
  for (const directory of present) await rm(directory, { recursive: true })
  return true
}

export async function readImageArtifact(path: string, cwd: string) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('An absolute image artifact path is required')
  const actual = await realpath(resolveManagedArtifactPath(path, cwd))
  const workspace = await realpath(cwd)
  if (!belongsTo(workspace, actual)) throw new Error('This image does not belong to the current creative session')
  const file = Bun.file(actual)
  if (file.size > 32_000_000) throw new Error('Image artifact exceeds 32 MB')
  const bytes = await readFile(actual)
  const mime = imageMime(bytes, extname(actual).toLowerCase() === '.svg')
  if (!mime) throw new Error('The artifact is not a supported image source')
  return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
}

export async function readHtmlArtifact(path: string, cwd: string) {
  if (typeof path !== 'string' || !isAbsolute(path) || !/\.html?$/i.test(path)) throw new Error('An absolute .html artifact path is required')
  const actual = await realpath(resolveManagedArtifactPath(path, cwd)), workspace = await realpath(cwd)
  if (!belongsTo(workspace, actual)) throw new Error('This HTML does not belong to the current creative session')
  if (Bun.file(actual).size > MAX_HTML_BYTES) throw new Error('HTML document exceeds 4 MB')
  const html = validateHtml(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(actual)))
  return { html }
}

/** Bounded native messages, not a base64 copy of the entire video. A file
 * identity fence prevents combining chunks from different source versions. */
export async function readVideoChunk(path: string, cwd: string, offset = 0, version?: string) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('An absolute video artifact path is required')
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid video offset')
  const actual = await realpath(resolveManagedArtifactPath(path, cwd)), workspace = await realpath(cwd)
  if (!belongsTo(workspace, actual)) throw new Error('This video does not belong to the current creative session')
  const file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat(), identity = artifactIdentity(info)
    if (!info.isFile() || !info.size || info.size > MAX_VIDEO_BYTES) throw new Error('Choose a video under 128 MB.')
    if (offset >= info.size || offset > 0 && version !== identity || version !== undefined && version !== identity) throw new Error('Video source changed during import')
    const header = Buffer.alloc(16); await file.read(header, 0, header.length, 0)
    const mimeType = header.toString('ascii', 4, 8) === 'ftyp' ? (header.toString('ascii', 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4')
      : header.readUInt32BE(0) === 0x1a45dfa3 ? 'video/webm' : header.toString('ascii', 0, 4) === 'OggS' ? 'video/ogg' : null
    if (!mimeType) throw new Error('The artifact is not a supported video')
    const bytes = Buffer.alloc(Math.min(384_000, info.size - offset))
    const { bytesRead } = await file.read(bytes, 0, bytes.length, offset)
    const after = await file.stat()
    if (!bytesRead || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error('Video source changed during import')
    return { dataBase64: bytes.subarray(0, bytesRead).toString('base64'), mimeType, total: info.size, offset, nextOffset: offset + bytesRead, version: identity }
  } finally { await file.close() }
}

/** Read a source URI that was created by canvas_extract. Delivery URIs are
 * intentionally rejected here; the receipt store owns those reads. */
export async function readArtifactChunk(uri: string, cwd: string, offset = 0, version?: string) {
  if (typeof uri !== 'string' || !uri.startsWith('galta-workspace:/')) throw new Error('A managed Galta artifact reference is required')
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid artifact offset')
  if (uri.startsWith('galta-workspace:/deliveries/')) throw new Error('A delivery receipt is required to read this artifact')
  const actual = await realpath(resolveManagedArtifactPath(uri, cwd)), workspace = await realpath(cwd)
  if (!belongsTo(workspace, actual)) throw new Error('This artifact does not belong to the current creative workspace')
  const file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat(), identity = artifactIdentity(info)
    if (!info.isFile() || info.size > MAX_VIDEO_BYTES) throw new Error('Choose an artifact under 128 MB.')
    if (offset > info.size || version !== undefined && version !== identity || offset > 0 && version === undefined) throw new Error('Artifact source changed during download')
    const header = Buffer.alloc(16); await file.read(header, 0, header.length, 0)
    const mimeType = artifactMime(actual, header)
    const bytes = Buffer.alloc(Math.min(384_000, info.size - offset))
    const { bytesRead } = bytes.length ? await file.read(bytes, 0, bytes.length, offset) : { bytesRead: 0 }
    const after = await file.stat()
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error('Artifact source changed during download')
    return { dataBase64: bytes.subarray(0, bytesRead).toString('base64'), mimeType, total: info.size, offset, nextOffset: offset + bytesRead, version: identity, name: basename(actual) }
  } finally { await file.close() }
}

function decodeArtifactBytes(dataBase64: string, limit: number): Buffer {
  if (typeof dataBase64 !== 'string' || dataBase64.length > Math.ceil(limit * 4 / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) throw new Error('Invalid extracted artifact bytes')
  const bytes = Buffer.from(dataBase64, 'base64')
  if (bytes.length > limit || bytes.toString('base64') !== dataBase64) throw new Error('Invalid extracted artifact bytes')
  return bytes
}

/** Publish immutable extracted sources under the workspace sources directory.
 * Existing different bytes are never overwritten. */
export async function writeArtifact(path: string, dataBase64: string, mimeType: string, cwd: string): Promise<void> {
  const workspace = await realpath(cwd)
  const sources = await realpath(join(cwd, 'sources'))
  if (sources !== join(workspace, 'sources')) throw new Error('Extracted files must stay in the workspace sources directory')
  if (typeof path !== 'string' || !isAbsolute(path) || await realpath(dirname(path)) !== sources) throw new Error('Extracted files must stay in the workspace sources directory')
  if (typeof mimeType !== 'string') throw new Error('An extracted artifact MIME type is required')
  const image = mimeType.startsWith('image/')
  const html = mimeType === 'text/html'
  const video = mimeType.startsWith('video/')
  if (!image && !html && !video) throw new Error('Only image, video and HTML sources can be extracted')
  const limit = image ? 32_000_000 : html ? MAX_HTML_BYTES : MAX_VIDEO_BYTES
  const bytes = decodeArtifactBytes(dataBase64, limit)
  if (image) {
    const format = sourceImageFormat(mimeType)
    if (!format || imageMime(bytes, format.type === 'svg') !== format.mimeType || !format.extensions.includes(extname(path).slice(1).toLowerCase())) throw new Error('Invalid image export bytes, MIME type or extension')
  }
  if (html && (!/\.html?$/i.test(path) || validateHtml(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) === '')) throw new Error('Invalid HTML export bytes')
  if (video && !/\.(mp4|m4v|webm|mov|ogv)$/i.test(path)) throw new Error('Invalid video export path')
  const target = join(sources, basename(path)), temporary = join(sources, `.${crypto.randomUUID()}.tmp`)
  const reuse = async () => {
    let existing
    try { existing = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
    try {
      const info = await existing.stat()
      if (!info.isFile() || info.size !== bytes.length || !(await existing.readFile()).equals(bytes)) throw new Error('The exported source file has changed; preserve it and export to a clean workspace.')
      return true
    } finally { await existing.close() }
  }
  if (await reuse()) return
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    await file.writeFile(bytes)
    await file.close()
    // Immutable, idempotent publication. A repeated export may reuse identical
    // bytes, but a changed file or symlink must never masquerade as that source.
    try { await link(temporary, target) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!await reuse()) throw new Error('The exported source disappeared during publication')
    }
  } finally { await file.close(); await unlink(temporary) }
}

/** Backwards-compatible image bridge entry point. */
export async function writeImageArtifact(path: string, dataBase64: string, cwd: string): Promise<void> {
  try { await writeArtifact(path, dataBase64, imageMime(decodeArtifactBytes(dataBase64, 32_000_000), extname(path).toLowerCase() === '.svg') ?? '', cwd) }
  catch (error) {
    if (error instanceof Error && /extracted artifact|MIME type|Only image/.test(error.message)) throw new Error('Invalid image export bytes')
    throw error
  }
}

/**
 * Make an explicit user-facing copy. The model supplies a source artifact
 * reference and a workspace-relative destination; the execution lease supplies
 * the workspace identity. No host or thread id is copied through model text.
 */
export async function deliverArtifact(source: string, destination: string, cwd: string) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('A source artifact reference is required')
  if (typeof destination !== 'string' || !destination.trim() || destination.includes('\0') || destination.split(/[\\/]/).some(part => !part || part === '.' || part === '..') || isAbsolute(destination)) {
    throw new Error('Destination must be a workspace-relative file path without traversal')
  }
  const workspace = await realpath(cwd)
  const sourceCandidate = resolveManagedArtifactPath(source, workspace)
  const sourcePath = await realpath(isAbsolute(sourceCandidate) ? sourceCandidate : resolve(workspace, sourceCandidate))
  if (!inside(workspace, sourcePath) || (await lstat(isAbsolute(sourceCandidate) ? sourceCandidate : resolve(workspace, sourceCandidate))).isSymbolicLink()) throw new Error('The source must be a regular file inside this workspace')
  const target = resolve(workspace, destination), parent = dirname(target)
  if (!inside(workspace, target)) throw new Error('The destination must stay inside this workspace')
  const parentActual = await prepareDestinationParent(parent, workspace)

  const input = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let bytes: Buffer
  let before: Awaited<ReturnType<typeof input.stat>>
  try {
    before = await input.stat()
    if (!before.isFile() || before.size > MAX_VIDEO_BYTES) throw new Error('Only regular files up to 128 MB can be delivered')
    bytes = await input.readFile()
    const after = await input.stat()
    if (artifactIdentity(before) !== artifactIdentity(after) || bytes.length !== before.size) throw new Error('The source changed during delivery')
  } finally { await input.close() }

  const targetInfo = await lstat(target).catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : Promise.reject(error))
  if (targetInfo?.isSymbolicLink() || targetInfo && !targetInfo.isFile()) throw new Error('The destination already exists and is not a regular file')
  if (targetInfo) {
    const existing = await readFile(target)
    if (!existing.equals(bytes)) throw new Error('The destination already exists with different bytes')
  } else {
    const temporary = join(parentActual, `.${basename(target)}.${crypto.randomUUID()}.tmp`)
    const output = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try { await output.writeFile(bytes); await output.sync() }
    finally { await output.close() }
    try {
      await link(temporary, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await readFile(target)
      if (!existing.equals(bytes)) throw new Error('The destination was created with different bytes')
    } finally { await unlink(temporary).catch(() => {}) }
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return {
    path: target,
    artifactUri: managedArtifactReference(target, workspace),
    sourceArtifactUri: managedArtifactReference(sourcePath, workspace),
    name: basename(target), mimeType: artifactMime(target, bytes), size: bytes.length,
    sha256, version: artifactIdentity(before)
  }
}
