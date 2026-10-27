import { test, expect, afterAll } from 'bun:test'
import { mkdtemp, mkdir, writeFile, symlink, readFile, realpath, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const root = await realpath(await mkdtemp(join(tmpdir(), 'galta-delete-')))
// Removed after this file's tests, even when one of them fails.
afterAll(() => rm(root, { recursive: true, force: true }))
process.env.GALTA_WORKSPACE_DIRECTORY = join(root, 'workspaces')
const { openCreativeWorkspace, removeCreativeWorkspace } = await import('../native/bridge/artifacts.ts')
const { CanvasRegistry } = await import('../native/bridge/registry.ts')
const { MemoryWorkspaceRepository } = await import('../packages/storage/dist/index.js')
const key = id => createHash('sha256').update(id).digest('hex').slice(0, 32)
const exists = path => stat(path).then(() => true, () => false)

test('a deleted canvas takes its working directory and delivery snapshots, and nothing else', async () => {
  const cwd = await openCreativeWorkspace('project-a'), other = await openCreativeWorkspace('project-b')
  await writeFile(join(cwd, 'outputs', 'image.png'), 'bytes')
  const deliveries = join(root, 'workspaces', '.deliveries', key('project-a'))
  await mkdir(deliveries, { recursive: true }); await writeFile(join(deliveries, 'receipt'), 'r')
  expect(await removeCreativeWorkspace('project-a')).toBe(true)
  expect(await exists(cwd)).toBe(false); expect(await exists(deliveries)).toBe(false)
  expect(await exists(other)).toBe(true)
  // Already gone is fine.
  expect(await removeCreativeWorkspace('project-a')).toBe(true)
})

test('the shared first-canvas directory is kept, and a redirected path is refused', async () => {
  const shared = await openCreativeWorkspace('default-project')
  expect(await removeCreativeWorkspace('default-project')).toBe(false)
  expect(await exists(shared)).toBe(true)
  const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep'), 'k')
  await symlink(outside, join(root, 'workspaces', key('project-link')))
  await expect(removeCreativeWorkspace('project-link')).rejects.toThrow('Nothing was removed')
  expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('k')
})

test('files stay while a view or an agent still uses the canvas', async () => {
  const registry = new CanvasRegistry(async () => ({}), async () => join(root, 'workspaces', 'x'))
  registry.register({ id: 'view-1', projectId: 'project-c', title: 'C' })
  expect(registry.inUse('project-c')).toBe(true)
  expect(registry.inUse('project-d')).toBe(false)
  await registry.unregister('view-1')
  expect(registry.inUse('project-c')).toBe(false)
})

test('only an archived canvas can be removed from storage', async () => {
  const repository = new MemoryWorkspaceRepository()
  const project = { id: 'p', title: 'P', commits: {}, branches: {}, headCommitId: 'c', activeBranchId: 'b', createdAt: 0, updatedAt: 0 }
  await repository.save({ project, captures: [], snapshots: {} })
  await expect(repository.remove('p')).rejects.toThrow('Archive')
  expect(await repository.load('p')).not.toBeNull()
  await repository.save({ project: { ...project, archivedAt: 1 }, captures: [], snapshots: {} })
  await repository.remove('p')
  expect(await repository.load('p')).toBeNull()
})

const { deleteCanvas } = await import('../apps/extension/src/canvas/canvasDeletion.ts')
function steps(files = async () => 'removed') {
  const order = []
  return { order, canvas: { title: 'Old idea',
    removeRecords: async () => { order.push('records') }, removeFiles: async () => { order.push('files'); return files() },
    removeDrafts: async () => { order.push('drafts') }, forget: async () => { order.push('forget') } } }
}

test('a canvas loses its records before anything else, so a refusal touches nothing', async () => {
  const done = steps()
  expect(await deleteCanvas(done.canvas)).toBeUndefined()
  expect(done.order).toEqual(['records', 'files', 'drafts', 'forget'])
  const refused = steps()
  refused.canvas.removeRecords = async () => { refused.order.push('records'); throw new Error('Archive this canvas before deleting it.') }
  await expect(deleteCanvas(refused.canvas)).rejects.toThrow('Archive')
  expect(refused.order).toEqual(['records'])
})

test('files that cannot go are reported, and the rest of the canvas still goes', async () => {
  const failing = steps(async () => { throw new Error('The app could not be reached: host has exited.') })
  expect(await deleteCanvas(failing.canvas)).toContain('“Old idea” is deleted, but Galta\'s app could not remove its files on this device. The app could not be reached')
  expect(failing.order).toEqual(['records', 'files', 'drafts', 'forget'])
  const shared = steps(async () => 'kept')
  expect(await deleteCanvas(shared.canvas)).toContain('first canvas')
  expect(await deleteCanvas(steps(async () => 'none').canvas)).toBeUndefined()
})
