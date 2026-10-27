import { useEffect, useRef } from 'react'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'

// A stable scene link; the runtime URL is resolved per extension installation.
export const HTML_EMBED_LINK = '/html-preview.html'
export function htmlDocument(element: ExcalidrawElement): { html: string } | undefined {
  const document = element.customData?.htmlDocument
  return element.type === 'embeddable' && element.link === HTML_EMBED_LINK && typeof document?.html === 'string' ? document : undefined
}

/** The packaged sandbox page that renders a document, for this page's location. */
export const htmlRendererUrl = () => new URL('../html-preview.html', location.href).href

export function HtmlEmbed({ html }: { html: string }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const send = () => frame.current?.contentWindow?.postMessage({ type: 'galta-html-preview', html }, '*')
  useEffect(send, [html])
  // The packaged sandbox page has an opaque origin. It owns the nested srcdoc
  // so generated scripts inherit its CSP, never the privileged extension CSP.
  // The frame fills its element box; its border and radius belong to the
  // embeddable adapter, which squares its top under the browser bar that
  // ObjectLabels draws on every page.
  return <iframe ref={frame} title="HTML preview" className="excalidraw__embeddable" data-framed
    src={htmlRendererUrl()} onLoad={send}
    sandbox="allow-scripts allow-forms allow-downloads" referrerPolicy="no-referrer"
    style={{ width: '100%', height: '100%' }} />
}
