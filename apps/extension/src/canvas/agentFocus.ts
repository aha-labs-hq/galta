import { createContext, useContext, useSyncExternalStore } from 'react'
import type { CanvasChangeRegion } from '@galta/domain'
import { themeLength } from '../design/theme'
import { bearing, frameRegion, inView, visibleRect, type WorldRect } from './flight'
import type { CanvasFrame, CanvasScene } from './scene'

// Bearings move an arrow; finer steps than this re-render without a visible turn.
const BEARING_STEP = 3

/** Where the agent worked, as the reader sees it. One per canvas view. It
 * answers whether a change is in view and which way it lies, flies the camera
 * there when the reader asks, and lights the change when it arrives. It never
 * moves the camera on its own, and any pointer or wheel gesture on the canvas
 * takes the camera back mid-flight. */
export class CanvasLocator {
  private readonly listeners = new Set<() => void>()
  private readonly markListeners = new Set<() => void>()
  private flight: AbortController | null = null
  private pending = 0
  private version = 0
  private latest: { region: CanvasChangeRegion; key: number } | null = null
  private readonly release: () => void

  constructor(private readonly scene: CanvasScene, private readonly frame: () => CanvasFrame, private readonly surface: HTMLElement) {
    const moved = () => {
      if (this.pending) return
      this.pending = requestAnimationFrame(() => { this.pending = 0; this.version++; for (const listener of this.listeners) listener() })
    }
    const stopScroll = scene.api.onScrollChange(moved)
    const resize = new ResizeObserver(moved)
    resize.observe(surface)
    const interrupt = () => this.flight?.abort()
    surface.addEventListener('pointerdown', interrupt, true)
    surface.addEventListener('wheel', interrupt, { capture: true, passive: true })
    this.release = () => {
      stopScroll(); resize.disconnect(); cancelAnimationFrame(this.pending); this.flight?.abort()
      surface.removeEventListener('pointerdown', interrupt, true)
      surface.removeEventListener('wheel', interrupt, { capture: true })
    }
  }

  /** Camera changes, delivered at most once per frame. */
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getVersion = () => this.version

  /** Degrees clockwise from up, from the centre of the clear frame to the
   * region, or null when the reader can already see it. */
  bearing(region: CanvasChangeRegion): number | null {
    const frame = this.frame(), view = this.scene.captureViewport(frame)
    return inView(region.bounds, visibleRect(view, frame)) ? null : bearing(region.bounds, view)
  }

  /** Show the reader a region: light it where it is when it is in view,
   * otherwise fly there along the smooth zoom path and light it on arrival. */
  async locate(region: CanvasChangeRegion) {
    if (this.bearing(region) === null) return this.mark(region)
    this.flight?.abort()
    const flight = this.flight = new AbortController(), frame = this.frame()
    const target = frameRegion(region.bounds, frame, this.scene.captureViewport(frame), themeLength('--locate-margin'))
    await this.scene.flyTo(target, frame, flight.signal)
    if (this.flight === flight) this.flight = null
    if (!flight.signal.aborted) this.mark(region)
  }

  /** Light a region where it is, without moving the camera. */
  mark(region: CanvasChangeRegion) {
    this.latest = { region, key: (this.latest?.key ?? 0) + 1 }
    for (const listener of this.markListeners) listener()
  }
  subscribeMarks = (listener: () => void) => { this.markListeners.add(listener); return () => { this.markListeners.delete(listener) } }
  getMark = () => this.latest

  /** Whether a rectangle on the surface, in CSS pixels, shows any of itself. */
  onScreen(box: { x: number; y: number; width: number; height: number }) {
    return box.x < this.surface.clientWidth && box.y < this.surface.clientHeight && box.x + box.width > 0 && box.y + box.height > 0
  }

  /** A world rectangle on the canvas surface, in CSS pixels. */
  onSurface(bounds: WorldRect) {
    const { scrollX, scrollY, zoom } = this.scene.api.getAppState()
    return { x: (bounds.x + scrollX) * zoom.value, y: (bounds.y + scrollY) * zoom.value, width: bounds.width * zoom.value, height: bounds.height * zoom.value }
  }

  close() { this.release() }
}

/** Locating within one surface: the canvas view's locator, and how that
 * surface takes the reader to it. Absent where no canvas is mounted. */
export type Locating = { locator: CanvasLocator; locate(region: CanvasChangeRegion): void }
export const LocatorContext = createContext<Locating | null>(null)
export function useLocating() { return useContext(LocatorContext) }

/** Which way a region lies, kept current as the camera moves; null when the
 * reader can see it or nothing can be located. */
export function useBearing(locator: CanvasLocator | null, region: CanvasChangeRegion | undefined): number | null {
  return useSyncExternalStore(locator?.subscribe ?? noSubscription, () => {
    if (!locator || !region) return null
    const value = locator.bearing(region)
    return value === null ? null : Math.round(value / BEARING_STEP) * BEARING_STEP % 360
  })
}
const noSubscription = () => () => {}
