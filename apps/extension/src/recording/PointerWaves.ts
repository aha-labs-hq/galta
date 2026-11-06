export const MAX_POINTER_WAVES = 8
type WaveStyle = { radius: number; band: number; dot: number; duration: number; attack: number; release: number; interval: number; spacing: number; reach: number; travelRelease: number }
const smooth = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t) }

/** A moving emitter, not an animation attached to the cursor. Birth positions
 * stay in surface coordinates. Time or travelled distance emits the next wave;
 * cumulative travel fades old waves permanently, including after a reversal. */
export class PointerWaves {
  readonly data = new Float32Array(MAX_POINTER_WAVES * 4)
  readonly bounds = { left: 0, top: 0, right: 0, bottom: 0 }
  count = 0
  private births = new Float64Array(MAX_POINTER_WAVES * 5)
  private next = 0
  private x = 0
  private y = 0
  private time = -Infinity
  private observedAt = -Infinity
  private travel = 0
  private emittedAt = -Infinity
  private emittedTravel = 0
  private strength = 0
  constructor(private style: WaveStyle) { this.clear() }
  clear() {
    this.births.fill(-Infinity); this.data.fill(0); this.count = this.next = 0
    this.time = this.observedAt = this.emittedAt = -Infinity; this.travel = this.emittedTravel = this.strength = 0
  }
  private emit(x: number, y: number, time: number, travel: number) {
    const i = this.next * 5
    this.births[i] = x; this.births[i + 1] = y; this.births[i + 2] = time
    this.births[i + 3] = travel; this.births[i + 4] = this.strength
    this.next = (this.next + 1) % MAX_POINTER_WAVES
    this.emittedAt = time; this.emittedTravel = travel
  }
  move(x: number, y: number, time: number) {
    if (!Number.isFinite(x + y + time) || time < this.time) return
    if (this.time === -Infinity) { this.x = x; this.y = y; this.time = time; return }
    const distance = Math.hypot(x - this.x, y - this.y), end = this.travel + distance
    // Pointer events stop during a dwell. The latest display observation is
    // the start of a new move; do not age its births through that idle period.
    const fromTime = Math.min(time, Math.max(this.time, this.observedAt))
    if (this.strength > 0 && distance > 0) {
      // Skip already-expired emissions in a large input jump, keeping work
      // bounded. Every retained birth interpolates within an observed segment.
      let birth = this.emittedTravel + this.style.spacing
      if (birth < end - this.style.reach) birth += Math.ceil((end - this.style.reach - birth) / this.style.spacing) * this.style.spacing
      for (; birth <= end; birth += this.style.spacing) {
        const u = (birth - this.travel) / distance
        this.emit(this.x + (x - this.x) * u, this.y + (y - this.y) * u, fromTime + (time - fromTime) * u, birth)
      }
    }
    this.x = x; this.y = y; this.time = time; this.travel = end
  }
  update(now: number, strength: number) {
    this.observedAt = now
    const wasVoiced = this.strength > 0, style = this.style
    this.strength = strength
    if (strength > 0 && this.time !== -Infinity && (!wasVoiced || now - this.emittedAt >= style.interval)) this.emit(this.x, this.y, now, this.travel)
    this.count = 0; this.data.fill(0)
    for (let i = 0; i < MAX_POINTER_WAVES; i++) {
      const b = i * 5, w = i * 4, elapsed = now - this.births[b + 2]!, travelled = this.travel - this.births[b + 3]!
      if (elapsed < 0 || elapsed >= style.duration || travelled >= style.reach) continue
      const age = elapsed / style.duration
      const amplitude = this.births[b + 4]! * smooth(elapsed / style.attack)
        * (1 - smooth((elapsed - style.duration + style.release) / style.release))
        * (1 - smooth((travelled - style.reach + style.travelRelease) / style.travelRelease))
      if (amplitude <= .001) continue
      const x = this.births[b]!, y = this.births[b + 1]!
      const radius = style.dot + (style.radius - style.band - style.dot) * (1 - (1 - age) ** 2)
      this.data[w] = x; this.data[w + 1] = y; this.data[w + 2] = radius; this.data[w + 3] = amplitude
      const extent = radius + style.band
      if (!this.count++) { this.bounds.left = x - extent; this.bounds.right = x + extent; this.bounds.top = y - extent; this.bounds.bottom = y + extent }
      else { this.bounds.left = Math.min(this.bounds.left, x - extent); this.bounds.right = Math.max(this.bounds.right, x + extent); this.bounds.top = Math.min(this.bounds.top, y - extent); this.bounds.bottom = Math.max(this.bounds.bottom, y + extent) }
    }
    return this.count
  }
}
