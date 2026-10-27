import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { type WorkspaceBundle, type WorkspaceSummary } from '@galta/storage'
import { readPortableWorkspace } from './portableMedia'
import { AlertDialog } from 'radix-ui'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkspaceMenu } from './WorkspaceMenu'
import { canvasAddress, canvasOperationLabel, type CanvasOperation, type CanvasNavigation, type CanvasSessionHandle, type CanvasSessionProps } from './canvasNavigation'
import { CanvasFileError } from './canvasFileError'
import { announceCatalog, catalogEvent, detachImportedCanvas, duplicateCanvas, initializeLibrary, loadCanvas, newCanvas, restoreCanvas } from './canvasLibrary'
import { migrateWorkspace, CanvasMigrationError } from './migrateWorkspace'
import { workspaceRepository } from './workspace'
import { WorkspaceSync } from './workspaceSync'
import { forgetPanelCanvas, initialCanvasId, rememberPanelCanvas } from './panelCanvas'
import { removeCanvasFiles } from './canvasFiles'
import { deleteCanvas } from './canvasDeletion'
import { deleteCanvasDrafts } from './messageDrafts'
import { ExtensionCodexRpc } from './codexRpc'
import { CodexConnection } from './codexConnection'

export function CanvasWorkspace({ Session }: { Session: ComponentType<CanvasSessionProps> }) {
  const [current, setCurrent] = useState<WorkspaceBundle | null>(null)
  const [visit, setVisit] = useState(0)
  const [entries, setEntries] = useState<WorkspaceSummary[]>([])
  const [ready, setReady] = useState(false), [operation, setOperation] = useState<CanvasOperation | null>(null), [error, setError] = useState('')
  const pending = operation !== null
  const [confirmation, setConfirmation] = useState<'agent' | 'import' | null>(null)
  const answer = useRef<(value: boolean) => void>(() => {})
  const sessionRef = useRef<CanvasSessionHandle | null>(null), busy = useRef(false)
  const codexRpc = useMemo(() => new ExtensionCodexRpc(), [])
  const codexConnection = useMemo(() => new CodexConnection(codexRpc), [codexRpc])
  useEffect(() => {
    let active = true
    const stop = codexConnection.start()
    const enabled = codexConnection.subscribe(() => {
      if (codexConnection.getSnapshot().status === 'connected' && globalThis.chrome?.storage?.local) {
        void chrome.storage.local.set({ 'galta.ai.enabled': true }).catch(() => undefined)
      }
    })
    if (globalThis.chrome?.storage?.local) void chrome.storage.local.get('galta.ai.enabled').then(saved => {
      if (active && saved['galta.ai.enabled'] === true && codexConnection.getSnapshot().status === 'disconnected') void codexConnection.connect()
    }).catch(() => undefined)
    const wake = () => { if (document.visibilityState === 'visible') void codexConnection.refresh() }
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', wake)
    document.addEventListener('resume', wake)
    return () => {
      active = false; enabled(); stop()
      window.removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', wake)
      document.removeEventListener('resume', wake)
    }
  }, [codexConnection])
  const currentRef = useRef(current); currentRef.current = current
  const refresh = useCallback(async () => { setEntries(await workspaceRepository.list()) }, [])
  const panel = location.pathname === '/sidepanel/index.html'
  useEffect(() => {
    let active = true
    void (async () => {
      const items = await initializeLibrary()
      if (!active) return
      setEntries(items)
      const explicit = await initialCanvasId(new URL(location.href).searchParams.get('project'))
      const id = explicit ?? items.find(item => !item.archivedAt)?.id
      if (id) {
        const bundle = await loadCanvas(id)
        if (!active) return
        // The browser owns the panel URL; its project lives in session storage.
        // Full tabs retain handoff parameters until the receiving scene is ready.
        if (!panel) {
          const address = new URL(location.href); address.searchParams.set('project', id)
          history.replaceState(null, '', address)
        }
        setCurrent(bundle)
        if (location.pathname === '/sidepanel/index.html') await rememberPanelCanvas(bundle.project.id)
        await workspaceRepository.visit(bundle.project.id)
      }
      // Canvases not opened lately still hold previews of old versions;
      // release them once the opened canvas has the browser's attention.
      requestIdleCallback(() => { void workspaceRepository.pruneAllPreviews().catch(error => console.warn('Old canvas previews were not released', String(error))) }, { timeout: 10_000 })
    })().catch(error => { if (active) setError(String(error.message ?? error)) }).finally(() => { if (active) setReady(true) })
    const notify = () => { void refresh().catch(error => setError(String(error))) }
    const channel = new BroadcastChannel(catalogEvent); channel.onmessage = notify
    window.addEventListener(catalogEvent, notify)
    return () => { active = false; channel.close(); window.removeEventListener(catalogEvent, notify); answer.current(false) }
  }, [refresh])

  const prepare = async () => {
    const session = sessionRef.current
    const activity = session?.activity()
    if (activity === 'external') throw new Error('An external agent is using this canvas. End its connection before switching.')
    if (activity) {
      setConfirmation(activity)
      const accepted = await new Promise<boolean>(resolve => { answer.current = resolve })
      setConfirmation(null)
      if (!accepted) return null
      await session!.stop()
    }
    return session ? await session.prepare() : currentRef.current
  }
  // Project navigation and metadata changes share one owner. A late
  // completion can never replace a different active session.
  const exclusive = async (kind: CanvasOperation, action: () => Promise<void>) => {
    if (busy.current) throw new Error('A canvas operation is already in progress. Wait for it to finish.')
    busy.current = true; setOperation(kind); setError('')
    const session = sessionRef.current
    const operationId = crypto.randomUUID()
    try { await action() }
    catch (error) {
      // File contents and parser snippets are untrusted, potentially private
      // data. Stable failure codes diagnose this input boundary without them.
      if (kind === 'import' || kind === 'export') console.warn('Galta canvas file operation failed', { operationId, projectId: currentRef.current?.project.id, operation: kind, ...(error instanceof CanvasFileError ? { reason: error.reason } : {}), failureType: error instanceof Error ? error.name : typeof error })
      throw error
    }
    finally { session?.resume(); busy.current = false; setOperation(null) }
  }
  const transition = (kind: CanvasOperation, change: (saved: WorkspaceBundle | null) => Promise<WorkspaceBundle | null>) => exclusive(kind, async () => {
    const saved = await prepare()
    if (currentRef.current && !saved) return
    const next = await change(saved)
    if (!panel) {
      if (next) history.replaceState(null, '', canvasAddress(next.project.id))
      else {
        const address = new URL(location.href); address.searchParams.delete('project'); address.hash = ''
        history.replaceState(null, '', address)
      }
    }
    sessionRef.current = null
    setVisit(value => value + 1)
    setCurrent(next)
    announceCatalog()
    // The document action has committed. An ancillary visit/preference error
    // must not present a failed creation and invite a duplicate retry.
    try {
      if (next) await workspaceRepository.visit(next.project.id)
      if (location.pathname === '/sidepanel/index.html') await rememberPanelCanvas(next?.project.id ?? null)
      await refresh()
    } catch (error) { setError(`Canvas updated, but its navigation preference could not be saved. ${String(error)}`) }
  })

  const navigation: CanvasNavigation = {
    entries, pending, operation, refresh,
    open: async id => { if (id !== currentRef.current?.project.id) await transition('open', async () => loadCanvas(id)) },
    create: () => transition('create', async saved => { const bundle = newCanvas(saved?.runtimeDefaults); await workspaceRepository.create(bundle); return bundle }),
    duplicate: () => transition('duplicate', async saved => { if (!saved) throw new Error('Open a canvas to duplicate it.'); const bundle = duplicateCanvas(saved); await workspaceRepository.create(bundle); return bundle }),
    import: file => transition('import', async () => {
      const input = await readPortableWorkspace(file)
      let migrated: WorkspaceBundle, bundle: WorkspaceBundle
      try { migrated = await migrateWorkspace(input) }
      catch (cause) { throw new CanvasFileError(cause instanceof CanvasMigrationError ? cause.reason : 'processing', { cause }) }
      try { bundle = detachImportedCanvas(migrated) }
      catch (cause) { throw new CanvasFileError('contents', { cause }) }
      await workspaceRepository.create(bundle)
      return bundle
    }),
    export: () => exclusive('export', async () => {
      const session = sessionRef.current
      if (!session) throw new Error('Open a canvas to export it.')
      await session.export()
    }),
    rename: title => exclusive('rename', async () => {
      const id = currentRef.current?.project.id
      if (!id) return
      const next = await workspaceRepository.rename(id, title)
      new WorkspaceSync(id).publish(next)
      setCurrent(next); announceCatalog(); await refresh()
    }),
    archive: () => transition('archive', async saved => {
      if (!saved) return null
      const items = await workspaceRepository.list()
      const target = items.find(item => !item.archivedAt && item.id !== saved.project.id)
      const next = target ? await loadCanvas(target.id) : null
      await navigator.locks.request(`galta-execution:${saved.project.id}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) throw new Error('An agent is still working on this canvas. Stop it or let it finish before archiving.')
        const archived = await workspaceRepository.setArchived(saved.project.id, true)
        new WorkspaceSync(saved.project.id).publish(archived)
      })
      return next
    }),
    restore: id => transition('restore', async () => {
      const restored = await restoreCanvas(id)
      new WorkspaceSync(id).publish(restored)
      return restored
    }),
    // One canvas at a time, each completely (see deleteCanvas). A canvas that
    // cannot be deleted stops the rest; ones already deleted stay deleted.
    remove: async ids => {
      const notes: string[] = []
      try {
        await exclusive('delete', async () => {
          for (const id of ids) {
            const entry = (await workspaceRepository.list()).find(item => item.id === id)
            if (!entry) throw new Error('This canvas no longer exists.')
            const note = await navigator.locks.request(`galta-execution:${id}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
              if (!lock) throw new Error(`“${entry.title}” is busy: an agent or another window is using it. Try again when it is done.`)
              return deleteCanvas({ title: entry.title, removeRecords: () => workspaceRepository.remove(id), removeFiles: () => removeCanvasFiles(id),
                removeDrafts: () => deleteCanvasDrafts(id), forget: () => forgetPanelCanvas(id) })
            })
            if (note) notes.push(note)
            announceCatalog()
          }
        })
      } finally { await refresh().catch(error => setError(`Canvases were deleted, but the list could not be refreshed. ${String(error)}`)) }
      return notes.length ? notes.join(' ') : undefined
    }
  }
  if (!ready) return <main className="galta-loading">Opening Galta…</main>
  return <>
    {current ? <Session key={`${current.project.id}:${visit}`} initial={current} projectId={current.project.id} navigation={navigation} sessionRef={sessionRef} codexConnection={codexConnection} codexRpc={codexRpc} /> :
      <TooltipProvider><main className="galta-shell" data-build={__GALTA_BUILD__.source}>
        <header className="galta-topbar pointer-events-none absolute inset-x-0 top-0 z-(--layer-header) flex items-start justify-between gap-6 px-6 pt-5 md:px-8 md:pt-6"><div className="galta-brand pointer-events-auto flex min-w-0 max-w-[min(100%,420px)] items-center text-foreground"><WorkspaceMenu navigation={navigation} /></div></header>
        <div className="grid h-full place-content-center gap-4 px-8 text-center"><p className="text-lg" role={pending ? 'status' : undefined}>{operation ? canvasOperationLabel[operation] : 'A fresh place to begin.'}</p><Button className="mx-auto" disabled={pending} onClick={() => void navigation.create().catch(error => setError(error instanceof Error ? error.message : String(error)))}><Plus />New canvas</Button></div>
      </main></TooltipProvider>}
    {error && <div className="canvas-notice glass-surface" role="alert">{error}<Button variant="ghost" size="icon" aria-label="Dismiss canvas error" title="Dismiss error" onClick={() => setError('')}><X /></Button></div>}
    <AlertDialog.Root open={confirmation !== null} onOpenChange={open => { if (!open) answer.current(false) }}>
      <AlertDialog.Portal><AlertDialog.Overlay className="fixed inset-0 z-(--layer-popup) bg-background/70" /><AlertDialog.Content className="glass-surface fixed top-1/2 left-1/2 z-(--layer-popup) w-96 max-w-[calc(100vw_-_32px)] -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-2xl p-6">
        <AlertDialog.Title className="text-base font-medium">{confirmation === 'import' ? 'Media is still arriving' : 'This canvas is still working'}</AlertDialog.Title>
        <AlertDialog.Description className="text-sm leading-relaxed text-muted-foreground">{confirmation === 'import' ? 'Cancel the unfinished import to leave this canvas.' : 'Stop this task before switching. Completed changes stay with this canvas.'}</AlertDialog.Description>
        <div className="flex flex-wrap justify-end gap-2"><AlertDialog.Cancel asChild><Button variant="ghost" onClick={() => answer.current(false)}>Stay here</Button></AlertDialog.Cancel><AlertDialog.Action asChild><Button onClick={() => answer.current(true)}>{confirmation === 'import' ? 'Cancel import and switch' : 'Stop and switch'}</Button></AlertDialog.Action></div>
      </AlertDialog.Content></AlertDialog.Portal>
    </AlertDialog.Root>
  </>
}
