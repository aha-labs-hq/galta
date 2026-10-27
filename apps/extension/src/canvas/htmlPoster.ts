import type { ExcalidrawElement, FileId } from '@excalidraw/excalidraw/element/types'
import type { BinaryFiles, DataURL } from '@excalidraw/excalidraw/types'
import { themeColor } from '../design/theme'
import { htmlDocument, htmlRendererUrl } from './htmlEmbed'
import { withVideoPosters } from './video'

/* A page lives only where the canvas shows it. Every bitmap of the canvas,
   from thumbnails and history to selection export and the agent's own view,
   shows a poster instead: the page as it looks once loaded, at its element's
   size. The document loads unseen in the same sandbox as the canvas
   (html-preview.html), which returns it as self-contained markup; the poster
   is that markup drawn as an image, so nothing in it runs. A page that cannot
   be drawn shows its title instead, and the projection names it. */

const LOAD_LIMIT = 8_000, MARKUP_LIMIT = 16_000_000, LONGEST_SIDE = 2400, KEPT_DOCUMENTS = 24
type Poster = { id: FileId; dataURL: DataURL; failure?: string }

// Keyed by the document and then its size. Identical documents are shared
// across history, so one poster serves every frame that holds the page.
const posters = new Map<string, Map<string, Promise<Poster>>>()
// One unseen document at a time: each runs the page's own scripts.
let turn: Promise<unknown> = Promise.resolve()

function poster(html: string, width: number, height: number): Promise<Poster> {
  const sizes = posters.get(html) ?? new Map<string, Promise<Poster>>()
  posters.delete(html); posters.set(html, sizes)
  if (posters.size > KEPT_DOCUMENTS) posters.delete(posters.keys().next().value!)
  const size = `${width}x${height}`
  let made = sizes.get(size)
  if (!made) {
    made = turn.then(() => render(html, width, height))
    turn = made
    sizes.set(size, made)
  }
  return made
}

async function render(html: string, width: number, height: number): Promise<Poster> {
  const id = crypto.randomUUID() as FileId
  try {
    return { id, dataURL: await draw(await load(html, width, height), width, height) }
  } catch (error) {
    return { id, dataURL: titleCard(html, width, height), failure: error instanceof Error ? error.message : String(error) }
  }
}

function load(html: string, width: number, height: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe'), id = crypto.randomUUID()
    const finish = (error?: Error, markup?: string) => {
      clearTimeout(timer); removeEventListener('message', receive); frame.remove()
      if (error) reject(error); else resolve(markup!)
    }
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.data?.type !== 'galta-html-poster' || event.data.id !== id) return
      const markup = event.data.markup
      if (typeof markup !== 'string' || !markup || markup.length > MARKUP_LIMIT) finish(new Error('The page returned no drawable markup'))
      else finish(undefined, markup)
    }
    const timer = setTimeout(() => finish(new Error(`The page did not finish loading within ${LOAD_LIMIT / 1000} s`)), LOAD_LIMIT)
    addEventListener('message', receive)
    // In view but invisible: browsers pause documents outside the viewport.
    frame.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;border:0;opacity:0;pointer-events:none;z-index:-1`
    frame.setAttribute('sandbox', 'allow-scripts'); frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1
    frame.onload = () => frame.contentWindow?.postMessage({ type: 'galta-html-poster-request', id, html }, '*')
    frame.src = htmlRendererUrl()
    document.body.append(frame)
  })
}

async function draw(markup: string, width: number, height: number): Promise<DataURL> {
  // A data URL, not a blob: Chrome taints a canvas that draws a blob-URL SVG
  // holding foreignObject, and a tainted canvas cannot be exported.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="${width}" height="${height}">${markup}</foreignObject></svg>`
  const image = new Image()
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  try { await image.decode() } catch { throw new Error('The page’s markup could not be drawn') }
  const canvas = surface(width, height)
  canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/webp', .92) as DataURL
}

function titleCard(html: string, width: number, height: number): DataURL {
  const title = new DOMParser().parseFromString(html, 'text/html').title.replace(/\s+/g, ' ').trim() || 'Web page'
  const canvas = surface(width, height), context = canvas.getContext('2d')!, scale = canvas.width / width
  context.scale(scale, scale)
  context.fillStyle = themeColor('surface-hover'); context.fillRect(0, 0, width, height)
  const size = Math.max(12, Math.min(28, width / 16))
  context.textAlign = 'center'; context.textBaseline = 'middle'
  context.font = `600 ${size}px system-ui, sans-serif`; context.fillStyle = themeColor('foreground')
  let line = title
  while (line.length > 1 && context.measureText(line).width > width * .8) line = `${line.slice(0, -2).trimEnd()}…`
  context.fillText(line, width / 2, height / 2 - size * .4)
  context.font = `${size * .6}px system-ui, sans-serif`; context.fillStyle = themeColor('muted-foreground')
  context.fillText('Web page', width / 2, height / 2 + size * .8)
  return canvas.toDataURL('image/webp', .92) as DataURL
}

function surface(width: number, height: number) {
  const scale = Math.min(2, LONGEST_SIDE / Math.max(width, height)), canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale))
  return canvas
}

/** The bitmap projection of a canvas: videos as their saved posters, pages
 * as posters of the loaded page. The editable elements are unchanged. A page
 * drawn as its title card is added to `unrendered` and logged. */
export async function withPosters(elements: readonly ExcalidrawElement[], files: BinaryFiles, unrendered?: string[]) {
  const projected = withVideoPosters(elements, files), pages: BinaryFiles = {}
  const next = await Promise.all(projected.elements.map(async element => {
    const page = htmlDocument(element)
    if (!page) return element
    const made = await poster(page.html, Math.max(1, Math.round(element.width)), Math.max(1, Math.round(element.height)))
    if (made.failure) { unrendered?.push(element.id); console.warn('HTML poster unavailable; showing its title', { elementId: element.id, reason: made.failure }) }
    pages[made.id] = { id: made.id, mimeType: 'image/webp', dataURL: made.dataURL, created: 0 }
    return { ...element, type: 'image', fileId: made.id, status: 'saved', scale: [1, 1], crop: null, link: null, customData: {} } as unknown as ExcalidrawElement
  }))
  return { elements: next, files: { ...projected.files, ...pages } }
}
