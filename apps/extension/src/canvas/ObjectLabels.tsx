import { useEffect, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { AppWindow, Film, Image } from 'lucide-react'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { themeLength } from '../design/theme'
import { htmlDocument } from './htmlEmbed'
import { labelledKind, objectLabel, type LabelledKind } from './objectLabel'
import { formatDuration, videoData } from './video'
import './object-labels.css'

const ICONS = { page: AppWindow, image: Image, video: Film } satisfies Record<LabelledKind, unknown>

type Shown = { id: string; kind: LabelledKind; title: string | undefined; caption: string | undefined; spec: string | undefined; file: string | undefined; zoom: number; left: number; top: number; width: number; height: number; angle: number }

/** Every page sits under a browser bar with its file name, part of the page
 * and scaled with it. A page, image or video's own words are drawn beside it
 * at reading size: the title in a quiet header above and the caption below. The layer joins the engine's own stack, over drawn artwork
 * and under pages, videos and the selection, so handles stay visible. It
 * follows the camera at most once per frame, takes no input, and is never
 * document or export content. */
export function ObjectLabels({ api, root }: { api: ExcalidrawImperativeAPI; root: HTMLElement }) {
  const [layer, setLayer] = useState<HTMLElement | null>(null)
  const [shown, setShown] = useState<readonly Shown[]>([])
  useEffect(() => {
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        setLayer(root.querySelector('canvas.excalidraw__canvas.interactive')?.parentElement ?? null)
        setShown(labels(api.getSceneElements(), api.getAppState()))
      })
    }
    const stop = api.onChange(update)
    update()
    return () => { stop(); cancelAnimationFrame(frame) }
  }, [api, root])
  return layer && createPortal(<div className="object-labels" aria-hidden="true">{shown.map(item => <Label key={item.id} {...item} />)}</div>, layer)
}

function labels(elements: readonly ExcalidrawElement[], state: AppState): Shown[] {
  const zoom = state.zoom.value, least = themeLength('--object-label-min-width')
  return elements.flatMap(element => {
    const kind = labelledKind(element), { title, caption } = objectLabel(element)
    if (!kind || kind !== 'page' && !title && !caption) return []
    // The engine draws a page or video inside its stroke; the words meet what shows.
    const inset = element.type === 'embeddable' ? element.strokeWidth : 0
    const left = (element.x + inset + state.scrollX) * zoom, top = (element.y + inset + state.scrollY) * zoom
    const width = (element.width - inset * 2) * zoom, height = (element.height - inset * 2) * zoom
    // Nowhere near the view; words are left out where they are too small to read beside.
    if (left > state.width || left + width < 0 || top > state.height + least || top + height < -least) return []
    const readable = width >= least
    if (kind !== 'page' && !readable) return []
    const video = videoData(element)
    return [{
      id: element.id, kind, title: readable ? title : undefined, caption: readable ? caption : undefined, zoom, left, top, width, height, angle: element.angle,
      spec: kind === 'page' ? `${Math.round(element.width)} px` : video ? formatDuration(video.duration) : undefined,
      file: kind === 'page' ? pageName(element) : undefined
    }]
  })
}

const documentTitles = new WeakMap<object, string>()
/** The name a page's bar shows: its file, or else its own <title>, read once. */
function pageName(element: ExcalidrawElement): string | undefined {
  const path = element.customData?.generatedPath
  if (typeof path === 'string' && path) return path.split('/').pop()
  const page = htmlDocument(element)
  if (!page) return undefined
  let name = documentTitles.get(page)
  if (name === undefined) {
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(page.html)?.[1] ?? ''
    name = new DOMParser().parseFromString(title, 'text/html').body.textContent?.trim() ?? ''
    documentTitles.set(page, name)
  }
  return name || undefined
}

function Label({ kind, title, caption, spec, file, zoom, left, top, width, height, angle }: Shown) {
  const Icon = ICONS[kind]
  return <div className="object-label" data-kind={kind} style={{ left, top, width, height, rotate: `${angle}rad`, '--object-label-zoom': zoom } as CSSProperties}>
    {kind === 'page' && <div className="object-label-bar"><span className="object-label-dots"><i /><i /><i /></span><span className="object-label-file">{file}</span><AppWindow aria-hidden="true" /></div>}
    {title && <div className="object-label-title"><Icon aria-hidden="true" /><span className="object-label-name">{title}</span>{spec && <span className="object-label-spec">{spec}</span>}</div>}
    {caption && <p className="object-label-caption">{caption}</p>}
  </div>
}
