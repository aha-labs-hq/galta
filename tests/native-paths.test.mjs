import { test, expect } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareGaltaDataDirectory } from '../native/dataDirectory.ts'
import { resolveGaltaPaths } from '../native/paths.ts'
import { canonicalManagedArtifactReference, isAbsoluteArtifactPath, joinArtifactPath, managedArtifactReference, resolveManagedArtifactPath } from '../packages/canvas/src/artifactPaths.ts'

test('managed data paths follow each operating system convention', () => {
  expect(resolveGaltaPaths({ platform: 'darwin', home: '/Users/ada', env: {} })).toMatchObject({
    dataDirectory: '/Users/ada/Library/Application Support/Galta',
    binaryDirectory: '/Users/ada/Library/Application Support/Galta/bin',
    runtimeDirectory: '/Users/ada/Library/Application Support/Galta/runtime',
    workspaceDirectory: '/Users/ada/Library/Application Support/Galta/workspaces',
    legacyDataDirectories: ['/Users/ada/.local/share/galta']
  })
  expect(resolveGaltaPaths({ platform: 'win32', home: 'C:\\Users\\Ada', env: { LOCALAPPDATA: 'D:\\Profiles\\Ada\\AppData\\Local' } })).toMatchObject({
    dataDirectory: 'D:\\Profiles\\Ada\\AppData\\Local\\Galta',
    binaryDirectory: 'D:\\Profiles\\Ada\\AppData\\Local\\Galta\\bin',
    runtimeDirectory: 'D:\\Profiles\\Ada\\AppData\\Local\\Galta\\runtime',
    workspaceDirectory: 'D:\\Profiles\\Ada\\AppData\\Local\\Galta\\workspaces',
    legacyDataDirectories: []
  })
  expect(resolveGaltaPaths({ platform: 'linux', home: '/home/ada', env: { XDG_DATA_HOME: '/data/ada' } })).toMatchObject({
    dataDirectory: '/data/ada/galta', legacyDataDirectories: ['/home/ada/.local/share/galta']
  })
  expect(() => resolveGaltaPaths({ platform: 'win32', home: 'C:\\Users\\Ada', env: {} })).toThrow('LOCALAPPDATA')
  expect(() => resolveGaltaPaths({ platform: 'linux', home: '/home/ada', env: { XDG_DATA_HOME: 'relative' } })).toThrow('XDG_DATA_HOME')
})

test('artifact paths remain native and old managed paths rebase to the current workspace', () => {
  const key = '335782039d9f5dd5d8d37133401787d8'
  const mac = `/Users/ada/Library/Application Support/Galta/workspaces/${key}`
  const win = `C:\\Users\\Ada\\AppData\\Local\\Galta\\workspaces\\${key}`
  expect(joinArtifactPath(mac, 'sources', 'image.png')).toBe(`${mac}/sources/image.png`)
  expect(joinArtifactPath(win, 'outputs', 'page.html')).toBe(`${win}\\outputs\\page.html`)
  expect(managedArtifactReference(`${mac}/outputs/page with space.html`, mac)).toBe('galta-workspace:/outputs/page%20with%20space.html')
  expect(managedArtifactReference(`${win}\\sources\\image.png`, win)).toBe('galta-workspace:/sources/image.png')
  expect(canonicalManagedArtifactReference(`/Users/ada/.local/share/galta/workspaces/${key}/outputs/page.html`)).toBe('galta-workspace:/outputs/page.html')
  expect(resolveManagedArtifactPath(`/Users/ada/.local/share/galta/workspaces/${key}/outputs/page.html`, mac)).toBe(`${mac}/outputs/page.html`)
  expect(resolveManagedArtifactPath(`C:\\old\\galta\\workspaces\\${key}\\sources\\image.png`, win)).toBe(`${win}\\sources\\image.png`)
  expect(resolveManagedArtifactPath('galta-workspace:/outputs/page%20with%20space.html', mac)).toBe(`${mac}/outputs/page with space.html`)
  expect(resolveManagedArtifactPath('/tmp/unrelated/page.html', mac)).toBe('/tmp/unrelated/page.html')
  expect(resolveManagedArtifactPath(`/tmp/workspaces/${key}/unrelated.html`, mac)).toBe(`/tmp/workspaces/${key}/unrelated.html`)
  expect(isAbsoluteArtifactPath('/tmp/page.html')).toBe(true)
  expect(isAbsoluteArtifactPath('C:\\Temp\\page.html')).toBe(true)
  expect(isAbsoluteArtifactPath('relative/page.html')).toBe(false)
})

test('legacy data migration is one atomic move and discards stale bridge discovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'galta-data-migration-'))
  const legacy = join(root, 'legacy'), destination = join(root, 'Application Support', 'Galta')
  try {
    await mkdir(join(legacy, 'workspaces', 'project', 'outputs'), { recursive: true })
    await mkdir(join(legacy, 'bridges'))
    await writeFile(join(legacy, 'workspaces', 'project', 'outputs', 'kept.txt'), 'kept')
    await writeFile(join(legacy, 'bridges', 'stale.json'), JSON.stringify({ pid: 2_147_483_647 }))
    expect(await prepareGaltaDataDirectory({ dataDirectory: destination, legacyDataDirectories: [legacy] })).toEqual({ directory: destination, migratedFrom: legacy })
    expect(await readFile(join(destination, 'workspaces', 'project', 'outputs', 'kept.txt'), 'utf8')).toBe('kept')
    await expect(readFile(join(destination, 'bridges', 'stale.json'))).rejects.toThrow()
    await expect(readFile(join(legacy, 'workspaces', 'project', 'outputs', 'kept.txt'))).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('migration refuses active writers and conflicting roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'galta-data-conflict-'))
  const legacy = join(root, 'legacy'), destination = join(root, 'current')
  try {
    await mkdir(join(legacy, 'bridges'), { recursive: true })
    await writeFile(join(legacy, 'bridges', 'active.json'), JSON.stringify({ pid: process.pid }))
    await expect(prepareGaltaDataDirectory({ dataDirectory: destination, legacyDataDirectories: [legacy] })).rejects.toThrow('Close every open Galta canvas')
    await rm(join(legacy, 'bridges'), { recursive: true })
    await mkdir(destination)
    await writeFile(join(destination, 'state'), 'current')
    await expect(prepareGaltaDataDirectory({ dataDirectory: destination, legacyDataDirectories: [legacy] })).rejects.toThrow('exists in both')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('an empty destination does not manufacture a migration conflict', async () => {
  const root = await mkdtemp(join(tmpdir(), 'galta-empty-destination-'))
  const legacy = join(root, 'legacy'), destination = join(root, 'current')
  try {
    await mkdir(join(legacy, 'workspaces'), { recursive: true })
    await writeFile(join(legacy, 'workspaces', 'kept'), 'kept')
    await mkdir(destination)
    expect(await prepareGaltaDataDirectory({ dataDirectory: destination, legacyDataDirectories: [legacy] })).toEqual({ directory: destination, migratedFrom: legacy })
    expect(await readFile(join(destination, 'workspaces', 'kept'), 'utf8')).toBe('kept')
  } finally { await rm(root, { recursive: true, force: true }) }
})
