import { test, expect } from '@playwright/test'

test('a captured view can be saved as the exact reference an agent generates from', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const w = window as any, t = w.engineTest
    const writes: Array<{ path: string; data: string; mimeType: string }> = []
    w.testArtifacts.writeArtifact = async (path: string, data: string, mimeType: string) => { writes.push({ path, data, mimeType }) }
    const { structuredContent: before } = await t.tool('canvas_inspect', {})
    await t.tool('canvas_edit', { revision: before.revision, operations: [{ type: 'create_text', text: 'A house with a round window', x: 0, y: 0 }] })
    const plain = await t.tool('canvas_capture', { scope: 'canvas' })
    const writesAfterPlain = writes.length
    const saved = await t.tool('canvas_capture', { scope: 'canvas', file: true })
    let invalid = ''
    try { await t.tool('canvas_capture', { scope: 'canvas', file: 'yes' }) } catch (error) { invalid = String(error) }
    return { plainPath: plain.structuredContent.path ?? null, writesAfterPlain, saved: saved.structuredContent, image: saved.content[0].data, writes, invalid }
  })
  // A plain look writes nothing; asking for a file saves exactly the pixels the agent saw.
  expect(result.plainPath).toBeNull()
  expect(result.writesAfterPlain).toBe(0)
  expect(result.writes).toHaveLength(1)
  const [write] = result.writes
  expect(write.path).toMatch(/^\/tmp\/galta-test\/sources\/[0-9a-f]{64}\.jpg$/)
  expect(write.mimeType).toBe('image/jpeg')
  expect(write.data).toBe(result.image)
  expect(result.saved.path).toBe(write.path)
  expect(result.saved.artifactUri).toMatch(/^galta-workspace:\/sources\/[0-9a-f]{64}\.jpg$/)
  expect(result.saved.evidence.sha256).toBe(write.path.slice(-68, -4))
  expect(result.invalid).toContain('file must be true or false')
})
