import { test, expect } from 'bun:test'
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deliverArtifact, readArtifactChunk, readImageArtifact, readHtmlArtifact, readVideoChunk, writeArtifact, writeImageArtifact } from '../native/bridge/artifacts.ts'

test('source image formats preserve exact bytes through extraction, readback and delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'galta-source-formats-')), sources = join(root, 'sources')
  await mkdir(sources)
  const fixtures = [
    { mimeType: 'image/gif', extension: 'gif', bytes: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') },
    { mimeType: 'image/svg+xml', extension: 'svg', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#2463ae"/></svg>') },
    { mimeType: 'image/svg+xml', extension: 'svg', bytes: Buffer.from(`<?xml version="1.0"?><!--${'source metadata '.repeat(100)}--><svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><circle r="20"/></svg>`) }
  ]
  for (const [mimeType, extension] of [['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/avif', 'avif'], ['image/bmp', 'bmp'], ['image/vnd.microsoft.icon', 'ico']]) {
    fixtures.push({ mimeType, extension, bytes: await readFile(new URL(`./fixtures/source-image.${extension}`, import.meta.url)) })
  }
  try {
    for (const [index, fixture] of fixtures.entries()) {
      const name = `original-${index}.${fixture.extension}`, path = join(sources, name)
      await writeArtifact(path, fixture.bytes.toString('base64'), fixture.mimeType, root)
      expect(await readFile(path)).toEqual(fixture.bytes)
      expect((await readImageArtifact(path, root)).dataUrl).toBe(`data:${fixture.mimeType};base64,${fixture.bytes.toString('base64')}`)
      const source = `galta-workspace:/sources/${name}`
      const chunk = await readArtifactChunk(source, root)
      expect(chunk.mimeType).toBe(fixture.mimeType)
      expect(Buffer.from(chunk.dataBase64, 'base64')).toEqual(fixture.bytes)
      const delivery = await deliverArtifact(source, `copy-${name}`, root)
      expect(delivery.mimeType).toBe(fixture.mimeType)
      expect(await readFile(delivery.path)).toEqual(fixture.bytes)
      await expect(writeArtifact(join(sources, `wrong-${index}.png`), fixture.bytes.toString('base64'), fixture.mimeType, root)).rejects.toThrow('Invalid image')
      await expect(writeArtifact(join(sources, `mismatch-${index}.${fixture.extension}`), fixture.bytes.toString('base64'), 'image/png', root)).rejects.toThrow('Invalid image')
    }
    for (const text of ['not XML', '<html><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/></html>', '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>']) {
      await expect(writeArtifact(join(sources, 'invalid.svg'), Buffer.from(text).toString('base64'), 'image/svg+xml', root)).rejects.toThrow('Invalid image')
    }
  } finally { await rm(root, { recursive: true }) }
})

test('image artifacts are real images confined to the creative workspace; symlink escapes fail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'galta-artifact-test-'))
  const cwd = join(root, 'project')
  await mkdir(cwd)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8uoAAAAASUVORK5CYII=', 'base64')
  const inside = join(cwd, 'output.png'), outside = join(root, 'other.png')
  await writeFile(inside, png); await writeFile(outside, png)
  try {
    expect((await readImageArtifact(inside, cwd)).dataUrl).toBe('data:image/png;base64,' + png.toString('base64'))
    await expect(readImageArtifact(outside, cwd)).rejects.toThrow('does not belong')
    await symlink(outside, join(cwd, 'escape.png'))
    await expect(readImageArtifact(join(cwd, 'escape.png'), cwd)).rejects.toThrow('does not belong')
    await writeFile(join(cwd, 'fake.png'), 'not an image')
    await expect(readImageArtifact(join(cwd, 'fake.png'), cwd)).rejects.toThrow('not a supported')
    await expect(readImageArtifact('relative.png', cwd)).rejects.toThrow('absolute')
  } finally { await rm(root, { recursive: true }) }
})

test('HTML artifacts are bounded UTF-8 documents confined to the creative workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'galta-html-test-')), cwd = join(root, 'project')
  await mkdir(cwd)
  const path = join(cwd, 'page.html'), html = '<!doctype html><html><body>画布<script>1+1</script></body></html>'
  try {
    await writeFile(path, html)
    expect(await readHtmlArtifact(path, cwd)).toEqual({ html })
    await writeFile(join(root, 'outside.html'), html)
    await symlink(join(root, 'outside.html'), join(cwd, 'escape.html'))
    await expect(readHtmlArtifact(join(cwd, 'escape.html'), cwd)).rejects.toThrow('does not belong')
    await expect(readHtmlArtifact('page.html', cwd)).rejects.toThrow('absolute')
    await writeFile(path, '<html>' + 'x'.repeat(4_000_000))
    await expect(readHtmlArtifact(path, cwd)).rejects.toThrow('exceeds 4 MB')
    await writeFile(path, Buffer.from([0xff, 0xfe]))
    await expect(readHtmlArtifact(path, cwd)).rejects.toThrow()
    await writeFile(path, 'not a document')
    await expect(readHtmlArtifact(path, cwd)).rejects.toThrow('complete HTML')
  } finally { await rm(root, { recursive: true }) }
})

test('image exports reuse identical files without following links or overwriting changed sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'galta-export-test-')), sources = join(root, 'sources')
  await mkdir(sources)
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8uoAAAAASUVORK5CYII='
  try {
    const path = join(sources, 'export.png'), outside = join(root, 'outside.png')
    await writeImageArtifact(path, png, root)
    expect((await readFile(path)).toString('base64')).toBe(png)
    await Promise.all([writeImageArtifact(path, png, root), writeImageArtifact(path, png, root)])
    expect((await readFile(path)).toString('base64')).toBe(png)
    await writeFile(path, 'changed by a host command')
    await expect(writeImageArtifact(path, png, root)).rejects.toThrow('changed')
    expect(await readFile(path, 'utf8')).toBe('changed by a host command')
    await expect(writeImageArtifact(join(sources, 'empty.png'), '', root)).rejects.toThrow('Invalid')
    await expect(writeImageArtifact(outside, png, root)).rejects.toThrow('sources')
    await writeFile(outside, 'preserve')
    await symlink(outside, join(sources, 'link.png'))
    await expect(writeImageArtifact(join(sources, 'link.png'), png, root)).rejects.toThrow()
    expect(await readFile(outside, 'utf8')).toBe('preserve')
    await rm(sources, { recursive: true }); await mkdir(join(root, 'elsewhere')); await symlink(join(root, 'elsewhere'), sources)
    await expect(writeImageArtifact(join(sources, 'escape.png'), png, root)).rejects.toThrow('sources')
  } finally { await rm(root, { recursive: true }) }
})


test('video chunks are bounded, confined and reject changing sources without returning mixed bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'galta-video-artifact-')), cwd = join(root, 'workspace')
  await mkdir(cwd)
  try {
    const bytes = Buffer.concat([await readFile(new URL('./fixtures/canvas-video.webm', import.meta.url)), Buffer.alloc(500_000)])
    const path = join(cwd, 'movie.webm')
    await writeFile(path, bytes)
    const first = await readVideoChunk(path, cwd)
    expect(first.nextOffset).toBe(384_000)
    expect(first.dataBase64.length).toBeLessThanOrEqual(512_000)
    const second = await readVideoChunk(path, cwd, first.nextOffset, first.version)
    expect(Buffer.concat([Buffer.from(first.dataBase64, 'base64'), Buffer.from(second.dataBase64, 'base64')])).toEqual(bytes)
    await writeFile(path, Buffer.concat([bytes, Buffer.from([0])]))
    await expect(readVideoChunk(path, cwd, first.nextOffset, first.version)).rejects.toThrow('changed')
    const outside = join(root, 'outside.webm'); await writeFile(outside, bytes)
    await symlink(outside, join(cwd, 'escape.webm'))
    await expect(readVideoChunk(join(cwd, 'escape.webm'), cwd)).rejects.toThrow('does not belong')
    await expect(readVideoChunk(path, cwd, -1)).rejects.toThrow('offset')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('managed artifact references stream exact bytes, fence versions and reject path escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'galta-managed-artifact-')), cwd = join(root, 'workspace'), sources = join(cwd, 'sources')
  await mkdir(sources, { recursive: true })
  const bytes = Buffer.concat([Buffer.from('<!doctype html><html><body>'), Buffer.alloc(500_000, 65), Buffer.from('</body></html>')])
  const path = join(sources, 'selected.html'), uri = 'galta-workspace:/sources/selected.html'
  try {
    await writeFile(path, bytes)
    const chunks = []
    let firstOffset = 0
    let offset = 0, version
    do {
      const chunk = await readArtifactChunk(uri, cwd, offset, version)
      expect(chunk.mimeType).toBe('text/html')
      expect(chunk.offset).toBe(offset)
      expect(chunk.nextOffset).toBe(offset + Buffer.from(chunk.dataBase64, 'base64').length)
      chunks.push(Buffer.from(chunk.dataBase64, 'base64'))
      if (!firstOffset) firstOffset = chunk.nextOffset
      offset = chunk.nextOffset; version = chunk.version
    } while (offset < bytes.length)
    expect(Buffer.concat(chunks)).toEqual(bytes)
    expect(version).toBeTruthy()
    await expect(readArtifactChunk(uri, cwd, 1)).rejects.toThrow('changed')
    await writeFile(path, Buffer.concat([bytes, Buffer.from('changed')]))
    await expect(readArtifactChunk(uri, cwd, firstOffset, version)).rejects.toThrow('changed')

    const outside = join(root, 'outside.html')
    await writeFile(outside, bytes)
    await symlink(outside, join(sources, 'escape.html'))
    await expect(readArtifactChunk('galta-workspace:/sources/escape.html', cwd)).rejects.toThrow('does not belong')
    await expect(readArtifactChunk(join(cwd, 'sources', 'selected.html'), cwd)).rejects.toThrow('managed Galta artifact')
    await expect(readArtifactChunk('file:///tmp/selected.html', cwd)).rejects.toThrow('managed Galta artifact')
    await expect(readArtifactChunk('galta-workspace:/../outside.html', cwd)).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
