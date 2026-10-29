import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { CaptureUpdateAction, Excalidraw, MainMenu, getCommonBounds } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { CanvasScene } from './scene'
import { defaultDrawingFont } from './drawingDefaults'
import { allowCanvasShortcut } from './canvasShortcuts'
import { HTML_EMBED_LINK, HtmlEmbed, htmlDocument } from './htmlEmbed'
import { ObjectLabels } from './ObjectLabels'
import '@excalidraw/excalidraw/index.css'
import './canvasEditor.css'
import { registerMediaClipboard } from './mediaClipboard'
import { readPortableAssets } from './portableMedia'
import { VIDEO_LINK, isVideoLink } from '@galta/canvas'
import { activateVideo, videoData } from './video'
import { VideoPlayer } from './VideoPlayer'

// Fonts are packaged with the extension. No runtime CDN or remote code.
window.EXCALIDRAW_ASSET_PATH = new URL('../', location.href).href

const PASSIVE_TOAST_DURATION = 1500
const EXPORT_COLOR_SCHEME_SUFFIX = /\n\((?:Light|Dark) mode\)$/

export const ExcalidrawCanvas = memo(function ExcalidrawCanvas({ onMount, readOnly = false }: { onMount: (scene: CanvasScene) => (() => void) | undefined | Promise<(() => void) | undefined>; readOnly?: boolean }) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const [engine, setEngine] = useState<HTMLElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sceneRef = useRef<CanvasScene | null>(null)
  /** The editor's own box: the engine, its labels and its notices. */
  const editor = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden')
  useEffect(() => {
    const change = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  }, [])
  const exitVideo = useCallback(() => {
    api?.updateScene({ appState: { activeEmbeddable: null }, captureUpdate: CaptureUpdateAction.NEVER })
    editor.current?.querySelector<HTMLElement>(':scope > .excalidraw')?.focus({ preventScroll: true })
  }, [api])
  const allowShortcut = (event: KeyboardEvent) => {
    // A native media control owns its own keys, including seek and volume.
    if (event.target instanceof HTMLElement && event.target.closest('.canvas-video')) return false
    if (!allowCanvasShortcut(event)) return false
    if (event.key !== 'Enter' && !((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k')) return true
    const scene = sceneRef.current, selected = scene?.selected
    // Local pages carry a renderer marker, not a user-editable hyperlink.
    if (event.key.toLowerCase() === 'k' && selected?.length === 1 && htmlDocument(selected[0]!)) return false
    if (!scene || selected?.length !== 1 || !videoData(selected[0]!)) return true
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      if (event.type === 'keydown') activateVideo(scene, selected[0]!)
    }
    return false
  }
  useEffect(() => {
    if (!api) return
    const scene = new CanvasScene(api, editor.current ?? undefined)
    sceneRef.current = scene
    setEngine(editor.current?.querySelector<HTMLElement>(':scope > .excalidraw') ?? null)
    registerMediaClipboard(scene)
    let cleanup: (() => void) | undefined
    let connected = false
    let cancelled = false
    const connect = () => {
      // The API exists before initializeScene resolves. Restoring earlier is
      // overwritten by Excalidraw's initial empty scene on the next render.
      if (connected || api.getAppState().isLoading) return
      connected = true
      // initializeScene registers the bundled fonts. Load the fonts used by
      // Galta before measuring restored/agent text: fallback-font widths clip
      // the final glyphs after Excalifont replaces the fallback on first open.
      void Promise.all([
        document.fonts.load(`20px "${defaultDrawingFont.name}"`),
        document.fonts.load('20px Excalifont', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'),
        document.fonts.load('20px Cascadia')
      ]).then(async () => {
        if (cancelled) return
        const release = await onMount(scene)
        if (cancelled) release?.()
        else cleanup = release
      })
        .catch(error => { if (!cancelled) setError(`Unable to load drawing fonts. ${String(error)}`) })
    }
    const stop = api.onChange(connect)
    const stopChromeNormalization = api.onChange((_, appState) => {
      if (appState.showHyperlinkPopup) {
        const selected = scene.selected
        if (selected.length === 1 && (htmlDocument(selected[0]!) || videoData(selected[0]!))) {
          api.updateScene({ appState: { showHyperlinkPopup: false }, captureUpdate: CaptureUpdateAction.NEVER })
          return
        }
      }
      const toast = appState.toast
      if (!toast) return
      // Galta has one fixed canvas theme. Excalidraw appends its own light/dark
      // export label, which would imply a theme switch that Galta does not offer.
      const message = toast.message.replace(EXPORT_COLOR_SCHEME_SUFFIX, '')
      // Excalidraw defaults non-interactive confirmations to five seconds.
      // Galta keeps the canvas visible behind the engine, so that duration
      // makes a simple copy confirmation linger over the workspace.
      const duration = toast.duration ?? (toast.closable === true ? undefined : PASSIVE_TOAST_DURATION)
      if (message === toast.message && duration === toast.duration) return
      api.updateScene({ appState: { toast: { ...toast, message, ...(duration === undefined ? {} : { duration }) } }, captureUpdate: CaptureUpdateAction.NEVER })
    })
    connect()
    return () => { cancelled = true; stop(); stopChromeNormalization(); cleanup?.(); scene.disposed = true; scene.clearPresentation() }
  }, [api, onMount])
  return <div ref={editor} className="canvas-editor"><Excalidraw excalidrawAPI={setApi} langCode="en" theme="light" zenModeEnabled viewModeEnabled={readOnly}
    onPaste={async data => {
      const scene = sceneRef.current
      if (!scene || !data.elements) return true
      const restoration = scene.restorationVersion
      try {
        const files = data.files ? await readPortableAssets(data.files) : undefined
        if (scene.disposed || sceneRef.current !== scene || scene.restorationVersion !== restoration) return false
        scene.prepare(data.elements, { ...scene.assets, ...files })
        data.elements = data.elements.map(el => videoData(el) ? { ...el, link: VIDEO_LINK } : el)
        if (files) data.files = scene.importAssets(files)
        return true
      }
      catch (error) { setError(`Unable to paste media. ${String(error)}`); return false }
    }}
    validateEmbeddable={link => (link === HTML_EMBED_LINK || isVideoLink(link)) ? true : undefined}
    renderEmbeddable={(element, state) => {
      const video = videoData(element), scene = sceneRef.current
      if (video && scene) {
        const [x1, y1, x2, y2] = getCommonBounds([element]), z = state.zoom.value
        const inView = x2 >= -state.scrollX && y2 >= -state.scrollY && x1 < -state.scrollX + state.width / z && y1 < -state.scrollY + state.height / z
        return <VideoPlayer key={video.fileId} video={video} source={scene.asset(video.fileId)} poster={scene.asset(video.posterId)} engaged={state.activeEmbeddable?.element.id === element.id && state.activeEmbeddable.state === 'active'} visible={visible && inView} selected={Boolean(state.selectedElementIds[element.id])} onExit={exitVideo} />
      }
      const document = htmlDocument(element); return document ? <HtmlEmbed html={document.html} /> : null
    }}
    onLinkOpen={(element, event) => {
      if (element.type !== 'embeddable' || !htmlDocument(element) && !videoData(element)) return
      event.preventDefault()
      api?.updateScene({ appState: { activeEmbeddable: { element, state: 'active' } } })
    }}
    // The artwork is drawn on a transparent scene over the paper and its grain (excalidraw.css).
    initialData={{ appState: { viewBackgroundColor: 'transparent', currentItemStrokeColor: '#39332e', currentItemFontFamily: defaultDrawingFont.family, currentItemRoughness: 1, boxSelectionMode: 'overlap' } }}
    UIOptions={{ allowKeyboardShortcut: allowShortcut, canvasActions: { changeViewBackgroundColor: false, clearCanvas: false, export: false, loadScene: false, saveToActiveFile: false, toggleTheme: false } }}
  ><MainMenu /></Excalidraw>{api && engine && <ObjectLabels api={api} root={engine} />}{error && <div className="canvas-notice glass-surface" role="alert">{error}</div>}</div>
})
