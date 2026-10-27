import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, type Locator, type Page } from '@playwright/test'

export async function verifyArtifactDownload(page: Page, control: Locator, expected: Uint8Array, path: string, timeout = 15_000) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout }),
    control.click()
  ])
  assert.equal(await download.failure(), null, 'The browser download must finish successfully')
  await download.saveAs(path)
  const bytes = await readFile(path)
  assert(bytes.equals(Buffer.from(expected)), 'The saved download must match the requested source bytes')
  return { name: download.suggestedFilename(), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/** Only the OS picker/writable are substituted. The real download control,
 * receipt, native transfer and error presentation remain under test. */
export async function verifyArtifactPicker(page: Page, control: Locator, expected: Uint8Array) {
  try {
    for (const mode of ['save', 'write-failure', 'cancel'] as const) {
      await page.evaluate(mode => {
        const state = { mode, opened: false, closed: false, aborted: false, bytes: [] as number[] }
        Object.assign(window, { __galtaPickerTest: state })
        Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => {
          state.opened = true
          if (mode === 'cancel') throw new DOMException('Cancelled by test', 'AbortError')
          return { createWritable: async () => ({
            write: async (bytes: Uint8Array) => { if (mode === 'write-failure') throw new Error('Test disk write failed'); state.bytes = state.bytes.concat(Array.from(bytes)) },
            close: async () => { state.closed = true }, abort: async () => { state.aborted = true }
          }) }
        } })
      }, mode)
      await control.click()
      await expect.poll(() => page.evaluate(() => {
        const state = (window as any).__galtaPickerTest
        return state.opened && (state.mode === 'cancel' || state.closed || state.aborted)
      })).toBe(true)
      await expect(control).toHaveAttribute('aria-busy', 'false')
      const state = await page.evaluate(() => (window as any).__galtaPickerTest)
      assert.equal(state.opened, true)
      assert.equal(state.closed, mode === 'save')
      assert.equal(state.aborted, mode === 'write-failure')
      assert(Buffer.from(state.bytes).equals(mode === 'save' ? Buffer.from(expected) : Buffer.alloc(0)))
      if (mode === 'write-failure') await expect(control).toHaveAttribute('title', 'Download failed; try again')
    }
    return { savedBytesVerified: true, failedWriteAborted: true, cancelDidNotWrite: true, osDialog: false }
  } finally {
    await page.evaluate(() => { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }); delete (window as any).__galtaPickerTest })
  }
}
