/** Read lazily, after CSS is mounted. Never duplicate theme literals in engine
 * initialization or raster exports; an absent theme is a configuration error. */
export function themeColor(name: 'background' | 'foreground' | 'muted-foreground' | 'border-strong' | 'surface-hover' | 'mark-ink' | 'mark-paper'): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim()
  if (!value) throw new Error(`Galta theme is missing --${name}`)
  return value
}

/** A font-family token, for text drawn into a raster rather than the DOM. */
export function themeFont(name: 'font-ui' | 'font-code'): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim()
  if (!value) throw new Error(`Galta theme is missing --${name}`)
  return value
}

/** A length token in pixels, for geometry the DOM cannot measure directly.
 * Returns the number, not the string, because callers do arithmetic with it. */
export function themeLength(name: string): number {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name))
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Galta theme is missing ${name}`)
  return value
}

/** A time token in milliseconds, read where it applies so element-scoped
 * motion and the reduced-motion override both resolve. CSS minification may
 * rewrite 360ms as .36s; the unit is converted explicitly. */
export function themeTime(name: string, element: Element = document.documentElement): number {
  const value = getComputedStyle(element).getPropertyValue(name).trim()
  const time = /^(\d+(?:\.\d+)?|\.\d+)(ms|s)$/.exec(value)
  if (!time) throw new Error(`Galta theme is missing the time ${name}`)
  return Number(time[1]) * (time[2] === 's' ? 1000 : 1)
}

/** A unitless token, such as a fraction of a motion, read where it applies. */
export function themeNumber(name: string, element: Element = document.documentElement): number {
  const value = Number.parseFloat(getComputedStyle(element).getPropertyValue(name))
  if (!Number.isFinite(value)) throw new Error(`Galta theme is missing the number ${name}`)
  return value
}

/** An easing token, read where it applies. */
export function themeEasing(name: string, element: Element = document.documentElement): string {
  const value = getComputedStyle(element).getPropertyValue(name).trim()
  if (!value) throw new Error(`Galta theme is missing the easing ${name}`)
  return value
}
