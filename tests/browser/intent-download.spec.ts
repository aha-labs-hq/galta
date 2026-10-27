import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { verifyArtifactDownload } from '../../scripts/lib/canvas-intent-download'

test('download acceptance requires the browser to save the exact requested bytes', async ({ page }, info) => {
  await page.setContent('<button>Download</button>')
  const control = page.getByRole('button', { name: 'Download' })
  await expect(verifyArtifactDownload(page, control, Buffer.from('expected'), info.outputPath('missing.txt'), 300)).rejects.toThrow('Timeout')
  await page.evaluate(() => {
    document.querySelector('button')!.onclick = () => {
      const anchor = document.createElement('a')
      anchor.download = 'actual.txt'
      anchor.href = URL.createObjectURL(new Blob(['actual bytes']))
      anchor.click()
    }
  })
  await expect(verifyArtifactDownload(page, control, Buffer.from('wrong bytes'), info.outputPath('wrong.txt'))).rejects.toThrow('must match')
  const path = info.outputPath('correct.txt')
  const result = await verifyArtifactDownload(page, control, Buffer.from('actual bytes'), path)
  expect(result).toMatchObject({ name: 'actual.txt', size: 12 })
  expect(await readFile(path, 'utf8')).toBe('actual bytes')
})
