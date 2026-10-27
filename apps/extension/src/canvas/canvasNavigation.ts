import type { ProjectId } from '@galta/domain'
import type { WorkspaceBundle, WorkspaceSummary } from '@galta/storage'
import type { MutableRefObject } from 'react'
import type { CodexConnection } from './codexConnection'
import type { ExtensionCodexRpc } from './codexRpc'

export type CanvasSessionHandle = {
  prepare(): Promise<WorkspaceBundle>
  export(): Promise<void>
  activity(): 'agent' | 'external' | 'import' | null
  stop(): Promise<void>
  resume(): void
}

export type CanvasOperation = 'open' | 'create' | 'duplicate' | 'import' | 'export' | 'rename' | 'archive' | 'restore' | 'delete'
export const canvasOperationLabel: Record<CanvasOperation, string> = {
  open: 'Opening canvas…', create: 'Creating canvas…', duplicate: 'Duplicating canvas…',
  import: 'Importing canvas…', export: 'Exporting canvas…', rename: 'Saving canvas name…',
  archive: 'Archiving canvas…', restore: 'Restoring canvas…', delete: 'Deleting canvases…'
}

export type CanvasNavigation = {
  entries: WorkspaceSummary[]
  pending: boolean
  operation: CanvasOperation | null
  refresh(): Promise<void>
  open(id: ProjectId): Promise<void>
  create(): Promise<void>
  duplicate(): Promise<void>
  import(file: File): Promise<void>
  export(): Promise<void>
  rename(title: string): Promise<void>
  archive(): Promise<void>
  restore(id: ProjectId): Promise<void>
  /** Permanently delete archived canvases. Resolves with a note about anything
   * kept on disk, if any. */
  remove(ids: readonly ProjectId[]): Promise<string | undefined>
}

export type CanvasSessionProps = {
  projectId: ProjectId
  initial: WorkspaceBundle
  navigation: CanvasNavigation
  sessionRef: MutableRefObject<CanvasSessionHandle | null>
  codexConnection: CodexConnection
  codexRpc: ExtensionCodexRpc
}

export function canvasAddress(projectId: string, current = location.href) {
  const address = new URL(current)
  address.searchParams.set('project', projectId)
  const params = new URLSearchParams(address.hash.slice(1))
  params.delete('selection'); params.delete('viewport')
  address.hash = params.toString()
  return address
}
