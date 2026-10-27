import type { WorkspaceBundle } from '@galta/storage'

export type WorkspaceRevision = { projectId: string; writerId: string; revision: number }

/**
 * Broadcasts committed workspace revisions between open Galta panels. The
 * database remains the source of truth; this channel is only an invalidation
 * signal and never carries canvas bytes.
 */
export class WorkspaceSync {
  private readonly writerId = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  private channel: BroadcastChannel | undefined
  private readonly projectId: string

  constructor(projectId: string) { this.projectId = projectId }

  publish(bundle: WorkspaceBundle) {
    if (typeof BroadcastChannel === 'undefined') return
    // A queued database save can finish after its view has unsubscribed.
    const channel = this.channel ?? new BroadcastChannel('galta-workspace-sync')
    try { channel.postMessage({ projectId: this.projectId, writerId: this.writerId, revision: bundle.revision ?? 0 } satisfies WorkspaceRevision) }
    finally { if (channel !== this.channel) channel.close() }
  }

  subscribe(listener: (revision: WorkspaceRevision) => void) {
    if (typeof BroadcastChannel === 'undefined') return () => undefined
    const channel = this.channel ??= new BroadcastChannel('galta-workspace-sync')
    const onMessage = (event: MessageEvent<unknown>) => {
      const value = event.data as Partial<WorkspaceRevision> | null
      if (!value || value.projectId !== this.projectId || value.writerId === this.writerId || !Number.isSafeInteger(value.revision)) return
      listener(value as WorkspaceRevision)
    }
    channel.addEventListener('message', onMessage)
    return () => channel.removeEventListener('message', onMessage)
  }

  isNewer(bundle: WorkspaceBundle, revision: WorkspaceRevision) {
    return revision.revision > (bundle.revision ?? 0)
  }

  close() { this.channel?.close(); this.channel = undefined }
}
