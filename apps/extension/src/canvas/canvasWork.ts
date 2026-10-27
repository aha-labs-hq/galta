/** Share one time slice across preparation and presentation. Yield to browser
 * tasks (not just microtasks) so input and cancellation can run between slices.
 * This is a scheduling budget, never a limit on accepted artwork.
 */
export class CanvasWork {
  private deadline = performance.now() + 5
  constructor(readonly signal: AbortSignal) {}

  check() { this.signal.throwIfAborted() }

  async checkpoint() {
    this.check()
    if (performance.now() < this.deadline) return
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    this.check()
    this.deadline = performance.now() + 5
  }
}
