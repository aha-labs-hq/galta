import { useLayoutEffect, useRef, useState } from 'react'
import { CaptureUpdateAction, getCommonBounds } from '@excalidraw/excalidraw'
import type { CanvasScene } from './scene'
import { createAgentInvitation } from './agentInvitationScene'
import './agent-invitation.css'

const dismissalKey = 'galta.agent-invitation.dismissed'
const rememberDismissal = () => { try { localStorage.setItem(dismissalKey, 'true') } catch { /* Drawing does not require storage. */ } }
type Target = { action: string; label: string; x: number; y: number; width: number; height: number }

export function AgentInvitation({ scene, available, started, onConnect }: { scene: CanvasScene; available: boolean; started: boolean; onConnect(): void }) {
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(dismissalKey) === 'true' } catch { return false } })
  const [targets, setTargets] = useState<Target[]>([])
  const root = useRef<HTMLDivElement>(null)
  const connect = useRef(onConnect); connect.current = onConnect
  const shown = available && !started && !dismissed
  useLayoutEffect(() => {
    if (started) { rememberDismissal(); setDismissed(true) }
  }, [started])
  useLayoutEffect(() => {
    if (!shown) return
    let invitation = createAgentInvitation(scene.api.getAppState())
    let dimensions = '', pristine = true, signature = ''
    let regions: Target[] = []
    const versions = new Map<string, number>()
    const install = () => {
      scene.showGuide(invitation.elements)
      versions.clear()
      for (const el of invitation.elements) versions.set(el.id, el.version)
    }
    install()
    const update = () => {
      const state = scene.api.getAppState(), all = scene.api.getSceneElementsIncludingDeleted()
      if (!scene.hasGuide) { rememberDismissal(); setDismissed(true); return }
      if (all.some(el => versions.has(el.id) && (el.version !== versions.get(el.id) || el.isDeleted))) pristine = false
      const size = `${state.width}:${state.height}`
      if (dimensions && dimensions !== size && pristine) {
        invitation = createAgentInvitation(state)
        install()
      }
      dimensions = size
      const next = invitation.targets.flatMap(target => {
        const remaining = scene.api.getSceneElements().filter(el => invitation.actions.get(el.id) === target.action)
        if (!remaining.length) return []
        const [x1, y1, x2, y2] = getCommonBounds(remaining), z = state.zoom.value
        return [{ action: target.action, label: target.label, x: (x1 + state.scrollX) * z, y: (y1 + state.scrollY) * z, width: (x2 - x1) * z, height: (y2 - y1) * z }]
      })
      const nextSignature = JSON.stringify(next)
      regions = next
      if (nextSignature !== signature) { signature = nextSignature; setTargets(next) }
    }
    const stop = scene.api.onChange(update)
    const stopClick = scene.api.onPointerUp((tool, pointer, event) => {
      if (tool.type !== 'selection' || pointer.drag.hasOccurred || pointer.resize.isResizing || pointer.boxSelection.hasOccurred || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.button !== 0) return
      const action = pointer.hit.element && invitation.actions.get(pointer.hit.element.id)
      if (action) {
        scene.api.updateScene({ appState: { selectedElementIds: {}, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.NEVER })
        connect.current()
      }
    })
    // Retire system ink before the first drawing gesture. Erasing, selecting,
    // moving and styling existing guide ink are still handled by the editor.
    const canvas = root.current?.closest('.galta-canvas')
    const hover = (event: Event) => {
      const pointer = event as PointerEvent, bounds = canvas?.getBoundingClientRect()
      if (!bounds || !(canvas instanceof HTMLElement)) return
      const x = pointer.clientX - bounds.left, y = pointer.clientY - bounds.top
      const active = event.target instanceof HTMLCanvasElement && !pointer.buttons && !pointer.shiftKey && !pointer.metaKey && !pointer.ctrlKey && !pointer.altKey
        && scene.api.getAppState().activeTool.type === 'selection' && regions.some(t => x >= t.x && x <= t.x + t.width && y >= t.y && y <= t.y + t.height)
      canvas.toggleAttribute('data-guide-action', active)
    }
    const leave = () => canvas?.removeAttribute('data-guide-action')
    const drawing = (event: Event) => {
      if (!(event.target instanceof HTMLCanvasElement)) return
      const tool = scene.api.getAppState().activeTool.type
      if (['selection', 'hand', 'eraser', 'text'].includes(tool)) return
      rememberDismissal(); scene.dismissGuide(); setDismissed(true)
    }
    canvas?.addEventListener('pointerdown', drawing, true)
    canvas?.addEventListener('pointermove', hover, true)
    canvas?.addEventListener('pointerleave', leave)
    update()
    return () => { stop(); stopClick(); canvas?.removeEventListener('pointerdown', drawing, true); canvas?.removeEventListener('pointermove', hover, true); canvas?.removeEventListener('pointerleave', leave); leave(); scene.dismissGuide() }
  }, [scene, shown])
  if (!shown) return null
  return <div ref={root} className="agent-invitation" role="group" aria-label="Meet your canvas agent">
    <span className="sr-only">A sketch of Galta beside a web page: a picture dragged in, a request in the composer, a page, a film and a poster taking shape, and Time Machine. Bring your agent to the canvas. Your local agent. A shared canvas. Works with Codex, Claude Code and more.</span>
    {/* Unpainted keyboard/screen-reader targets. Native ink owns visible pixels
        and pointer hit testing; focus outlines are ordinary interface chrome. */}
    {targets.map(target => <button key={target.action} className="agent-invitation-target" type="button" aria-label={target.label}
      style={{ left: target.x, top: target.y, width: target.width, height: target.height }} onClick={() => connect.current()}>{target.label}</button>)}
  </div>
}
