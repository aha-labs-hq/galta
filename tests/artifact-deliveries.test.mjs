import { test, expect } from 'bun:test'
import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deliverArtifact } from '../native/bridge/artifacts.ts'
import { finalizeArtifacts, readDeliveryChunk } from '../native/bridge/deliveries.ts'

const owner = { projectId: 'project', threadId: 'thread', turnId: 'turn', messageId: 'message' }

test('Codex sandbox links preserve exact paths, bytes and receipt identity without escaping the workspace', async () => {
  const root = await mkdtemp('/tmp/galta-sandbox-link-'), workspace = join(root, 'workspace')
  await mkdir(workspace)
  const path = join(workspace, 'report % (日本語).txt'), bytes = Buffer.from('a non-image source\n')
  const href = `sandbox:${pathToFileURL(path).pathname}`
  await writeFile(path, bytes)
  await writeFile(join(root, 'outside.txt'), 'outside')
  await symlink(join(root, 'outside.txt'), join(workspace, 'escape.txt'))
  try {
    const results = await finalizeArtifacts([href, path], workspace, owner)
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('ready')
    expect(results[0].receipt.href).toBe(href)
    const chunk = await readDeliveryChunk(results[0].receipt, workspace, owner.projectId)
    expect(Buffer.from(chunk.dataBase64, 'base64')).toEqual(bytes)
    for (const invalid of [
      `sandbox:${root}/outside.txt`, `sandbox:${workspace}/escape.txt`,
      `sandbox:${workspace}/../outside.txt`, `sandbox:${workspace}/%2e%2e/outside.txt`,
      `sandbox:${workspace}%2Fescape.txt`, `${href}?download=1`, `${href}#fragment`,
      `sandbox://remote${path}`, 'sandbox:relative.txt'
    ]) {
      const [result] = await finalizeArtifacts([invalid], workspace, owner)
      expect(result.status).toBe('failed')
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('final-message links freeze exact bytes and require their receipt identity', async () => {
  const root = await mkdtemp(join('/tmp', 'galta-delivery-')), workspace = join(root, 'workspace'), outputs = join(workspace, 'outputs')
  await mkdir(outputs, { recursive: true })
  const path = join(outputs, 'selected image% (日本語).txt'), bytes = Buffer.from('selected bytes\n')
  await writeFile(path, bytes)
  try {
    const [result] = await finalizeArtifacts([path], workspace, owner)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw Error('delivery was not admitted')
    expect(result.receipt.href).toBe(path)
    expect(result.receipt.size).toBe(bytes.length)
    expect(result.receipt.sha256).toHaveLength(64)
    const chunks = [], first = await readDeliveryChunk(result.receipt, workspace, owner.projectId)
    chunks.push(Buffer.from(first.dataBase64, 'base64'))
    const second = first.nextOffset < first.total ? await readDeliveryChunk(result.receipt, workspace, owner.projectId, first.nextOffset, first.version) : null
    if (second) chunks.push(Buffer.from(second.dataBase64, 'base64'))
    expect(Buffer.concat(chunks)).toEqual(bytes)

    await writeFile(path, Buffer.from('changed original'))
    const replay = await readDeliveryChunk(result.receipt, workspace, owner.projectId)
    expect(Buffer.from(replay.dataBase64, 'base64')).toEqual(bytes)
    await expect(readDeliveryChunk({ ...result.receipt, messageId: 'other' }, workspace, owner.projectId)).rejects.toThrow('authorize')
    await expect(readDeliveryChunk(result.receipt, workspace, 'other-project')).rejects.toThrow('another canvas')
  } finally { await rm(root, { recursive: true, force: true }); await rm(join(root, '.deliveries'), { recursive: true, force: true }) }
})

test('empty and ordinary files are bounded, while traversal and symlink escapes fail', async () => {
  const root = await mkdtemp(join('/tmp', 'galta-delivery-boundary-')), workspace = join(root, 'workspace'), outputs = join(workspace, 'outputs')
  await mkdir(outputs, { recursive: true })
  const empty = join(outputs, 'empty.bin'), pdf = join(outputs, 'report.pdf'), outside = join(root, 'outside.txt')
  await Promise.all([writeFile(empty, ''), writeFile(pdf, '%PDF-1.7\n'), writeFile(outside, 'outside')])
  try {
    const [emptyResult, pdfResult] = await finalizeArtifacts([empty, pdf], workspace, owner)
    expect(emptyResult.status).toBe('ready'); expect(pdfResult.status).toBe('ready')
    if (emptyResult.status === 'ready') {
      const chunk = await readDeliveryChunk(emptyResult.receipt, workspace, owner.projectId)
      expect(chunk).toMatchObject({ total: 0, nextOffset: 0, dataBase64: '' })
    }
    if (pdfResult.status === 'ready') expect(pdfResult.receipt.mimeType).toBe('application/pdf')
    const [traversal] = await finalizeArtifacts(['../outside.txt'], workspace, owner)
    expect(traversal.status).toBe('failed')
    await symlink(outside, join(outputs, 'escape.txt'))
    const [escaped] = await finalizeArtifacts([join(outputs, 'escape.txt')], workspace, owner)
    expect(escaped.status).toBe('failed')
    const [external] = await finalizeArtifacts(['https://example.com/file.txt'], workspace, owner)
    expect(external.status).toBe('failed')
  } finally { await rm(root, { recursive: true, force: true }); await rm(join(root, '.deliveries'), { recursive: true, force: true }) }
})

test('canvas_deliver copies an exact source into the workspace without model path identity', async () => {
  const root = await mkdtemp(join('/tmp', 'galta-deliver-tool-')), workspace = join(root, 'workspace'), sources = join(workspace, 'sources')
  await mkdir(sources, { recursive: true })
  const bytes = Buffer.from('selected source bytes\n')
  await writeFile(join(sources, 'selected.txt'), bytes)
  const canonicalWorkspace = await realpath(workspace)
  try {
    const delivered = await deliverArtifact('galta-workspace:/sources/selected.txt', 'selected.txt', workspace)
    expect(delivered.path).toBe(join(canonicalWorkspace, 'selected.txt'))
    expect(delivered.artifactUri).toBe('galta-workspace:/selected.txt')
    expect(delivered.sourceArtifactUri).toBe('galta-workspace:/sources/selected.txt')
    expect(delivered.sha256).toHaveLength(64)
    expect(Buffer.from(await Bun.file(delivered.path).arrayBuffer())).toEqual(bytes)

    const nested = await deliverArtifact(delivered.artifactUri, 'outputs/selected.txt', workspace)
    expect(nested.artifactUri).toBe('galta-workspace:/outputs/selected.txt')
    expect(Buffer.from(await Bun.file(nested.path).arrayBuffer())).toEqual(bytes)
    await expect(deliverArtifact('galta-workspace:/sources/selected.txt', '../escape.txt', workspace)).rejects.toThrow('workspace-relative')
    await writeFile(join(workspace, 'selected.txt'), Buffer.from('different'))
    await expect(deliverArtifact('galta-workspace:/sources/selected.txt', 'selected.txt', workspace)).rejects.toThrow('different bytes')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('explicit delivery finalization freezes the declared source after destination mutation', async () => {
  const root = await mkdtemp(join('/tmp', 'galta-delivery-declaration-')), workspace = join(root, 'workspace'), sources = join(workspace, 'sources')
  await mkdir(sources, { recursive: true })
  const original = Buffer.from('bytes declared by the tool\n')
  await writeFile(join(sources, 'source.txt'), original)
  try {
    const declaration = await deliverArtifact('galta-workspace:/sources/source.txt', 'selected.txt', workspace)
    await writeFile(declaration.path, Buffer.from('bytes changed after the tool returned\n'))
    const [artifact] = await finalizeArtifacts([declaration.path], workspace, owner, [declaration])
    expect(artifact.status).toBe('ready')
    if (artifact.status !== 'ready') throw Error('delivery was not admitted')
    expect(artifact.receipt.artifactUri).toBe(declaration.artifactUri)
    const chunk = await readDeliveryChunk(artifact.receipt, workspace, owner.projectId)
    expect(Buffer.from(chunk.dataBase64, 'base64')).toEqual(original)
    expect(artifact.receipt.sha256).toBe(declaration.sha256)
  } finally { await rm(root, { recursive: true, force: true }); await rm(join(root, '.deliveries'), { recursive: true, force: true }) }
})

test('equivalent managed and absolute links produce one receipt', async () => {
  const root = await mkdtemp(join('/tmp', 'galta-delivery-dedupe-')), workspace = join(root, 'workspace'), outputs = join(workspace, 'outputs')
  await mkdir(outputs, { recursive: true })
  const path = join(outputs, 'selected.txt')
  await writeFile(path, 'same bytes')
  try {
    const artifacts = await finalizeArtifacts([path, 'galta-workspace:/outputs/selected.txt'], workspace, owner)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].status).toBe('ready')
  } finally { await rm(root, { recursive: true, force: true }); await rm(join(root, '.deliveries'), { recursive: true, force: true }) }
})

test('an outside destination symlink is rejected before creating directories', async () => {
  const root = await mkdtemp(join('/tmp', 'galta-delivery-parent-')), workspace = join(root, 'workspace'), sources = join(workspace, 'sources'), outside = join(root, 'outside')
  await mkdir(sources, { recursive: true }); await mkdir(outside, { recursive: true })
  await writeFile(join(sources, 'source.txt'), 'source')
  await symlink(outside, join(workspace, 'linked'))
  try {
    await expect(deliverArtifact('galta-workspace:/sources/source.txt', 'linked/new-directory/file.txt', workspace)).rejects.toThrow('outside this workspace')
    const exists = await Bun.file(join(outside, 'new-directory', 'file.txt')).exists()
    expect(exists).toBe(false)
    expect(await Bun.file(join(outside, 'new-directory')).exists()).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
