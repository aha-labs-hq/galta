import { useId, useRef, useState } from 'react'
import { AlertDialog } from 'radix-ui'
import type { WorkspaceSummary } from '@galta/storage'
import { Archive, ArrowLeft, Check, ChevronDown, Copy, Download, Image, LoaderCircle, MoreHorizontal, Pencil, Plus, Search, Trash2, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { canvasOperationLabel, type CanvasNavigation } from './canvasNavigation'
import { CanvasChromeButton } from './CanvasChrome'

export function WorkspaceMenu({ title, projectId, navigation, hasMigrationBackup = false, onExportBackup }: {
  title?: string; projectId?: string; navigation: CanvasNavigation
  hasMigrationBackup?: boolean; onExportBackup?: () => void
}) {
  const input = useRef<HTMLInputElement>(null), search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false), [archived, setArchived] = useState(false)
  const [query, setQuery] = useState(''), [editing, setEditing] = useState(false), [name, setName] = useState('')
  const [error, setError] = useState(''), [actionsOpen, setActionsOpen] = useState(false)
  // Canvases awaiting confirmation of permanent deletion, and a note about
  // anything a deletion kept.
  const [doomed, setDoomed] = useState<readonly WorkspaceSummary[] | null>(null), [note, setNote] = useState('')
  const exportDescriptionId = useId()
  const order = useRef<string[]>([])
  const position = (id: string) => { const index = order.current.indexOf(id); return index < 0 ? order.current.length : index }
  const entries = navigation.entries.filter(item => Boolean(item.archivedAt) === archived && item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => position(a.id) - position(b.id))
  const action = async (run: () => Promise<void>) => {
    setError('')
    setActionsOpen(false)
    try { await run(); setOpen(false); setEditing(false) }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); setOpen(true) }
  }
  const removeCanvases = async (items: readonly WorkspaceSummary[]) => {
    setDoomed(null); setError(''); setNote('')
    try { const kept = await navigation.remove(items.map(item => item.id)); if (kept) setNote(kept) }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setOpen(true); search.current?.focus() }
  }
  const changeOpen = (next: boolean) => {
    if (navigation.pending || doomed) return
    setOpen(next)
    if (next) { order.current = navigation.entries.map(item => item.id); setQuery(''); setError(''); setNote(''); setArchived(false); setEditing(false); setActionsOpen(false); void navigation.refresh().catch(error => setError(String(error))) }
  }
  const focusEntry = (last = false) => {
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([data-row-action])')
    buttons?.[last ? buttons.length - 1 : 0]?.focus()
  }
  return <>
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild><CanvasChromeButton type="button" className="canvas-picker-trigger group/canvas-picker max-w-72 shrink overflow-hidden text-[13px] font-medium" aria-label="Canvas menu" title={title ?? 'Choose a canvas'} disabled={navigation.pending}>
        <span className="canvas-picker-title min-w-0 truncate">{title ?? 'Your canvases'}</span>{navigation.pending ? <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" /> : <ChevronDown className="size-3 text-(--chrome-muted) transition-transform duration-(--motion-fast) group-data-[state=open]/canvas-picker:rotate-180" />}
      </CanvasChromeButton></PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} collisionPadding={12} onOpenAutoFocus={event => { event.preventDefault(); search.current?.focus() }} onInteractOutside={event => { if (doomed) event.preventDefault() }}
        className="workspace-menu flex max-h-(--radix-popover-content-available-height) w-90 max-w-[calc(100vw_-_24px)] flex-col overflow-y-auto overscroll-contain p-2" aria-label="Canvases">
        <header className="workspace-menu-header shrink-0">
          <div className="workspace-menu-title-row">
            <h2 className="workspace-menu-heading">{archived ? 'Archived canvases' : 'Your canvases'}</h2>
            <Button variant="ghost" size="compact" className="workspace-new-action" disabled={navigation.pending} onClick={() => void action(navigation.create)}><Plus aria-hidden="true" />New canvas</Button>
          </div>
          <div className="workspace-search-field">
            <Search className="size-4 shrink-0" aria-hidden="true" />
            <Input ref={search} type="search" aria-label="Search canvases" placeholder="Find a canvas…" value={query} disabled={navigation.pending} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); focusEntry(event.key === 'ArrowUp') }
              if (event.key === 'Enter' && entries.length) { event.preventDefault(); void action(() => archived ? navigation.restore(entries[0]!.id) : navigation.open(entries[0]!.id)) }
            }} className="workspace-search-input" />
            {query && <Button type="button" variant="ghost" size="icon-compact" className="workspace-search-clear" aria-label="Clear canvas search" onClick={() => { setQuery(''); search.current?.focus() }}><X /></Button>}
          </div>
        </header>
        <div ref={list} className="workspace-menu-list min-h-18 flex-1 overflow-y-auto overscroll-contain" aria-label={archived ? 'Archived canvases' : 'Recent canvases'} onKeyDown={event => {
          const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([data-row-action])') ?? [])
          const index = buttons.indexOf(event.target as HTMLButtonElement)
          if (index < 0) return
          if (event.key === 'ArrowDown') { event.preventDefault(); buttons[(index + 1) % buttons.length]?.focus() }
          if (event.key === 'ArrowUp') { event.preventDefault(); if (index === 0) search.current?.focus(); else buttons[index - 1]?.focus() }
          if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); focusEntry(event.key === 'End') }
        }}>
          {entries.map(item => {
            const row = <Button key={item.id} data-project-id={item.id} variant="ghost" title={item.title} aria-current={item.id === projectId ? 'true' : undefined} aria-label={archived ? `Restore ${item.title}` : `Open ${item.title}`} disabled={navigation.pending}
            className={cn('workspace-canvas-item h-auto w-full justify-start gap-3 font-normal', item.id === projectId && 'is-current', archived && 'pr-11')}
            onClick={() => void action(() => archived ? navigation.restore(item.id) : navigation.open(item.id))}>
            <span className="workspace-canvas-preview" aria-hidden="true">{item.preview ? <img src={item.preview} alt="" /> : <Image className="size-4" />}</span>
            <span className="workspace-canvas-copy"><span className="workspace-canvas-name" title={item.title}>{item.title}</span><span className="workspace-canvas-meta">{archived ? 'Restore canvas' : visitLabel(item.lastOpenedAt)}</span></span>
            {item.id === projectId && <Check className="workspace-current-mark size-3.5" aria-hidden="true" />}
          </Button>
            if (!archived) return row
            // An archived canvas can also go for good; the row itself restores.
            return <div key={item.id} className="group/row relative">{row}
              <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-compact" data-row-action="" aria-label={`Delete ${item.title}`} disabled={navigation.pending}
                className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 hover:text-destructive pointer-coarse:opacity-100"
                onClick={() => setDoomed([item])}><Trash2 /></Button></TooltipTrigger><TooltipContent>Delete permanently</TooltipContent></Tooltip>
            </div>
          })}
          {!entries.length && <p className="px-3 py-6 text-center text-sm text-muted-foreground">{query ? 'No matching canvases.' : archived ? 'No archived canvases.' : 'A fresh place to begin.'}</p>}
        </div>
        {editing && <form className="workspace-rename-form flex shrink-0 gap-2 p-1" onSubmit={event => { event.preventDefault(); void action(() => navigation.rename(name)) }}>
          <Input autoFocus value={name} disabled={navigation.pending} onFocus={event => event.target.select()} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(false); search.current?.focus() } }} aria-label="Canvas name" maxLength={80} required />
          <Tooltip><TooltipTrigger asChild><Button type="submit" size="icon-compact" aria-label="Save canvas name" disabled={navigation.pending || !name.trim()}><Check /></Button></TooltipTrigger><TooltipContent>Save name</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-compact" aria-label="Cancel rename" disabled={navigation.pending} onClick={() => { setEditing(false); search.current?.focus() }}><X /></Button></TooltipTrigger><TooltipContent>Cancel rename</TooltipContent></Tooltip>
        </form>}
        <footer className="workspace-menu-footer shrink-0">
          <Button variant="ghost" size="compact" className="workspace-footer-action justify-start" disabled={navigation.pending} onClick={() => { setArchived(!archived); setQuery('') }}>{archived ? <ArrowLeft /> : <Archive />}<span>{archived ? 'Recent canvases' : 'Archived'}</span></Button>
          <span className="workspace-menu-location">On this device</span>
          <Popover open={actionsOpen} onOpenChange={setActionsOpen}><PopoverTrigger asChild><Button variant="ghost" size="icon-compact" title="Canvas actions" aria-label={projectId ? 'Current canvas actions' : 'Canvas actions'} disabled={navigation.pending}><MoreHorizontal /></Button></PopoverTrigger>
            <PopoverContent align="end" side="top" sideOffset={8} collisionPadding={12} onEscapeKeyDown={event => {
              // A fading submenu is still mounted in Radix's layer stack.
              // Escape follows the logical open layer during its exit too;
              // the rename field still owns its own cancellation.
              event.preventDefault()
              if (actionsOpen) setActionsOpen(false)
              else if (!editing) changeOpen(false)
            }} className="workspace-actions-menu max-h-(--radix-popover-content-available-height) w-60 max-w-[calc(100vw_-_24px)] space-y-1 overflow-y-auto p-1" aria-label="Canvas actions">
              {projectId && <>
                <Button variant="ghost" size="compact" className="w-full justify-start gap-2 px-3" disabled={navigation.pending} onClick={() => { setActionsOpen(false); setName(title ?? ''); setEditing(true) }}><Pencil />Rename canvas</Button>
                <Button variant="ghost" size="compact" className="w-full justify-start gap-2 px-3" disabled={navigation.pending} onClick={() => void action(navigation.duplicate)}><Copy />Duplicate canvas</Button>
                <Button variant="ghost" size="compact" className="w-full justify-start gap-2 px-3" disabled={navigation.pending} onClick={() => void action(navigation.archive)}><Archive />Archive canvas</Button>
                <Separator />
              </>}
              {projectId && <Button variant="ghost" size="compact" className="h-auto w-full items-start justify-start gap-2 px-3 py-2 whitespace-normal text-left" disabled={navigation.pending} aria-labelledby={`${exportDescriptionId}-label`} aria-describedby={exportDescriptionId} onClick={() => void action(navigation.export)}>
                <Download aria-hidden="true" className="mt-0.5 shrink-0" /><span className="flex min-w-0 flex-col gap-1"><span id={`${exportDescriptionId}-label`}>Export canvas</span><span id={exportDescriptionId} className="text-xs font-normal text-muted-foreground">Artwork, history and conversations. Unsent drafts stay on this device.</span></span>
              </Button>}
              <Button variant="ghost" size="compact" className="w-full justify-start gap-2 px-3" disabled={navigation.pending} onClick={() => input.current?.click()}><Upload />Import canvas</Button>
              {archived && entries.length > 0 && <>
                <Separator />
                <Button variant="ghost" size="compact" className="w-full justify-start gap-2 px-3 text-destructive hover:text-destructive" disabled={navigation.pending} onClick={() => { setActionsOpen(false); setDoomed(entries) }}><Trash2 />{entries.length === 1 ? 'Delete this canvas…' : `Delete ${entries.length} canvases…`}</Button>
              </>}
              {hasMigrationBackup && <Button variant="ghost" size="compact" className="w-full justify-start gap-2 px-3" onClick={onExportBackup}><Download />Pre-upgrade backup</Button>}
            </PopoverContent>
          </Popover>
        </footer>
        {navigation.operation && <p role="status" className="flex shrink-0 items-center gap-2 px-3 py-2 text-sm text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />{canvasOperationLabel[navigation.operation]}</p>}
        {error && <p role="alert" className="shrink-0 px-3 py-2 text-sm wrap-anywhere text-destructive">{error}</p>}
        {note && <p role="status" className="shrink-0 px-3 py-2 text-sm text-muted-foreground">{note}</p>}
      </PopoverContent>
    </Popover>
    <AlertDialog.Root open={doomed !== null} onOpenChange={value => { if (!value) setDoomed(null) }}>
      <AlertDialog.Portal><AlertDialog.Overlay className="fixed inset-0 z-(--layer-popup) bg-background/70" /><AlertDialog.Content className="glass-surface fixed top-1/2 left-1/2 z-(--layer-popup) w-96 max-w-[calc(100vw_-_32px)] -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-2xl p-6">
        <AlertDialog.Title className="text-base font-medium">{doomed?.length === 1 ? `Delete “${doomed[0]!.title}”?` : `Delete ${doomed?.length ?? 0} archived canvases?`}</AlertDialog.Title>
        <AlertDialog.Description className="text-sm leading-relaxed text-muted-foreground">{doomed && doomed.length > 1 && `${doomed.slice(0, 3).map(item => `“${item.title}”`).join(', ')}${doomed.length > 3 ? ` and ${doomed.length - 3} more` : ''}. `}{doomed?.length === 1 ? 'Its' : 'Their'} artwork, history, conversations, drafts and the files Galta kept on this device are removed. This can’t be undone.</AlertDialog.Description>
        <div className="flex flex-wrap justify-end gap-2"><AlertDialog.Cancel asChild><Button variant="ghost">Cancel</Button></AlertDialog.Cancel><Button variant="destructive" onClick={() => { if (doomed) void removeCanvases(doomed) }}>{doomed?.length === 1 ? 'Delete' : `Delete ${doomed?.length ?? 0}`}</Button></div>
      </AlertDialog.Content></AlertDialog.Portal>
    </AlertDialog.Root>
    <input ref={input} type="file" aria-label="Import canvas file" accept=".galta,.json" hidden disabled={navigation.pending} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void action(() => navigation.import(file)) }} />
  </>
}

function visitLabel(time: number) {
  const days = Math.floor((Date.now() - time) / 86_400_000)
  if (days < 1) return 'Today'
  if (days === 1) return 'Yesterday'
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(time)
}
