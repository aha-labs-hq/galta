import '../styles.css'
// Test-only entry. Never included in an extension build.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ExcalidrawCanvas } from '../canvas/ExcalidrawCanvas'
import { CanvasScene } from '../canvas/scene'
import { CanvasTool, canvasRevision } from '../canvas/canvasTool'
import { prepareImage, placeImage } from '../canvas/imageImport'
import { applyCreativeOperations } from '../canvas/patchExecutor'
import { migrateWorkspace, legacyStrokePoints } from '../canvas/migrateWorkspace'
import { IndexedDbWorkspaceRepository, exportWorkspace, importWorkspace, normalizeWorkspace, snapshotReference } from '@galta/storage'
import { captureSubmittedContext } from '../canvas/context'
import { tidySelectedImages } from '../canvas/tidy'
import type { CanvasArtifacts, CanvasSlot, CanvasToolScope } from '@galta/canvas'
import { CanvasLocator } from '../canvas/agentFocus'
import { CanvasSlots } from '../canvas/CanvasSlots'
import { runCapabilityChecks } from './capability-checks'
import { exportToCanvas, getCommonBounds, mutateElement } from '@excalidraw/excalidraw'
import { previewGeometry, clonePreviewElement } from '../canvas/previewGeometry'
import { canvasPreviews, previewIdentity } from '../canvas/canvasPreviews'
import { workspaceRepository } from '../canvas/workspace'
import { createAgentInvitation } from '../canvas/agentInvitationScene'
function mount(scene: CanvasScene) {
  const host = window as any
  host.scene = scene
  const missingArtifact = async () => { throw new Error('No test artifact supplied') }
  const artifacts: CanvasArtifacts = { readImage: missingArtifact, readVideo: missingArtifact, readHtml: missingArtifact, writeImage: missingArtifact, deliver: missingArtifact }
  host.testArtifacts = artifacts
  host.engineTest = {
    createAgentInvitation, exportWorkspace, importWorkspace,
    captureSubmittedContext, tidySelectedImages,
    IndexedDbWorkspaceRepository, snapshotReference, previewGeometry, clonePreviewElement, canvasPreviews, previewIdentity, workspaceRepository,
    capturedTool: (submitted: ReturnType<typeof captureSubmittedContext>) => new CanvasTool(scene, artifacts, async mutation => { mutation.apply() }, submitted),
    migrateWorkspace, legacyStrokePoints, normalizeWorkspace, exportToCanvas, getCommonBounds, mutateElement,
    repository: new IndexedDbWorkspaceRepository('galta-migration-test'),
    revision: () => canvasRevision(scene),
    apply: (operations: any) => applyCreativeOperations(scene, operations),
    async import(url: string, point: { x: number; y: number }) { return placeImage(scene, await prepareImage(scene, { url }), point) },
    /** One execution's tool, kept across calls, with its held places drawn over the canvas as in the app. */
    agentTool() {
      const layer = document.body.appendChild(document.createElement('div'))
      layer.style.cssText = 'position:fixed;inset:0;pointer-events:none'
      const view = createRoot(layer), locator = new CanvasLocator(scene, () => ({ left: 0, top: 0, width: innerWidth, height: innerHeight }), document.getElementById('root')!)
      const held = { slots: [] as readonly CanvasSlot[] }
      const tool = new CanvasTool(scene, artifacts, async mutation => { mutation.apply() }, undefined, slots => {
        held.slots = slots
        flushSync(() => view.render(<CanvasSlots locator={locator} slots={slots.map(slot => ({ ...slot, key: slot.id }))} />))
      })
      const scope = { executionId: 'test-execution', cwd: '/tmp/galta-test', signal: new AbortController().signal }
      return { held, execute: (name: string, args: unknown) => tool.execute(name, args, scope), close() { view.unmount(); layer.remove(); locator.close() } }
    },
    async tool(tool: string, args: unknown, scope?: Partial<CanvasToolScope>) {
      return new CanvasTool(scene, artifacts, async mutation => { host.saveEntered?.(); if (host.saveGate) await host.saveGate; if (host.failSave) throw new Error('Storage unavailable'); host.saved = structuredClone(mutation.snapshot); mutation.apply() }).execute(tool, args, { executionId: 'test-execution', provenance: { providerId: 'test', sessionId: 'test-thread', turnId: 'test-turn' }, cwd: '/tmp/galta-test', signal: new AbortController().signal, ...scope })
    }
  }
  if (new URLSearchParams(location.search).has('capability-audit')) {
    // Run after Strict Mode's mount replay has settled; the retired scene
    // must never start a second audit against the same editor.
    requestAnimationFrame(() => {
      if (scene.disposed || host.scene !== scene) return
      void runCapabilityChecks(scene).then(result => {
        host.capabilityResults = result
        const report = document.createElement('pre')
        report.id = 'capability-results'
        report.style.cssText = 'position:fixed;inset:20px;z-index:9999;overflow:auto;background:white;color:black;padding:24px;font:14px monospace'
        report.textContent = JSON.stringify(result, null, 2)
        const download = document.createElement('button')
        download.textContent = 'Download capability verification receipt'
        download.onclick = () => {
          const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2) + '\n'], { type: 'application/json' }))
          const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'galta-capability-verification.json'; anchor.click(); URL.revokeObjectURL(url)
        }
        report.prepend(download, document.createElement('br'))
        document.body.append(report)
        document.title = result.passed ? 'PASS — Galta capability checks' : 'FAIL — Galta capability checks'
      })
    })
  }
  return () => { if (host.scene === scene) delete host.scene }
}
createRoot(document.getElementById('root')!).render(<StrictMode><ExcalidrawCanvas onMount={mount} /></StrictMode>)
