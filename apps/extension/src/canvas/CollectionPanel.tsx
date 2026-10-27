import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Bookmark, Ellipsis, ExternalLink, ImageOff, LoaderCircle, Search, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CanvasChromeButton, CanvasChromeSurface } from './CanvasChrome'
import { GaltaMark } from '@/components/GaltaMark'
import { CanvasVisibility } from './canvasVisibility'
import { REFERENCE_MIME } from './referenceDrop'
import type { CollectionItem } from '../shared/collection'

type CollectionResponse = { ok: true; items?: CollectionItem[]; item?: CollectionItem } | { ok: false; error?: string }
type CollectionSort = 'recent' | 'oldest'

/* Keep the first paint light even when the durable collection reaches its
   thousand-reference limit. Scrolling or the explicit button reveals the
   next group without making the library feel paginated. */
const PAGE_SIZE = 60

function extensionAvailable() {
  return Boolean(globalThis.chrome?.runtime?.id && globalThis.chrome?.storage?.onChanged)
}

export function CollectionPanel({ onUse, canvasContext, viewControls, children, disabled = false }: {
  onUse: (item: CollectionItem) => Promise<void> | void
  canvasContext: ReactNode
  viewControls: ReactNode
  children: ReactNode
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<CollectionItem[]>([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<CollectionSort>('recent')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const search = useRef<HTMLInputElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  const layout = useRef<HTMLDivElement>(null)
  const [pageLayout, setPageLayout] = useState(false)

  // The container query owns page mode. Header controls unmount and drawing
  // portals close while the library occupies the browser's content area.
  useLayoutEffect(() => {
    const element = layout.current!
    const measure = () => setPageLayout(getComputedStyle(element).getPropertyValue('--collection-page').trim() === '1')
    const observer = new ResizeObserver(measure)
    observer.observe(element); measure()
    return () => observer.disconnect()
  }, [])

  const refresh = useCallback(async () => {
    if (!extensionAvailable()) return
    setLoading(true); setError(null)
    try {
      const response = await chrome.runtime.sendMessage({ type: 'collection-list' }) as CollectionResponse
      if (!response?.ok) throw new Error(response?.error ?? 'Unable to load your collection.')
      setItems(response.items ?? [])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    void refresh()
    if (!extensionAvailable()) return
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes['galta.collection.v1']) void refresh()
    }
    chrome.storage.onChanged.addListener(changed)
    return () => chrome.storage.onChanged.removeListener(changed)
  }, [refresh])

  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (next) void refresh()
    else trigger.current?.focus({ preventScroll: true })
  }
  const dismiss = (event: React.KeyboardEvent) => {
    if (open && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); changeOpen(false) }
  }
  useEffect(() => { if (open) search.current?.focus({ preventScroll: true }) }, [open, pageLayout])

  const filteredItems = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const matches = needle
      ? items.filter(item => [item.title, item.pageTitle, item.sourceUrl, item.pageUrl, item.mediaUrl].filter(Boolean).join(' ').toLocaleLowerCase().includes(needle))
      : items
    return [...matches].sort((a, b) => sort === 'recent' ? b.collectedAt - a.collectedAt : a.collectedAt - b.collectedAt)
  }, [items, query, sort])
  const visibleItems = filteredItems.slice(0, visibleCount)
  const remaining = Math.max(0, filteredItems.length - visibleItems.length)
  const label = query.trim() ? `${filteredItems.length.toLocaleString()} matching references` : `${items.length.toLocaleString()} references`
  const loadMore = () => setVisibleCount(current => Math.min(current + PAGE_SIZE, filteredItems.length))

  const remove = async (item: CollectionItem) => {
    if (!extensionAvailable()) return
    setBusyId(item.id); setError(null)
    try {
      const response = await chrome.runtime.sendMessage({ type: 'collection-remove', id: item.id }) as CollectionResponse
      if (!response?.ok) throw new Error(response?.error ?? 'Unable to remove this reference.')
      setItems(response.items ?? [])
      search.current?.focus({ preventScroll: true })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setBusyId(null) }
  }

  const useItem = async (item: CollectionItem) => {
    setBusyId(item.id); setError(null)
    try {
      await onUse(item)
      // In the browser's narrow side panel the library occupies the whole
      // content area. Return to the canvas only after placement succeeds.
      const workspace = panel.current?.parentElement?.querySelector('.galta-workspace')
      if (workspace && getComputedStyle(workspace).visibility === 'hidden') changeOpen(false)
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusyId(null) }
  }

  const canvasVisible = !(open && pageLayout)
  return <Collapsible open={open} onOpenChange={changeOpen} className="group/collection h-full">
    <div ref={layout} className="collection-layout relative grid h-full min-h-0 grid-cols-[var(--collection-inset)_minmax(0,1fr)] [--application-width:224px] [--collection-width:320px] [--collection-inset:0px] [--collection-page:0] transition-[--collection-inset] duration-(--motion-panel) ease-(--ease-out) group-data-[state=open]/collection:[--collection-inset:var(--collection-width)] @max-[720px]:[--collection-width:100cqw] @max-[720px]:[--collection-page:1] motion-reduce:transition-none">
      <header className="galta-topbar pointer-events-none absolute inset-x-0 top-0 z-(--layer-header) grid grid-cols-[max(var(--application-width),var(--collection-inset))_minmax(0,1fr)] items-start">
        <div className="galta-application flex min-w-0 items-center justify-between gap-2 pl-5 pr-3 pt-4" role="group" aria-label="Galta and collection" inert={disabled} onKeyDown={dismiss}>
          <CanvasChromeSurface className="galta-brand inline-flex h-(--target-compact) shrink-0 select-none items-center gap-2 px-3 text-foreground group-data-[state=open]/collection:bg-transparent">
            <GaltaMark className="galta-brand-mark" />
            <span className="galta-brand-name text-base font-semibold leading-none tracking-[-0.02em]">Galta</span>
          </CanvasChromeSurface>
          <CanvasChromeSurface className="collection-control pointer-events-auto shrink-0 group-data-[state=open]/collection:bg-transparent">
            <CollapsibleTrigger asChild>
              <CanvasChromeButton ref={trigger} type="button" title={open ? 'Close collection' : 'Open collection'} disabled={disabled} className="collection-trigger">
                <Bookmark className="size-3.5 group-data-[state=open]/collection:fill-current" aria-hidden="true" />
                <span>Collection</span>
              </CanvasChromeButton>
            </CollapsibleTrigger>
          </CanvasChromeSurface>
        </div>
        {canvasVisible && <div className="galta-canvas-header flex min-w-0 flex-wrap items-center justify-between gap-1 px-4 pt-4 @max-[640px]:pl-1 sm:gap-4">
          <div className="galta-canvas-context min-w-[calc(var(--target)*2+var(--space-1))] max-w-[420px] flex-1">{canvasContext}</div>
          <div className="galta-topbar-actions pointer-events-auto ml-auto flex shrink-0 items-center gap-2 sm:gap-3" role="group" aria-label="Canvas view controls">{viewControls}</div>
        </div>}
      </header>
      <CollapsibleContent forceMount asChild>
        <aside ref={panel} className="collection-panel relative min-w-0 overflow-hidden bg-(--surface-glass-panel) text-foreground backdrop-blur-(--chrome-blur) after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-px after:border-r after:border-border/70 after:opacity-0 after:transition-opacity after:duration-(--motion-panel) group-data-[state=open]/collection:after:opacity-100 motion-reduce:after:transition-none" aria-label="Collection" inert={!open || disabled} aria-hidden={!open} onKeyDown={dismiss}>
          <div className="@container/library flex h-full w-(--collection-width) flex-col pt-[calc(var(--header-height,48px)+var(--space-4))] transition-[opacity,transform] duration-(--motion-panel) ease-(--ease-out) group-data-[state=closed]/collection:-translate-x-2 group-data-[state=closed]/collection:opacity-0 motion-reduce:transition-none">
            <div className="collection-heading flex h-(--target-compact) shrink-0 items-center justify-between gap-2 px-5" role="group" aria-label="Collection controls">
              <h2 className="flex min-w-0 items-baseline gap-2 text-[13px] font-medium">References <span className="text-[11px] font-normal tabular-nums text-muted-foreground" aria-label={`${items.length} collected references`}>{items.length.toLocaleString()}</span></h2>
              <Select value={sort} onValueChange={value => { setSort(value as CollectionSort); setVisibleCount(PAGE_SIZE) }}>
                <SelectTrigger className="pointer-events-auto w-auto gap-1.5 bg-transparent px-1.5 text-[11px] text-muted-foreground" aria-label="Sort collection"><SelectValue /></SelectTrigger>
                <SelectContent align="end"><SelectItem value="recent">Recent</SelectItem><SelectItem value="oldest">Oldest first</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="shrink-0 px-5 pb-4 pt-2">
                <label className="flex min-w-0 items-center gap-2 border-b border-border/70 transition-colors duration-(--motion-fast) focus-within:border-ring/70">
                  <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <Input ref={search} type="search" aria-label="Search collection" placeholder="Search references…" value={query} onChange={event => { setQuery(event.target.value); setVisibleCount(PAGE_SIZE) }} className="h-8 min-w-0 rounded-none bg-transparent px-0 text-xs shadow-none focus-visible:bg-transparent! md:text-xs" />
                  {query && <Button type="button" variant="ghost" size="icon-xs" className="size-6 text-muted-foreground" aria-label="Clear collection search" onClick={() => { setQuery(''); setVisibleCount(PAGE_SIZE); search.current?.focus() }}><X /></Button>}
                </label>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <p className={query.trim() ? 'shrink-0 px-5 pb-3 text-[11px] text-muted-foreground' : 'sr-only'} aria-live="polite">{loading && items.length === 0 ? 'Loading references…' : label}</p>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5" role="region" aria-label="Collection results" onScroll={event => { const target = event.currentTarget; if (target.scrollTop + target.clientHeight >= target.scrollHeight - 240 && remaining > 0) loadMore() }}>
                {loading && items.length === 0 && <div className="grid min-h-44 place-items-center text-muted-foreground" role="status"><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-label="Loading collection" /></div>}
                {!loading && items.length === 0 && !error && <div className="grid min-h-52 place-items-center gap-2 px-5 py-8 text-center text-muted-foreground"><Bookmark className="size-7 opacity-25" aria-hidden="true" /><p className="text-sm text-foreground">Nothing collected yet</p><p className="max-w-[28ch] text-xs leading-relaxed">Hover an image on a webpage and click the Galta mark. Your references will stay here.</p></div>}
                {!loading && items.length > 0 && !filteredItems.length && <div className="grid min-h-44 place-items-center gap-2 px-5 py-8 text-center text-muted-foreground"><Search className="size-6 opacity-30" aria-hidden="true" /><p className="text-sm text-foreground">No references found</p><p className="max-w-[28ch] text-xs leading-relaxed">Try a title, website, or source URL.</p><Button type="button" variant="ghost" size="compact" onClick={() => { setQuery(''); setVisibleCount(PAGE_SIZE); search.current?.focus() }}>Clear search</Button></div>}
                {error && <p className="mb-2 rounded-md bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive" role="alert">{error}</p>}
                {visibleItems.length > 0 && <CollectionGallery items={visibleItems} busyId={busyId} onUse={item => void useItem(item)} onRemove={item => void remove(item)} />}
                {remaining > 0 && <Button type="button" variant="ghost" size="sm" className="mx-auto mt-3 flex text-xs text-muted-foreground" onClick={loadMore}>Show more <span className="tabular-nums">{remaining.toLocaleString()}</span></Button>}
              </div>
            </div>
          </div>
        </aside>
      </CollapsibleContent>
      <div className="galta-workspace @container relative min-w-0 overflow-hidden @max-[720px]:min-w-[100cqw] @max-[720px]:group-data-[state=open]/collection:invisible"><CanvasVisibility value={canvasVisible}>{children}</CanvasVisibility></div>
    </div>
  </Collapsible>
}

function CollectionGallery({ items, busyId, onUse, onRemove }: { items: CollectionItem[]; busyId: string | null; onUse: (item: CollectionItem) => void; onRemove: (item: CollectionItem) => void }) {
  const gallery = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = gallery.current!
    const cards = [...element.children] as HTMLElement[]
    let frame = 0
    const arrange = () => {
      const style = getComputedStyle(element)
      const columns = Number(style.getPropertyValue('--collection-columns'))
      const gap = Number.parseFloat(style.getPropertyValue('--collection-gap'))
      const heights = Array<number>(columns).fill(0)
      // Keep DOM, keyboard and collection order intact. CSS columns would
      // rebalance earlier references whenever another batch is appended.
      for (const card of cards) {
        const column = heights.indexOf(Math.min(...heights))
        const rect = card.getBoundingClientRect()
        card.style.transform = `translate(${column * (rect.width + gap)}px, ${heights[column]}px)`
        heights[column]! += rect.height + gap
      }
      element.style.height = `${Math.max(...heights) - gap}px`
    }
    // Image loads and width changes resize the cards. Applying their layout
    // also changes the observed gallery's height, so write it outside the
    // observer delivery phase rather than triggering a skipped notification.
    const observer = new ResizeObserver(() => {
      if (frame) return
      frame = requestAnimationFrame(() => { frame = 0; arrange() })
    })
    observer.observe(element)
    for (const card of cards) observer.observe(card)
    arrange()
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [items])
  return <div ref={gallery} className="collection-gallery relative [--collection-columns:2] [--collection-gap:var(--space-3)] @min-[480px]/library:[--collection-columns:3]" style={{ '--collection-card-width': 'calc((100% - (var(--collection-columns) - 1) * var(--collection-gap)) / var(--collection-columns))' } as React.CSSProperties} role="list" aria-label="Collected references">
    {items.map(item => <CollectionCard key={item.id} item={item} busy={busyId === item.id} onUse={() => onUse(item)} onRemove={() => onRemove(item)} />)}
  </div>
}

function CollectionCard({ item, busy, onUse, onRemove }: { item: CollectionItem; busy: boolean; onUse: () => void; onRemove: () => void }) {
  const label = item.title || item.pageTitle || 'Collected reference'
  const source = item.sourceUrl ?? item.pageUrl
  const host = source ? hostLabel(source) : ''
  return <article className="group absolute left-0 top-0 w-(--collection-card-width) min-w-0" draggable={!busy} onDragStart={event => {
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData(REFERENCE_MIME, JSON.stringify({ url: item.mediaUrl, sourceUrl: item.sourceUrl ?? item.pageUrl }))
    event.dataTransfer.setData('text/uri-list', item.mediaUrl)
    event.dataTransfer.setData('text/plain', item.mediaUrl)
  }} role="listitem" aria-label={label}>
    <button type="button" className="block w-full rounded-none text-left outline-none" onClick={onUse} disabled={busy} aria-label={`Add ${label} to canvas`}>
      <img src={item.mediaUrl} alt="" loading="lazy" decoding="async" className="block aspect-[auto_4/5] h-auto w-full object-contain" onError={event => { event.currentTarget.hidden = true; event.currentTarget.nextElementSibling?.removeAttribute('hidden') }} />
      <span hidden className="grid aspect-[4/5] w-full place-items-center bg-field text-muted-foreground"><ImageOff className="size-4" aria-label="Preview unavailable" /></span>
    </button>
    <div className="collection-details pointer-events-none absolute inset-x-0 bottom-0 flex items-end gap-1 bg-linear-to-t from-black/75 to-transparent pb-1 pl-2 pr-1 pt-6 text-white opacity-0 transition-opacity duration-(--motion-fast) group-hover:opacity-100 group-focus-within:opacity-100 group-has-[[aria-expanded=true]]:opacity-100 pointer-coarse:opacity-100">
      <span className="collection-description min-w-0 flex-1 self-center truncate text-[11px] leading-4 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 group-has-[[aria-expanded=true]]:opacity-100" title={label}>{label}</span>
    <DropdownMenu><DropdownMenuTrigger asChild>
      <Button type="button" variant="ghost" size="icon-compact" disabled={busy} aria-label={`Reference actions for ${label}`} className="pointer-events-none text-white hover:bg-white/15 hover:text-white focus-visible:text-foreground group-hover:pointer-events-auto group-focus-within:pointer-events-auto aria-expanded:pointer-events-auto pointer-coarse:pointer-events-auto"><Ellipsis className="size-3.5" /></Button>
    </DropdownMenuTrigger><DropdownMenuContent align="end" sideOffset={4} collisionPadding={8} aria-label={`Reference actions for ${label}`}>
      {source && <DropdownMenuItem asChild><a href={source} target="_blank" rel="noreferrer" aria-label={`Open source for ${label}`} title={host}><ExternalLink />Open source</a></DropdownMenuItem>}
      <DropdownMenuItem disabled={busy} onSelect={onRemove} className="text-destructive" aria-label={`Remove ${label}`}><Trash2 />Remove from collection</DropdownMenuItem>
    </DropdownMenuContent></DropdownMenu>
    </div>
    {busy && <span className="pointer-events-none absolute inset-0 grid place-items-center bg-background/60" role="status"><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-label="Working" /></span>}
  </article>
}

function hostLabel(value: string) {
  try { return new URL(value).hostname.replace(/^www\./i, '') }
  catch { return '' }
}
