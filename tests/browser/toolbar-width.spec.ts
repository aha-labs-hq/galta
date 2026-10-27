import { test, expect } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { installReturningAccount } from '../helpers/canvas-port'

test.use({ video: 'on' })

for (const entry of ['sidepanel', 'canvas']) {
  for (const height of [800, 540]) test(`${entry} toolbar stays coherent throughout a width drag at ${height}px high`, { tag: '@serial' }, async ({ page }, info) => {
    await installReturningAccount(page)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => {
      const errors: string[] = []
      window.addEventListener('error', event => errors.push(event.message))
      ;(window as any).__layoutErrors = errors
    })
    await page.setViewportSize({ width: 1000, height })
    // Capture a fixed-size host while its child document resizes, as in a
    // native sidepanel. A changing capture resolution can drop transient frames.
    // Establish the real local network origin before replacing the host body;
    // a fully intercepted navigation has no local response address in Chrome.
    await page.goto(acceptanceOrigin)
    await page.setContent(`<html><style>body{margin:0;background:#fafafa}iframe{position:fixed;right:0;top:0;width:1000px;height:100%;border:0}</style><iframe title="Galta test sidebar" src="${acceptanceOrigin.replace('127.0.0.1', 'localhost')}/${entry}/index.html"></iframe></html>`)
    const input = page.frameLocator('iframe').getByRole('textbox', { name: 'Ask Galta', exact: true })
    await expect(input).toBeVisible()
    const view = page.frames().find(frame => frame.parentFrame() === page.mainFrame())!
    const draft = height === 800 ? '保持这个草稿。' : '调整宽度时，工具栏与自动折行的输入框应当始终保留足够的间距。'.repeat(2)
    await input.fill(draft)
    await expect.poll(() => view.evaluate(() => {
      const tools = document.querySelector('.drawing-dock')!.getBoundingClientRect()
      const composer = document.querySelector('.conversation-composer')!.getBoundingClientRect()
      return composer.top - tools.bottom
    })).toBeGreaterThanOrEqual(16)
    const capture = await page.context().newCDPSession(page)
    // DOM readiness can precede the child surface reaching the compositor.
    // Flush its completed opening paint before recording the resize; otherwise
    // screencast's initial cached frame can still show "Opening canvas…".
    await capture.send('Page.captureScreenshot', { format: 'png' })
    const frames: { data: string; timestamp: number | undefined }[] = []
    capture.on('Page.screencastFrame', frame => {
      frames.push({ data: frame.data, timestamp: frame.metadata.timestamp })
      void capture.send('Page.screencastFrameAck', { sessionId: frame.sessionId })
    })
    await capture.send('Page.startScreencast', { format: 'png', maxWidth: 1000, maxHeight: height, everyNthFrame: 1 })
    const painted = () => view.evaluate(() => {
      const workspace = document.querySelector('.galta-workspace')!
      const toolbar = document.querySelector<HTMLElement>('.drawing-dock')!
      const header = document.querySelector('.galta-topbar')!
      const composer = document.querySelector('.conversation-composer')!
      const read = () => {
        const bounds = workspace.getBoundingClientRect(), tools = toolbar.getBoundingClientRect()
        const prompt = composer.getBoundingClientRect()
        return { width: bounds.width, toolbarLeft: tools.left, workspaceLeft: bounds.left, viewportWidth: innerWidth, toolbarTop: tools.top, toolbarHeight: tools.height,
          headerHeight: header.getBoundingClientRect().height, composerHeight: prompt.height,
          gap: prompt.top - tools.bottom, overflow: toolbar.dataset.overflow,
          toolbarWidth: tools.width }
      }
      return new Promise<ReturnType<typeof read>>(resolve => requestAnimationFrame(() => {
        setTimeout(() => resolve(read()), 0)
      }))
    })
    const widths = height === 800
      ? Array.from({ length: 41 }, (_, i) => 660 - i * 2)
      : Array.from({ length: 65 }, (_, i) => 780 - i * 6)
    const samples: Awaited<ReturnType<typeof painted>>[] = [await painted()]
    // Resize the child viewport, not .galta-shell. The host captures output
    // independently while the child handles the new viewport bounds.
    for (const width of [...widths, ...widths.toReversed()]) {
      await page.evaluate(width => new Promise<void>(resolve => requestAnimationFrame(() => {
        document.querySelector('iframe')!.style.width = `${width}px`
        resolve()
      })), width)
      samples.push(await painted())
    }
    for (let frame = 0; frame < 3; frame++) samples.push(await painted())
    await capture.send('Page.stopScreencast')
    // Exclude the largest header and composer seen along the whole path. A
    // fixed bottom margin can accidentally count the multiline draft's black
    // background as a toolbar that has disappeared.
    const stripTop = Math.ceil(Math.max(...samples.map(sample => sample.headerHeight))) + 16
    const stripBottom = height - Math.ceil(Math.max(...samples.map(sample => sample.composerHeight))) - 16
    const expectedToolbarWidth = Math.min(...samples.map(sample => sample.toolbarWidth))
    const pixels = await page.evaluate(async ({ frames, stripTop, stripBottom }) => {
      const canvas = document.createElement('canvas'), context = canvas.getContext('2d')!
      const pixels: { frame: number; width: number; height: number; dark: number; icons: number; surfaceWidth: number }[] = []
      for (const [frame, data] of frames.entries()) {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob())
        canvas.width = bitmap.width; canvas.height = bitmap.height
        context.drawImage(bitmap, 0, 0)
        // This fixture's canvas is empty. Within the clear editing area, only
        // the toolbar can provide a contiguous dark band of its full width.
        const stripHeight = stripBottom - stripTop
        const strip = context.getImageData(0, stripTop, bitmap.width, stripHeight).data
        const columns = new Uint32Array(bitmap.width)
        let dark = 0, icons = 0
        for (let i = 0; i < strip.length; i += 4) {
          if (strip[i]! < 90 && strip[i + 1]! < 90 && strip[i + 2]! < 90) {
            dark++
            columns[(i / 4) % bitmap.width]!++
          }
          if (strip[i]! > 110 && strip[i]! < 230 && Math.abs(strip[i]! - strip[i + 1]!) < 12 && Math.abs(strip[i]! - strip[i + 2]!) < 12) icons++
        }
        let run = 0, surfaceWidth = 0
        for (const column of columns) {
          run = column >= Math.min(32, stripHeight / 4) ? run + 1 : 0
          surfaceWidth = Math.max(surfaceWidth, run)
        }
        pixels.push({ frame, width: bitmap.width, height: bitmap.height, dark, icons, surfaceWidth })
        bitmap.close()
      }
      return pixels
    }, { frames: frames.map(frame => frame.data), stripTop, stripBottom })
    const pixelReport = info.outputPath(`${entry}-width-pixels-${height}.json`)
    await writeFile(pixelReport, JSON.stringify(pixels.map((pixel, i) => ({ ...pixel, timestamp: frames[i]!.timestamp })), null, 2))
    await info.attach('visible-toolbar-frames', { path: pixelReport, contentType: 'application/json' })
    const missing = pixels.filter(pixel => pixel.dark < 2500 || pixel.icons < 80 || pixel.surfaceWidth < expectedToolbarWidth - 2)
    for (const pixel of missing) await writeFile(info.outputPath(`missing-toolbar-${pixel.frame}.png`), Buffer.from(frames[pixel.frame]!.data, 'base64'))
    expect(pixels.length, 'capture output frames throughout the resize').toBeGreaterThan(40)
    expect(missing, 'surface and icons must remain painted during viewport resize').toEqual([])
    const report = info.outputPath(`${entry}-width-drag-${height}.json`)
    await writeFile(report, JSON.stringify(samples, null, 2))
    await info.attach('width-drag-frames', { path: report, contentType: 'application/json' })
    await page.screenshot({ path: info.outputPath(`${entry}-width-drag-${height}.png`) })
    if (height === 800) {
      const jumps = samples.filter((sample, i) => i > 0 && Math.abs(sample.headerHeight - samples[i - 1]!.headerHeight) < .05
        && Math.abs(sample.composerHeight - samples[i - 1]!.composerHeight) < .05
        && Math.abs(sample.toolbarTop - samples[i - 1]!.toolbarTop) > 1)
      expect(jumps, 'width alone must not jump the toolbar vertically').toEqual([])
    }
    expect(samples.filter(sample => sample.gap < 15.95), 'every painted width must clear the draft').toEqual([])
    expect(samples.filter(sample => Math.abs(sample.toolbarLeft - sample.workspaceLeft - 8) > .05), 'every painted toolbar must retain its canvas-edge clearance').toEqual([])
    await expect(input).toHaveValue(draft)
    expect(await view.evaluate(() => (window as any).__layoutErrors)).toEqual([])
    expect(errors).toEqual([])
  })
}
