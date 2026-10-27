import { memo, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Streamdown, defaultUrlTransform, parseMarkdownIntoBlocks, type Components, type StreamdownProps } from 'streamdown'
import { lexer } from 'marked'
import { Download } from 'lucide-react'
import { MANAGED_ARTIFACT_SCHEME, isManagedArtifactReference } from '@galta/canvas'
import type { ArtifactRead, ArtifactReceipt, ConversationArtifact } from '@galta/domain'
import { cn } from '@/lib/utils'

export function isExternalConversationLink(href: string | undefined): boolean {
  return typeof href === 'string' && /^https?:\/\//i.test(href)
}

export type ArtifactDownload = (uri: string, receipt?: ArtifactRead) => Promise<void>

// Full-document Markdown parsing is useful once a reply settles, but reparsing
// a large live document on every transport tick can monopolize the main thread.
// Keep the live projection lightweight past this boundary; the completed item
// immediately returns to the canonical Markdown renderer.
const STREAMING_MARKDOWN_LIMIT = 12_000
// One identity for "no deliveries", so memoized messages and their Markdown
// components survive a parent render.
const NO_ARTIFACTS: readonly ConversationArtifact[] = []
// Text reaches the view in 50ms transport batches, and models deliver tokens in
// bursts. The view reveals arrived text at a rate that drains the backlog within
// `PACE_MS`, never slower than `PACE_FLOOR` characters per millisecond, so the
// reading line advances every frame instead of jumping by a batch. The delay
// this adds is bounded by the pace; nothing is held back once a backlog drains.
const PACE_MS = 140, PACE_FLOOR = .08

function receiptGrant(receipt: ArtifactReceipt): ArtifactRead {
  return { receiptId: receipt.receiptId, projectId: receipt.projectId, threadId: receipt.threadId, turnId: receipt.turnId, messageId: receipt.messageId, href: receipt.href, uri: receipt.uri }
}

function artifactName(uri: string): string {
  const value = uri.slice(uri.lastIndexOf('/') + 1)
  try { return decodeURIComponent(value) || 'galta-artifact' }
  catch { return value || 'galta-artifact' }
}

const ArtifactLink = memo(function ArtifactLink({ href, receipt, children, onDownload }: { href: string; receipt?: ArtifactReceipt; children: ReactNode; onDownload?: ArtifactDownload | undefined }) {
  const [state, setState] = useState<'idle' | 'working' | 'failed'>('idle')
  const activate = async () => {
    if (!onDownload || state === 'working') return
    setState('working')
    try { await onDownload(href, receipt ? receiptGrant(receipt) : undefined); setState('idle') }
    catch { setState('failed') }
  }
  return <button type="button" data-artifact-uri={href} className="inline-flex max-w-full items-center gap-1 underline underline-offset-3 disabled:cursor-wait disabled:opacity-70" disabled={!onDownload || state === 'working'} aria-busy={state === 'working'} aria-label={`Download ${artifactName(href)}`} title={state === 'failed' ? 'Download failed; try again' : `Download ${artifactName(href)}`} onClick={() => void activate()}>
    <span className="min-w-0 wrap-anywhere">{children}</span><Download className="size-3.5 shrink-0" aria-hidden="true" />
  </button>
})

function receiptOf(artifact: ConversationArtifact): ArtifactReceipt | undefined {
  return artifact.status === 'ready' ? artifact.receipt : undefined
}

function receiptReferences(receipt: ArtifactReceipt): string[] {
  return [receipt.href, receipt.uri, receipt.artifactUri].filter((value): value is string => Boolean(value))
}

/** Every persisted reference that can identify one conversation delivery. */
export function artifactReferences(artifact: ConversationArtifact): string[] {
  return artifact.status === 'ready'
    ? [artifact.href, ...receiptReferences(artifact.receipt)].filter((value): value is string => Boolean(value))
    : [artifact.href].filter((value): value is string => Boolean(value))
}

/** A final-message receipt is a product-owned delivery fact. Keep its action
 * beside the reply even when the model used an absolute machine path. */
export const ArtifactDelivery = memo(function ArtifactDelivery({ artifacts, onDownload }: { artifacts: readonly ConversationArtifact[]; onDownload?: ArtifactDownload | undefined }) {
  if (!artifacts.length) return null
  return <div className="conversation-artifact-delivery mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-artifact-delivery>
    <span className="shrink-0 text-xs text-muted-foreground">Files</span>
    {artifacts.map((artifact, index) => {
      const receipt = receiptOf(artifact)
      return receipt
        ? <ArtifactLink key={receipt.receiptId} href={receipt.uri} receipt={receipt} onDownload={onDownload}>{receipt.name || artifactName(receipt.uri)}</ArtifactLink>
        : <span key={`${artifact.href}:${index}`} role="status" title={artifact.status === 'failed' ? artifact.error : undefined}>Delivery failed{artifact.href ? `: ${artifact.href}` : ''}</span>
    })}
  </div>
})

function markdownComponents(onArtifactDownload: ArtifactDownload | undefined, artifacts: readonly ConversationArtifact[]): Components {
  const byHref = new Map<string, ConversationArtifact>()
  const seenReceipts = new Set<string>()
  const seenManagedReferences = new Set<string>()
  for (const artifact of artifacts) {
    for (const reference of artifactReferences(artifact)) byHref.set(reference, artifact)
  }
  return {
    a: ({ children, href }) => {
      const delivery = byHref.get(href ?? '') ?? (() => {
        try { return byHref.get(decodeURIComponent(href ?? '')) }
        catch { return undefined }
      })()
      const receipt = delivery && receiptOf(delivery)
      if (receipt) {
        if (seenReceipts.has(receipt.receiptId)) return <span className="text-muted-foreground">{children}</span>
        seenReceipts.add(receipt.receiptId)
        return <ArtifactLink href={receipt.uri} receipt={receipt} onDownload={onArtifactDownload}>{children}</ArtifactLink>
      }
      if (delivery?.status === 'failed') return <span className="text-muted-foreground" title={delivery.error}>Delivery failed: {children}</span>
      if (isManagedArtifactReference(href ?? '')) {
        if (seenManagedReferences.has(href!)) return <span className="text-muted-foreground">{children}</span>
        seenManagedReferences.add(href!)
        return <ArtifactLink href={href!} onDownload={onArtifactDownload}>{children}</ArtifactLink>
      }
      if (isExternalConversationLink(href)) return <a href={href} target="_blank" rel="noreferrer">{children}</a>
      return <span className="text-muted-foreground">{children}</span>
    },
    img: ({ alt }) => <span>{alt ?? 'Image available on the canvas'}</span>,
    pre: 'pre', code: 'code', inlineCode: ({ children }) => <code>{children}</code>, table: 'table',
    strong: 'strong', p: 'p', h1: 'h1', h2: 'h2', h3: 'h3', ul: 'ul', ol: 'ol', li: 'li'
  }
}
// Preserve Galta's native typography and link/image policy. HTML remains text;
// no diagram, syntax-highlighting, remote-image or per-token animation plugins.
const rehypePlugins: NonNullable<StreamdownProps['rehypePlugins']> = []

function markdownBlocks(markdown: string): string[] {
  // Reference links have document scope. Streamdown 2.6 splits those definitions
  // away from their users; let its ordinary Markdown parser see the whole
  // document in this case. The lexer (not a regex) decides whether definitions
  // exist. All other block segmentation stays with the library.
  if (markdown.includes(']:') && Object.keys(lexer(markdown).links).length) return [markdown]
  return parseMarkdownIntoBlocks(markdown)
}

/** The prefix of `text` the reader has been shown. Growth by appending is
 * revealed at a paced rate; any other change (a replaced or shortened text, a
 * restored message) is shown whole. Reduced motion shows every change whole,
 * and so does text past the streaming Markdown limit: its plain projection
 * relays out the whole text on each change, so it keeps the transport's pace. */
export function usePacedText(text: string): string {
  const [length, setLength] = useState(text.length)
  const pace = useRef({ text, length: text.length, carry: 0, last: 0, frame: 0 })
  useEffect(() => {
    const state = pace.current
    const appended = text.length >= state.length && text.startsWith(state.text.slice(0, state.length))
    state.text = text
    if (!appended || text.length > STREAMING_MARKDOWN_LIMIT || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      cancelAnimationFrame(state.frame); state.frame = 0
      state.length = text.length; setLength(text.length)
      return
    }
    if (state.frame || state.length >= text.length) return
    state.last = performance.now(); state.carry = 0
    const tick = (now: number) => {
      const backlog = state.text.length - state.length
      const advance = Math.max(backlog / PACE_MS, PACE_FLOOR) * (now - state.last) + state.carry
      const step = Math.floor(advance)
      state.last = now; state.carry = advance - step
      if (step > 0) {
        let next = Math.min(state.text.length, state.length + step)
        // Never end on the first half of a surrogate pair.
        const code = state.text.charCodeAt(next - 1)
        if (next < state.text.length && code >= 0xd800 && code <= 0xdbff) next++
        state.length = next; setLength(next)
      }
      state.frame = state.length < state.text.length ? requestAnimationFrame(tick) : 0
    }
    state.frame = requestAnimationFrame(tick)
  }, [text])
  useEffect(() => () => cancelAnimationFrame(pace.current.frame), [])
  return length >= text.length ? text : text.slice(0, length)
}

export const ConversationMessage = memo(function ConversationMessage({ text, streaming = false, artifacts = NO_ARTIFACTS, onArtifactDownload }: { text: string; streaming?: boolean; artifacts?: readonly ConversationArtifact[] | undefined; onArtifactDownload?: ArtifactDownload | undefined }) {
  const content = useDeferredValue(usePacedText(text))
  // A prefix still being revealed is incomplete Markdown, even after the item ends.
  const live = streaming || content.length < text.length
  return live && content.length > STREAMING_MARKDOWN_LIMIT
    ? <div className="conversation-assistant whitespace-pre-wrap text-base leading-[1.55] wrap-anywhere">{content}</div>
    : <MarkdownBody text={content} streaming={live} artifacts={artifacts} onArtifactDownload={onArtifactDownload} />
})

const MarkdownBody = memo(function MarkdownBody({ text, streaming = false, artifacts, onArtifactDownload }: { text: string; streaming?: boolean; artifacts: readonly ConversationArtifact[]; onArtifactDownload?: ArtifactDownload | undefined }) {
  // Reset link de-duplication for each parsed message version so a streaming
  // update can expose a newly arrived first link without stale render state.
  // A message with no deliveries and no managed references has nothing to
  // de-duplicate; stable components let Streamdown skip its unchanged blocks.
  const version = artifacts.length || text.includes(MANAGED_ARTIFACT_SCHEME) ? text : ''
  const components = useMemo(() => markdownComponents(onArtifactDownload, artifacts), [artifacts, onArtifactDownload, version])
  // Streamdown caches parsed blocks by text. A host receipt can arrive after
  // the final text, so remount the projection when its delivery facts change.
  const artifactRenderKey = artifacts.map(artifact => artifact.status === 'ready'
    ? `${artifact.href}:ready:${artifact.receipt.uri}:${artifact.receipt.artifactUri ?? ''}`
    : `${artifact.href}:failed:${artifact.error}`).join('|')
  const urlTransform = useMemo<NonNullable<StreamdownProps['urlTransform']>>(() => (url, key, node) => {
    const delivery = artifacts.find(artifact => artifact.status === 'ready' && receiptReferences(artifact.receipt).includes(url))
    const receipt = delivery && receiptOf(delivery)
    return receipt ? receipt.uri : isManagedArtifactReference(url) ? url : defaultUrlTransform(url, key, node)
  }, [artifacts])
  return <Streamdown key={artifactRenderKey} mode="streaming" parseMarkdownIntoBlocksFn={markdownBlocks} isAnimating={streaming} parseIncompleteMarkdown={streaming} controls={false} animated={false} components={components} rehypePlugins={rehypePlugins} urlTransform={urlTransform} className={cn('conversation-assistant space-y-0 text-base leading-[1.55] wrap-anywhere [&+&]:mt-4 [&_p]:mb-3 [&_p:last-child]:mb-0 [&_h1]:mt-5 [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-medium [&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-medium [&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-medium [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-6 [&_ol]:pl-6 [&_pre]:overflow-auto [&_pre]:rounded-sm [&_pre]:bg-muted [&_pre]:p-3 [&_code]:font-mono [&_a]:underline [&_a]:underline-offset-3 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_table]:text-xs [&_th]:border-b [&_th]:p-2 [&_th]:text-left [&_td]:border-b [&_td]:p-2 [&_td]:text-left')}>
    {text}
  </Streamdown>
})
