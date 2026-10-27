export type SourceView = { documentId: string; url: string; windowWidth: number; viewport: { width: number; height: number; scrollX: number; scrollY: number } }

export function validateSourceView(value: unknown): asserts value is SourceView {
  const v = value as SourceView
  if (!v || typeof v.documentId !== 'string' || !v.documentId || typeof v.url !== 'string' || !v.viewport
    || ![v.windowWidth, v.viewport.width, v.viewport.height, v.viewport.scrollX, v.viewport.scrollY].every(Number.isFinite)
    || v.windowWidth <= 0 || v.viewport.width <= 0 || v.viewport.height <= 0) throw new Error('Invalid source page view.')
}

/** A document replacement or navigation owns its new reading position. */
export async function restoreSourceView(saved: SourceView, current: () => SourceView) {
  validateSourceView(saved)
  const matches = () => { const live = current(); return live.documentId === saved.documentId && live.url === saved.url }
  if (!matches()) return { status: 'changed' as const }
  // Chrome animates its native sidebar after open() resolves. Restoring while
  // the source is still wider clamps horizontal scrolling. Wait for the saved
  // sidebar width, adjusted for any browser-window resize, across two paints.
  await new Promise<void>((resolve, reject) => {
    let frame = 0, ready = 0
    const finish = (error?: Error) => { clearTimeout(timer); cancelAnimationFrame(frame); error ? reject(error) : resolve() }
    const timer = setTimeout(() => finish(new Error('The source page did not finish reopening. Your canvas is still open.')), 2000)
    const check = () => {
      if (!matches()) { finish(); return }
      const live = current(), width = saved.viewport.width + live.windowWidth - saved.windowWidth
      ready = live.viewport.width === width ? ready + 1 : 0
      if (ready === 2) finish()
      else frame = requestAnimationFrame(check)
    }
    frame = requestAnimationFrame(check)
  })
  if (!matches()) return { status: 'changed' as const }
  window.scrollTo({ left: saved.viewport.scrollX, top: saved.viewport.scrollY, behavior: 'instant' })
  return { status: 'restored' as const, viewport: current().viewport }
}
