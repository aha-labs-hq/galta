import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ARTIFACT_LIMITS, artifactDeliveryDeclarationSchema, artifactIdentitySchema, artifactReadSchema, artifactReceiptSchema, type ArtifactDeliveryDeclaration, type ArtifactIdentity, type ArtifactReceipt, type ConversationArtifact } from '../../packages/domain/src/artifacts'

const CHUNK_BYTES = 384_000
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const identity = (s: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
function inside(root: string, path: string) {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)
}
function rejectTraversal(path: string) {
  if (path.includes('\0') || path.split(/[\\/]/).some(segment => segment === '..')) throw new Error('File links cannot contain parent traversal or null bytes')
}

/** New declarations never use the legacy workspace-path migration helper. */
async function sourcePath(href: string, workspace: string) {
  if (!href.trim()) throw new Error('A file link is required')
  let candidate: string
  if (href.startsWith('galta-workspace:/')) {
    const segments = href.slice('galta-workspace:/'.length).split('/').map(decodeURIComponent)
    if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[\\/\0]/.test(segment))) throw new Error('Invalid managed file link')
    candidate = join(workspace, ...segments)
  } else if (href.startsWith('file:') || href.startsWith('sandbox:')) {
    rejectTraversal(decodeURIComponent(href))
    const url = new URL(href)
    if (url.search || url.hash) throw new Error('File URLs cannot contain a query or fragment')
    // Codex uses sandbox: for local download links. It addresses the exact
    // path supplied, with the same workspace and symlink checks as file:.
    if (url.protocol === 'sandbox:' && (url.host || url.username || url.password || !url.pathname.startsWith('/'))) throw new Error('Sandbox file links must contain an absolute local path')
    candidate = fileURLToPath(url.protocol === 'sandbox:' ? new URL(`file://${url.pathname}`) : url)
  } else {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) throw new Error('Unsupported file link')
    rejectTraversal(href)
    // Literal paths retain percent signs; URI forms alone decode them.
    candidate = resolve(workspace, href)
  }
  rejectTraversal(candidate)
  const actual = await realpath(candidate)
  if (!inside(workspace, actual)) throw new Error('The linked file is outside this workspace')
  // Allow OS aliases such as /tmp -> /private/tmp, but no symlinks below the
  // workspace root. Recheck the path after copying to fence directory swaps.
  let ancestor = dirname(candidate)
  while (await realpath(ancestor) !== workspace) {
    if (ancestor === dirname(ancestor)) throw new Error('The linked file is outside this workspace')
    if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('File links cannot traverse workspace symlinks')
    ancestor = dirname(ancestor)
  }
  if ((await lstat(candidate)).isSymbolicLink()) throw new Error('File links cannot follow workspace symlinks')
  return { candidate, actual }
}

/** Host-owned snapshots live alongside workspaces, outside Agent working dirs. */
async function deliveryRoot(workspace: string) {
  const parent = join(dirname(workspace), '.deliveries'), root = join(parent, basename(workspace))
  for (const directory of [parent, root]) {
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw new Error('Invalid delivery storage directory')
  }
  return root
}

async function freeze(href: string, workspace: string, owner: ArtifactIdentity, remaining: number, signal: AbortSignal, declaration?: ArtifactDeliveryDeclaration): Promise<ArtifactReceipt> {
  // An explicit canvas_deliver declaration identifies the immutable source at
  // tool-call time. Finalization reads that source and verifies its identity;
  // it never silently re-reads a destination that the model or user changed.
  const source = await sourcePath(declaration?.sourceArtifactUri ?? href, workspace), input = await open(source.candidate, readFlags)
  const root = await deliveryRoot(workspace), receiptId = crypto.randomUUID(), pending = join(root, `.${receiptId}`)
  let committed = false
  try {
    signal.throwIfAborted()
    const before = await input.stat()
    if (!before.isFile() || before.size > ARTIFACT_LIMITS.bytes) throw new Error('Only regular files up to 128 MB can be delivered')
    if (declaration && (identity(before) !== declaration.version || before.size !== declaration.size)) throw new Error('The declared delivery source changed before finalization')
    if (before.size > remaining) throw new Error('This response exceeds the 256 MB file delivery limit')
    if (identity(await stat(source.actual)) !== identity(before)) throw new Error('The linked file changed before delivery')
    await mkdir(pending, { mode: 0o700 })
    const output = await open(join(pending, 'file'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    const hash = createHash('sha256')
    try {
      let offset = 0
      while (offset < before.size) {
        signal.throwIfAborted()
        const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, before.size - offset))
        const { bytesRead } = await input.read(bytes, 0, bytes.length, offset)
        if (bytesRead !== bytes.length) throw new Error('The linked file changed during delivery')
        hash.update(bytes); await output.writeFile(bytes); offset += bytesRead
      }
      if (identity(await input.stat()) !== identity(before) || await realpath(source.candidate) !== source.actual || identity(await stat(source.candidate)) !== identity(before)) throw new Error('The linked file changed during delivery')
      await output.sync()
    } finally { await output.close() }
    const sha256 = hash.digest('hex')
    if (declaration && (sha256 !== declaration.sha256 || before.size !== declaration.size)) throw new Error('The declared delivery source bytes changed before finalization')
    const version = identity(await stat(join(pending, 'file'))), name = declaration?.name ?? basename(source.actual)
    const receipt = artifactReceiptSchema.parse({ ...owner, href, receiptId, uri: `galta-workspace:/deliveries/${receiptId}/${encodeURIComponent(name)}`,
      ...(declaration ? { artifactUri: declaration.artifactUri } : {}), name,
      mimeType: (declaration?.mimeType ?? Bun.file(source.actual).type) || 'application/octet-stream', size: before.size, sha256, version })
    const manifest = await open(join(pending, 'receipt.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await manifest.writeFile(JSON.stringify(receipt)); await manifest.sync() }
    finally { await manifest.close() }
    signal.throwIfAborted()
    await rename(pending, join(root, receiptId)); committed = true
    return receipt
  } finally {
    await input.close()
    if (!committed) await rm(pending, { recursive: true, force: true })
  }
}

export async function finalizeArtifacts(hrefs: unknown, cwd: string, identityValue: unknown, declarationsValue?: unknown): Promise<ConversationArtifact[]> {
  const owner = artifactIdentitySchema.parse(identityValue), workspace = await realpath(cwd)
  if (!Array.isArray(hrefs) || hrefs.length > ARTIFACT_LIMITS.files || hrefs.some(href => typeof href !== 'string' || href.length > 16_384)) throw new Error('Deliver at most 16 file links per response')
  const declarations = declarationsValue === undefined ? [] : artifactDeliveryDeclarationSchema.array().max(ARTIFACT_LIMITS.files).parse(declarationsValue)
  const byReference = new Map<string, ArtifactDeliveryDeclaration>()
  for (const declaration of declarations) {
    byReference.set(declaration.path, declaration)
    byReference.set(declaration.artifactUri, declaration)
  }
  const signal = AbortSignal.timeout(ARTIFACT_LIMITS.timeoutMs), result: ConversationArtifact[] = []
  let remaining = ARTIFACT_LIMITS.totalBytes
  const seen = new Set<string>()
  for (const href of hrefs as string[]) {
    try {
      const declaration = byReference.get(href)
      const key = declaration
        ? `declaration:${declaration.path}`
        : await sourcePath(href, workspace).then(source => `source:${source.actual}`).catch(() => `href:${href}`)
      if (seen.has(key)) continue
      seen.add(key)
      const receipt = await freeze(declaration?.path ?? href, workspace, owner, remaining, signal, declaration)
      remaining -= receipt.size; result.push({ href, status: 'ready', receipt })
    } catch (error) { result.push({ href, status: 'failed', error: error instanceof Error ? error.message : String(error) }) }
  }
  return result
}

/** Only a persisted receipt grants access. URI text alone has no authority. */
export async function readDeliveryChunk(request: unknown, cwd: string, projectId: string, offset = 0, version?: string) {
  const full = artifactReceiptSchema.safeParse(request)
  const grant = full.success ? artifactReadSchema.parse({ receiptId: full.data.receiptId, projectId: full.data.projectId, threadId: full.data.threadId, turnId: full.data.turnId, messageId: full.data.messageId, href: full.data.href, uri: full.data.uri }) : artifactReadSchema.parse(request)
  if (grant.projectId !== projectId) throw new Error('This delivery belongs to another canvas')
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid artifact offset')
  const root = await deliveryRoot(await realpath(cwd)), directory = join(root, grant.receiptId)
  if (await realpath(directory) !== directory) throw new Error('Invalid delivery receipt directory')
  const manifest = await open(join(directory, 'receipt.json'), readFlags)
  let receipt: ArtifactReceipt
  try {
    const info = await manifest.stat()
    if (!info.isFile() || info.size > 64_000) throw new Error('Invalid delivery receipt')
    receipt = artifactReceiptSchema.parse(JSON.parse(await manifest.readFile('utf8')))
  } finally { await manifest.close() }
  for (const key of Object.keys(grant) as (keyof typeof grant)[]) if (grant[key] !== receipt[key]) throw new Error('The delivery receipt does not authorize this message link')
  const file = await open(join(directory, 'file'), readFlags)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size !== receipt.size || identity(before) !== receipt.version || version !== undefined && version !== receipt.version || offset > 0 && version === undefined) throw new Error('The delivered file changed')
    if (offset >= receipt.size && !(offset === 0 && receipt.size === 0)) throw new Error('Invalid artifact offset')
    const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, receipt.size - offset))
    const { bytesRead } = bytes.length ? await file.read(bytes, 0, bytes.length, offset) : { bytesRead: 0 }
    if (bytesRead !== bytes.length || identity(await file.stat()) !== receipt.version) throw new Error('The delivered file changed during download')
    return { dataBase64: bytes.toString('base64'), mimeType: receipt.mimeType, total: receipt.size, offset, nextOffset: offset + bytesRead, version: receipt.version, name: receipt.name, sha256: receipt.sha256 }
  } finally { await file.close() }
}
