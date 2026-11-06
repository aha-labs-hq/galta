import { useEffect, useRef } from 'react'
import { themeColor, themeLength, themeNumber, themeTime } from '../design/theme'
import { CanvasPixels } from './CanvasPixels'
import { PointerTrail } from './PointerTrail'
import { PointerRenderer } from './PointerRenderer'
import { PointerWaves } from './PointerWaves'
import './recording.css'

/** The browser owns the real cursor. This disposable view draws only its
 * history and voice field, so a busy main thread cannot hold the hotspot back. */
export function RecordingPointer({ surface, active, level }: { surface: HTMLElement | null; active: boolean; level(): number }) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = root.current
    if (!active || !surface || !host) return
    const field = host.querySelector('canvas')!
    const reduced = matchMedia('(prefers-reduced-motion: reduce)'), forced = matchMedia('(forced-colors: active)')
    const radius = themeLength('--recording-ripple-radius'), band = themeLength('--recording-ripple-band')
    const rippleTime = themeTime('--recording-ripple-duration'), interval = themeTime('--recording-ripple-interval')
    const rippleAttack = themeTime('--recording-ripple-attack'), rippleRelease = themeTime('--recording-ripple-release'), minimumStrength = themeNumber('--recording-ripple-min-strength')
    const threshold = themeNumber('--recording-voice-threshold'), attack = themeTime('--recording-voice-attack'), release = themeTime('--recording-voice-release')
    const dot = themeLength('--recording-marker-size') / 2, stroke = themeLength('--stroke-surface')
    const ink = themeColor('recording-laser-ink'), core = themeColor('recording-laser-core'), extent = themeLength('--recording-field-radius')
    const halo = themeLength('--recording-trail-halo'), haloOpacity = themeNumber('--recording-trail-halo-opacity')
    const history = new PointerTrail(themeTime('--recording-trail-duration'), themeLength('--recording-trail-length'), themeLength('--recording-trail-stroke'), halo, themeTime('--recording-trail-smoothing'), devicePixelRatio)
    const pixels = new CanvasPixels(surface)
    const waves = new PointerWaves({ radius, band, dot, duration: rippleTime, attack: rippleAttack, release: rippleRelease, interval,
      spacing: themeLength('--recording-ripple-spacing'), reach: themeLength('--recording-ripple-reach'), travelRelease: themeLength('--recording-ripple-travel-release') })
    const origin = performance.now()
    // A small SVG with a declared hotspot uses the browser's cursor path rather
    // than a DOM element driven by animation frames. UI controls keep theirs.
    const hotspot = Math.ceil(dot + halo + stroke), size = hotspot * 2
    const cursor = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><defs><radialGradient id="light"><stop stop-color="${ink}" stop-opacity="${haloOpacity}"/><stop offset="1" stop-color="${ink}" stop-opacity="0"/></radialGradient></defs><circle cx="${hotspot}" cy="${hotspot}" r="${dot + halo}" fill="url(#light)"/><circle cx="${hotspot}" cy="${hotspot}" r="${dot}" fill="${ink}"/><circle cx="${hotspot}" cy="${hotspot}" r="${stroke}" fill="${core}"/></svg>`
    surface.style.setProperty('--recording-cursor', `url("data:image/svg+xml,${encodeURIComponent(cursor)}") ${hotspot} ${hotspot}, crosshair`)
    let renderer: PointerRenderer | undefined, attemptedGPU = false
    let frame = 0, wake = 0, lastPaint = 0, envelope = 0
    let clientX = 0, clientY = 0, drawing = false
    const leave = () => {
      cancelAnimationFrame(frame); clearTimeout(wake); frame = wake = 0; host.hidden = true; field.hidden = true
      delete surface.dataset.recordingPointer
      history.clear(); waves.clear(); envelope = 0; lastPaint = 0
    }
    const schedule = () => { clearTimeout(wake); wake = 0; if (!frame) frame = requestAnimationFrame(paint) }
    const paint = (timestamp: number) => {
      frame = 0
      if (reduced.matches) return
      const now = timestamp - origin, area = pixels.bounds, x = clientX - area.left, y = clientY - area.top
      const delta = lastPaint ? Math.max(0, now - lastPaint) : 1000 / 60; lastPaint = now
      const measured = Math.max(0, Math.min(1, level()))
      envelope += (measured - envelope) * -Math.expm1(-delta / (measured > envelope ? attack : release))
      if (envelope < .001) envelope = 0
      const count = history.update(now)
      // Display gain only. Capture and evidence retain their original values.
      const strength = envelope > threshold ? minimumStrength + (1 - minimumStrength) * Math.sqrt((envelope - threshold) / (1 - threshold)) : 0
      const voiced = waves.update(now, strength) > 0
      const visible = count > 0 || voiced
      if (visible && !attemptedGPU) {
        attemptedGPU = true
        renderer = PointerRenderer.create(field, { extent, band, ink, core, halo, haloOpacity, coreOpacity: themeNumber('--recording-trail-core-opacity'), displacement: themeLength('--recording-ripple-displacement'),
          contrast: themeNumber('--recording-ripple-contrast'), opacity: themeNumber('--recording-trail-opacity'), cacheMargin: themeLength('--recording-ripple-cache-margin') })
      }
      if (attemptedGPU && !renderer) { field.hidden = true; return }
      if (field.hidden === visible) field.hidden = !visible
      if (visible && renderer) {
        if (!renderer.draw(pixels, x, y, now, history, waves, drawing)) { renderer.dispose(); renderer = undefined; field.hidden = true; return }
        schedule()
      } else {
        // Stationary silence has no GPU work. Only listen for a voice onset;
        // pointer input wakes the display immediately, without waiting here.
        wake = window.setTimeout(schedule, 32)
      }
    }
    const move = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.excalidraw__canvas') || event.pointerType === 'touch' || forced.matches) { leave(); return }
      const rect = pixels.bounds, now = performance.now() - origin
      clientX = event.clientX; clientY = event.clientY; drawing = !!event.buttons
      if (!reduced.matches) {
        const coalesced = event.getCoalescedEvents?.()
        for (const point of coalesced?.length ? coalesced : [event]) {
          const x = point.clientX - rect.left, y = point.clientY - rect.top, time = Math.min(now, (point.timeStamp || now + origin) - origin)
          history.add(x, y, time); waves.move(x, y, time)
        }
      }
      if (host.hidden) { host.hidden = false; surface.dataset.recordingPointer = '' }
      if (!reduced.matches) schedule()
    }
    const visibility = () => { if (document.hidden) leave() }
    surface.addEventListener('pointermove', move, { capture: true, passive: true }); surface.addEventListener('pointerdown', move, true); surface.addEventListener('pointerup', move, true)
    surface.addEventListener('pointerleave', leave); window.addEventListener('blur', leave); document.addEventListener('visibilitychange', visibility)
    forced.addEventListener('change', leave); reduced.addEventListener('change', leave)
    return () => {
      surface.removeEventListener('pointermove', move, true); surface.removeEventListener('pointerdown', move, true); surface.removeEventListener('pointerup', move, true)
      surface.removeEventListener('pointerleave', leave); window.removeEventListener('blur', leave); document.removeEventListener('visibilitychange', visibility)
      forced.removeEventListener('change', leave); reduced.removeEventListener('change', leave)
      leave(); renderer?.dispose(); pixels.dispose(); surface.style.removeProperty('--recording-cursor')
    }
  }, [surface, active, level])
  return active ? <div ref={root} className="recording-pointer" hidden aria-hidden="true"><canvas className="recording-field" hidden /></div> : null
}
