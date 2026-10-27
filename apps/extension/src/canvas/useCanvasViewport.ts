import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { CanvasScene } from './scene'
import { canvasBounds, canvasFrame } from './useCanvasInsets'
import { focusSelection, focusViewport, type FocusViewport } from './canvasViewNavigation'

/** Restore after the editor leaves its initial read-only state. The engine
 * clears selection when that mode changes, and selection changes chrome height. */
export function useCanvasViewport(scene: CanvasScene | null, shell: RefObject<HTMLElement | null>, draftReady: boolean, changed: () => void, onError: (message: string) => void) {
  const [ready, setReady] = useState(false)
  const presentRef = useRef<(viewport: FocusViewport) => void>(() => {})
  const present = useCallback((viewport: FocusViewport) => presentRef.current(viewport), [])
  useEffect(() => {
    const root = shell.current
    if (!scene || !root || !draftReady) return
    setReady(false)
    let selection: string[], viewport: ReturnType<typeof focusViewport>
    try {
      const ids = new Set(scene.elements.map(element => element.id))
      selection = focusSelection().filter(id => ids.has(id))
      viewport = focusViewport()
    } catch (error) { onError(String(error)); return }
    let frame = canvasFrame(root), bounds = canvasBounds(root)
    const compactConversation = () => Boolean(root.querySelector('.conversation-dock.connection-only'))
    let compact = compactConversation()
    let framedWhileCompact = false
    let pendingViewport: FocusViewport | undefined
    const frameView = (viewport: FocusViewport) => {
      // Hidden tabs have stale Chrome layout. Retain the world-space intent
      // and apply it when the receiving tab actually becomes visible.
      pendingViewport = viewport
      if (document.visibilityState === 'hidden') return
      frame = canvasFrame(root); bounds = canvasBounds(root)
      framedWhileCompact = compactConversation()
      scene.frameViewport(viewport, frame); pendingViewport = undefined
    }
    presentRef.current = frameView
    let phase: 'editor' | 'selection' | 'layout' | 'ready' = 'editor', readyFrame = 0
    const restore = () => {
      if (phase === 'editor') {
        const state = scene.api.getAppState()
        if (state.isLoading || state.viewModeEnabled) return
        phase = 'selection'
        scene.select(selection)
      }
      if (phase !== 'selection' || scene.selectedIds.length !== selection.length || selection.some(id => !scene.selectedIds.includes(id))) return
      phase = 'layout'
      const finish = () => {
        frame = canvasFrame(root); bounds = canvasBounds(root)
        if (viewport) {
          frameView(viewport)
          const address = new URL(location.href), params = new URLSearchParams(address.hash.slice(1))
          params.delete('viewport')
          address.hash = params.toString(); history.replaceState(null, '', address)
          changed()
        }
        phase = 'ready'; setReady(true)
      }
      if (document.visibilityState === 'hidden') finish()
      else readyFrame = requestAnimationFrame(finish)
    }
    const unsubscribe = scene.api.onChange(restore)
    restore()
    const validBounds = (value: DOMRect) => value.width > 0 && value.height > 0
    let wakeFrame = 0
    const observer = new ResizeObserver(() => {
      if (document.visibilityState === 'hidden') return
      const nextBounds = canvasBounds(root)
      // Chromium can report a transient zero-sized side panel while the
      // neighboring tab is being replaced. Never turn that intermediate
      // layout into a camera update.
      if (!validBounds(nextBounds)) return
      const next = canvasFrame(root), resized = nextBounds.width !== bounds.width || nextBounds.height !== bounds.height
      const nextCompact = compactConversation()
      // An explicit viewport can hydrate before its account reconnects.
      // Reframe that temporary compact reference when the composer appears;
      // ordinary reload uses its saved camera and draft growth stays stationary.
      const reconnectingView = framedWhileCompact && compact !== nextCompact
      const viewport = phase === 'ready' && (resized || reconnectingView) ? scene.captureViewport(frame) : null
      frame = next; bounds = nextBounds; compact = nextCompact
      if (reconnectingView && !nextCompact) framedWhileCompact = false
      if (viewport) { scene.frameViewport(viewport, frame); changed() }
    })
    observer.observe(root)
    const workspace = root.querySelector('.galta-workspace')
    if (workspace) observer.observe(workspace)
    // Composer edits update the reference frame without moving artwork.
    for (const chrome of root.querySelectorAll('.galta-topbar,.conversation-composer')) observer.observe(chrome)
    const wake = () => {
      if (document.visibilityState !== 'visible' || phase !== 'ready') return
      cancelAnimationFrame(wakeFrame)
      wakeFrame = requestAnimationFrame(() => {
        wakeFrame = 0
        if (document.visibilityState !== 'visible' || phase !== 'ready') return
        const nextBounds = canvasBounds(root)
        if (!validBounds(nextBounds)) return
        const resized = nextBounds.width !== bounds.width || nextBounds.height !== bounds.height
        // A visibility change alone does not require a camera update.
        if (!pendingViewport && !resized) return
        frameView(pendingViewport ?? scene.captureViewport(frame)); changed()
      })
    }
    document.addEventListener('visibilitychange', wake)
    return () => { unsubscribe(); cancelAnimationFrame(readyFrame); cancelAnimationFrame(wakeFrame); observer.disconnect(); document.removeEventListener('visibilitychange', wake) }
  }, [scene, shell, draftReady, changed, onError])
  return { ready, present }
}
