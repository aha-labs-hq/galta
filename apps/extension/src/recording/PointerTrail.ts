const HISTORY = 512, STRIDE = 5
// Maximum screen-space interpolation error, in CSS pixels at 1x. This is a
// numerical accuracy bound, not a style parameter; retina tightens it further.
const ERROR = .125

/** Display geometry only. A bounded, allocation-free centripetal Catmull–Rom
 * ribbon. Time fade is evaluated by the GPU, so a stopped tail never rebuilds.
 * Coordinates sent to the agent remain the original pointer observations. */
export class PointerTrail {
  readonly vertices: Float32Array
  private samples: Float64Array
  private capacity: number
  private error: number
  version = 0
  count = 0
  readonly bounds = { left: 0, top: 0, right: 0, bottom: 0 }
  private history = new Float64Array(HISTORY * 5)
  private controls = new Float64Array(HISTORY * 4)
  private end = 0
  private used = 0
  private built = -1
  private newest = -Infinity
  private smoothX = 0
  private smoothY = 0
  constructor(readonly duration: number, readonly length: number, readonly width: number, private halo = 1, private smoothing = 0, scale = 1) {
    this.error = ERROR / Math.max(1, Math.min(2, scale))
    // For a centripetal segment of chord L, |tangent| <= 2L and
    // max |P''| <= 18L. Cauchy-Schwarz bounds the subdivision count over
    // every possible history; no dense-input truncation or per-frame allocation.
    this.capacity = HISTORY + Math.ceil(Math.sqrt(HISTORY * 18 * length / (8 * this.error))) + 1
    this.samples = new Float64Array(this.capacity * 6)
    this.vertices = new Float32Array(this.capacity * 2 * STRIDE)
  }
  clear() { this.used = 0; this.end = 0; this.count = 0; this.newest = -Infinity; this.version++ }
  add(x: number, y: number, t: number) {
    if (!Number.isFinite(x + y + t) || t < this.newest) return
    const previous = (this.end + HISTORY - 1) % HISTORY * 5
    if (this.used && Math.hypot(x - this.history[previous]!, y - this.history[previous + 1]!) < .75) return
    // Like the editor's eraser, lightly streamline the history. A time-based
    // response keeps the amount stable across event rates; the newest point
    // and native hotspot stay at the actual input coordinate.
    const blend = !this.used || !this.smoothing ? 1 : -Math.expm1(-(t - this.newest) / this.smoothing)
    this.smoothX += (x - this.smoothX) * blend; this.smoothY += (y - this.smoothY) * blend
    const slot = this.end * 5
    this.history[slot] = x; this.history[slot + 1] = y; this.history[slot + 2] = t
    this.history[slot + 3] = this.smoothX; this.history[slot + 4] = this.smoothY
    this.end = (this.end + 1) % HISTORY; this.used = Math.min(HISTORY, this.used + 1)
    this.newest = t; this.version++
  }
  /** Build only on input. Return interleaved vertices: position, signed edge
   * distance, birth time, opacity along the tail. */
  update(now: number) {
    if (now - this.newest >= this.duration || this.used < 2) { this.count = 0; return 0 }
    if (this.built === this.version) return this.count
    this.built = this.version
    let n = 0, total = 0
    const c = this.controls, s = this.samples
    for (let i = 0; i < this.used; i++) {
      const slot = (this.end + HISTORY - 1 - i) % HISTORY * 5
      const x = this.history[slot + (i ? 3 : 0)]!, y = this.history[slot + (i ? 4 : 1)]!, t = this.history[slot + 2]!
      if (n && this.newest - t > this.duration) break
      const d = n ? Math.hypot(x - c[(n - 1) * 4]!, y - c[(n - 1) * 4 + 1]!) : 0
      const fraction = d ? Math.min(1, (this.length - total) / d) : 1
      const j = n * 4
      c[j] = n ? c[j - 4]! + (x - c[j - 4]!) * fraction : x
      c[j + 1] = n ? c[j - 3]! + (y - c[j - 3]!) * fraction : y
      c[j + 2] = n ? c[j - 2]! + (t - c[j - 2]!) * fraction : t
      total += d * fraction; c[j + 3] = total; n++
      if (fraction < 1 || total >= this.length) break
    }
    if (n < 2 || total < 1) { this.count = 0; return 0 }
    let count = 0, lastDX = 0, lastDY = 0
    for (let i = 0; i < n - 1; i++) {
      const p = i * 4, q = p + 4
      const x1 = c[p]!, y1 = c[p + 1]!, x2 = c[q]!, y2 = c[q + 1]!
      const x0 = i ? c[p - 4]! : x1 * 2 - x2, y0 = i ? c[p - 3]! : y1 * 2 - y2
      const x3 = i + 2 < n ? c[q + 4]! : x2 * 2 - x1, y3 = i + 2 < n ? c[q + 5]! : y2 * 2 - y1
      const a = Math.sqrt(Math.max(.001, Math.hypot(x1 - x0, y1 - y0)))
      const b = Math.sqrt(Math.max(.001, Math.hypot(x2 - x1, y2 - y1)))
      const d = Math.sqrt(Math.max(.001, Math.hypot(x3 - x2, y3 - y2)))
      const mx1 = b * ((x1 - x0) / a - (x2 - x0) / (a + b) + (x2 - x1) / b)
      const my1 = b * ((y1 - y0) / a - (y2 - y0) / (a + b) + (y2 - y1) / b)
      const mx2 = b * ((x2 - x1) / b - (x3 - x1) / (b + d) + (x3 - x2) / d)
      const my2 = b * ((y2 - y1) / b - (y3 - y1) / (b + d) + (y3 - y2) / d)
      // The second derivative of a cubic is linear. Its maximum norm is
      // therefore bounded by the two endpoints; linear interpolation error
      // on a step h is <= max|P''| * h² / 8. Straight spans stay cheap, bends
      // gain samples, and analytical tangents avoid faceted ribbon edges.
      const ax = 2 * x1 - 2 * x2 + mx1 + mx2, ay = 2 * y1 - 2 * y2 + my1 + my2
      const bx = -3 * x1 + 3 * x2 - 2 * mx1 - mx2, by = -3 * y1 + 3 * y2 - 2 * my1 - my2
      const curvature = Math.max(Math.hypot(2 * bx, 2 * by), Math.hypot(6 * ax + 2 * bx, 6 * ay + 2 * by))
      const steps = Math.max(1, Math.ceil(Math.sqrt(curvature / (8 * this.error))))
      for (let k = 0; k < steps; k++) {
        const u = k / steps, j = count++ * 6
        s[j] = ((ax * u + bx) * u + mx1) * u + x1
        s[j + 1] = ((ay * u + by) * u + my1) * u + y1
        s[j + 2] = c[p + 2]! + (c[q + 2]! - c[p + 2]!) * u
        s[j + 3] = c[p + 3]! + (c[q + 3]! - c[p + 3]!) * u
        s[j + 4] = (3 * ax * u + 2 * bx) * u + mx1
        s[j + 5] = (3 * ay * u + 2 * by) * u + my1
      }
      lastDX = mx2; lastDY = my2
    }
    for (let k = 0; k < 4; k++) s[count * 6 + k] = c[(n - 1) * 4 + k]!
    s[count * 6 + 4] = lastDX; s[count * 6 + 5] = lastDY
    count++
    this.bounds.left = this.bounds.right = s[0]!; this.bounds.top = this.bounds.bottom = s[1]!
    for (let i = 0; i < count; i++) {
      const p = Math.max(0, i - 1) * 6, q = Math.min(count - 1, i + 1) * 6, j = i * 6
      let dx = -s[j + 4]!, dy = -s[j + 5]!, distance = Math.hypot(dx, dy)
      if (distance < .01) { dx = s[p]! - s[q]!; dy = s[p + 1]! - s[q + 1]!; distance = Math.max(.01, Math.hypot(dx, dy)) }
      const fade = Math.max(0, 1 - s[j + 3]! / total), half = this.width * .5
      const extent = half + this.halo + 1
      this.bounds.left = Math.min(this.bounds.left, s[j]!); this.bounds.right = Math.max(this.bounds.right, s[j]!)
      this.bounds.top = Math.min(this.bounds.top, s[j + 1]!); this.bounds.bottom = Math.max(this.bounds.bottom, s[j + 1]!)
      for (let side = 0; side < 2; side++) {
        const sign = side ? -1 : 1, v = (i * 2 + side) * STRIDE
        this.vertices[v] = s[j]! - dy / distance * extent * sign
        this.vertices[v + 1] = s[j + 1]! + dx / distance * extent * sign
        this.vertices[v + 2] = extent * sign
        this.vertices[v + 3] = s[j + 2]!; this.vertices[v + 4] = fade * Math.min(1, total / 8)
      }
    }
    this.count = count * 2
    return this.count
  }
}
