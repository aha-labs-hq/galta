import { useLayoutEffect, type RefObject } from 'react'
import { unfoldingHeight } from '../components/Unfold'
import { themeLength } from '../design/theme'
import type { CanvasFrame } from './scene'

/** The clear editing area, measured from the same controls that reserve layout.
 * Its breath comes from the spacing scale rather than private pixels: `--space-4`
 * at the edges, three times that below the artwork to clear a control's own
 * shoulders. An inset nobody can look up drifts the moment a control changes. */
const edgeInset = '--space-4', clearanceFactor = 3

/** Layout owns the editor's actual bounds; a docked library is outside them. */
export function canvasBounds(root: HTMLElement) {
  return (root.querySelector('.galta-workspace') ?? root).getBoundingClientRect()
}

export function canvasFrame(root: HTMLElement): CanvasFrame {
  const bounds = canvasBounds(root)
  const header = root.querySelector('.galta-topbar')?.getBoundingClientRect()
  const composer = root.querySelector('.conversation-composer')?.getBoundingClientRect()
  const tools = root.querySelector('.drawing-dock')?.getBoundingClientRect()
  const inset = themeLength(edgeInset), clearance = inset * clearanceFactor
  const left = (tools ? tools.right - bounds.left : 0) + inset
  const right = inset
  const top = (header?.height ?? 0) + inset
  const bottom = bounds.height - (composer?.height ?? 0) - clearance
  return { left, top, width: Math.max(1, bounds.width - left - right), height: Math.max(1, bottom - top) }
}

/** What the reader can see right now, where new work lands so it is seen
 * arriving: the clear frame less the reading sheet while it is open. The camera
 * keeps the clear frame, which stays put as the conversation opens and closes. */
export function visibleCanvasFrame(root: HTMLElement): CanvasFrame {
  const frame = canvasFrame(root)
  // The sheet rises when a request is sent, and work can land before it has
  // finished: what counts is the height it is rising to.
  const sheet = root.querySelector('.conversation-presence')
  return { ...frame, height: Math.max(1, frame.height - (sheet ? unfoldingHeight(sheet) : 0)) }
}

/** Whether the centred composer would reach the settings corner: then the
 * corner rests on the composer, otherwise the composer's slide stops short of
 * it. `cornerEdge` is the published `--corner-edge`. Judged from widths at the
 * centre, so sliding never moves the corner and both sides agree in any order. */
export function composerReachesCorner(workspaceWidth: number, composerWidth: number, cornerEdge: number) {
  return (workspaceWidth - composerWidth) / 2 < cornerEdge
}

/** One layout owner publishes reservations and toolbar overflow before paint.
 * Observe the composer container, above the toolbar scroll viewport in the
 * tree, so the resized viewport receives its notification in the same
 * delivery cycle. The toolbar itself is an output of this measurement. */
export function useCanvasInsets(shell: RefObject<HTMLElement | null>, ready: boolean) {
  useLayoutEffect(() => {
    const root = shell.current, composer = root?.querySelector('.conversation-composer'), header = root?.querySelector('.galta-topbar')
    const conversation = root?.querySelector('.conversation-dock'), workspace = root?.querySelector('.galta-workspace')
    if (!root || !composer || !header || !conversation || !workspace) return
    const measure = () => {
      const composerHeight = composer.getBoundingClientRect().height
      // The settings corner centres on the composer's footer line unless the
      // centred composer would reach it; then it rests on the composer. Judged
      // at the centre, so sliding the composer never moves the corner.
      // The corner's right edge plus the composer's gap is published as
      // `--corner-edge`; the composer reads that value, not the corner.
      const corner = root.querySelector<HTMLElement>('.settings-corner'), area = workspace.getBoundingClientRect()
      let settingsBottom = '', edge = ''
      if (corner) {
        const cornerEdge = corner.offsetLeft + corner.offsetWidth + themeLength('--space-3')
        const reaches = composerReachesCorner(area.width, conversation.getBoundingClientRect().width, cornerEdge)
        const line = (composer.querySelector('.composer-footer') ?? composer).getBoundingClientRect()
        settingsBottom = `${reaches ? composerHeight + themeLength('--space-2') : area.bottom - (line.top + line.height / 2) - corner.offsetHeight / 2}px`
        edge = `${cornerEdge}px`
      }
      for (const [name, value] of [['--composer-height', `${composerHeight}px`], ['--header-height', `${header.getBoundingClientRect().height}px`], ['--settings-bottom', settingsBottom], ['--corner-edge', edge]] as const) {
        if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value)
      }
      const tools = root.querySelector<HTMLElement>('.drawing-dock')
      if (!tools) return
      const style = getComputedStyle(tools)
      const padding = Number.parseFloat(style.getPropertyValue('--dock-padding'))
      const gap = Number.parseFloat(style.getPropertyValue('--dock-preferred-group-gap'))
      const groups = [...tools.querySelectorAll('.drawing-tool-group')]
      const fullHeight = groups.reduce((height, group) => height + group.getBoundingClientRect().height, 0) + (groups.length - 1) * gap + padding * 2
      // The dock clears both the composer and the settings corner above it.
      const floor = Math.min(workspace.getBoundingClientRect().bottom - composerHeight, corner?.getBoundingClientRect().top ?? Infinity)
      const available = floor - themeLength(edgeInset) - tools.getBoundingClientRect().top
      // Pushed up by the composer, the dock's room equals its own height, so an
      // exact fit is common; half a pixel keeps sub-pixel noise from flipping it.
      const overflow = String(fullHeight - available > .5)
      if (tools.dataset.overflow !== overflow) tools.dataset.overflow = overflow
    }
    const observer = new ResizeObserver(measure)
    for (const input of [workspace, header, conversation]) observer.observe(input)
    measure()
    return () => observer.disconnect()
  }, [shell, ready])
}
