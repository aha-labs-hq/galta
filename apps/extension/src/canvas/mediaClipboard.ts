import { CaptureUpdateAction } from '@excalidraw/excalidraw'
import { portableMedia } from './portableMedia'
import { cloneCanvasElement } from './cloneSnapshot'
import { sceneDocument, type CanvasScene } from './scene'

/** Use the editor's action registry so keyboard and context-menu copies share
 * one portable boundary. Geometry, selection, paste placement and deletion
 * remain native; only binary file serialization belongs to Galta. */
export function registerMediaClipboard(scene: CanvasScene) {
  for (const name of ['copy', 'cut'] as const) scene.api.registerAction({
    name, label: name === 'copy' ? 'labels.copy' : 'labels.cut', trackEvent: false,
    perform: async (_elements, _state, _event, app) => {
      const elements = app.scene.getSelectedElements({ selectedElementIds: app.state.selectedElementIds, includeBoundTextElement: true, includeElementsInFrames: true }).map(cloneCanvasElement)
      if (!elements.length) return false
      const document = sceneDocument(elements, scene.assets), ids = new Set(elements.map(el => el.id))
      const selection = scene.selectedIds.join('|')
      const revisions = elements.map(el => [el.id, el.versionNonce] as const), restoration = scene.restorationVersion
      try {
        const content = portableMedia({ kind: 'clipboard', document: { ...document, elements: elements.map(el => el.frameId && !ids.has(el.frameId) ? { ...el, frameId: null } : el) } })
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': content })])
        if (name === 'cut') {
          if (scene.disposed || restoration !== scene.restorationVersion || revisions.some(([id, nonce]) => scene.elements.find(el => el.id === id)?.versionNonce !== nonce) || selection !== scene.selectedIds.join('|')) throw new Error('Copied successfully. The selection changed, so it was not cut.')
          scene.api.executeAction('deleteSelectedElements')
        }
        return false
      } catch (error) {
        return { appState: { errorMessage: error instanceof Error ? error.message : 'Unable to copy media.' }, captureUpdate: CaptureUpdateAction.NEVER }
      }
    }
  })
}
