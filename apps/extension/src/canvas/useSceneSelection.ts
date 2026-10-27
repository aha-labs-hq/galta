import { useEffect, useState } from 'react'
import type { CanvasScene } from './scene'

/** Chrome derives from Excalidraw; pointer-only changes do not redraw it. */
export function useSceneSelection(scene: CanvasScene) {
  const read = () => {
    const state = scene.api.getAppState(), selected = scene.selected
    const signature = JSON.stringify([selected.map(el => [el.id, el.version, el.versionNonce]), state.selectedGroupIds, state.editingGroupId, state.scrollX, state.scrollY, state.zoom.value, state.width, state.height, state.offsetLeft, state.offsetTop, state.selectedElementsAreBeingDragged, state.isResizing, state.isRotating, state.isCropping, state.croppingElementId, Boolean(state.editingTextElement), state.activeTool.type, state.activeEmbeddable?.state === 'active' ? state.activeEmbeddable.element.id : null])
    return { selected, state, signature }
  }
  const [view, setView] = useState(read)
  useEffect(() => {
    const update = () => { const next = read(); setView(previous => previous.signature === next.signature ? previous : next) }
    update()
    return scene.api.onChange(update)
  }, [scene])
  return view
}
