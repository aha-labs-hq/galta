import { convertToExcalidrawElements, restoreElements } from '@excalidraw/excalidraw'
import type { ExcalidrawElement, FileId } from '@excalidraw/excalidraw/element/types'
import type { BinaryFiles } from '@excalidraw/excalidraw/types'
import type { WorkspaceBundle } from '@galta/storage'
import { canonicalManagedArtifactReference } from '@galta/canvas'
import { imageBytes, imageFile } from './imageImport'
import { validateSnapshot, type SceneSnapshot } from './scene'

/** Expected data/migration failures are distinct from download or runtime
 * failures. The caller may translate these without blaming a valid file for a
 * broken transport. Storage migration retains the original diagnostic. */
export class CanvasMigrationError extends Error {
  constructor(readonly reason: 'contents' | 'version' | 'legacy', message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'CanvasMigrationError'
  }
}
const migrationSnapshot = (value: unknown, checked?: Parameters<typeof validateSnapshot>[1]) => {
  try { return validateSnapshot(value, checked) }
  catch (cause) { throw new CanvasMigrationError('contents', cause instanceof Error ? cause.message : String(cause), { cause }) }
}
import { normalizeFreeDraw } from './freeDraw'

const colors: Record<string, string> = { black: '#1e1e1e', grey: '#868e96', white: '#ffffff', red: '#e03131', 'light-red': '#ff8787', blue: '#1971c2', 'light-blue': '#74c0fc', green: '#2f9e44', 'light-green': '#8ce99a', yellow: '#ffd43b', orange: '#f08c00', violet: '#6741d9', 'light-violet': '#b197fc' }
function richText(node: any): string { return typeof node?.text === 'string' ? node.text : (node?.content ?? []).map(richText).join(node?.type === 'doc' ? '\n' : '') }
function half(bits: number) { const sign = bits & 32768 ? -1 : 1, exp = (bits >> 10) & 31, fraction = bits & 1023; return sign * (exp ? (1 + fraction / 1024) * 2 ** (exp - 15) : fraction * 2 ** -24) }
export function legacyStrokePoints(segment: any): number[][] {
  if (Array.isArray(segment.points)) return segment.points.map((p: any) => [p.x, p.y])
  if (typeof segment.path !== 'string') throw new CanvasMigrationError('legacy', 'Unsupported legacy stroke encoding')
  if (!segment.path) return []
  const bytes = Uint8Array.from(atob(segment.path), c => c.charCodeAt(0)), data = new DataView(bytes.buffer), dim = segment.dim === 2 ? 2 : 3
  if (bytes.length < dim * 4 || (bytes.length - dim * 4) % (dim * 2)) throw new CanvasMigrationError('contents', 'Corrupt legacy stroke')
  let x = data.getFloat32(0, true), y = data.getFloat32(4, true)
  const points = [[x, y]]
  for (let i = dim * 4; i < bytes.length; i += dim * 2) { x += half(data.getUint16(i, true)); y += half(data.getUint16(i + 2, true)); points.push([x, y]) }
  return points
}

/** One-way data migration only. No old editor is shipped or used at runtime.
 * Unknown records fail the entire migration before any persisted replacement. */
export async function migrateWorkspace(workspace: WorkspaceBundle): Promise<WorkspaceBundle> {
  const snapshots: Record<string, SceneSnapshot> = {}
  const downloads = new Map<string, Promise<string>>()
  let changed = false
  const geometry = { points: new WeakSet<object>(), pressures: new WeakSet<object>() }
  for (const [commitId, raw] of Object.entries(workspace.snapshots)) {
    const old = raw as any
    if (old?.engine === 'excalidraw') {
      const snapshot = migrationSnapshot(old, geometry)
      const elements = snapshot.document.elements.map(element => {
        const path = element.customData?.generatedPath
        if (typeof path !== 'string') return element
        const generatedPath = canonicalManagedArtifactReference(path)
        if (generatedPath === path) return element
        changed = true
        return { ...element, customData: { ...element.customData, generatedPath } }
      })
      snapshots[commitId] = elements.every((element, index) => element === snapshot.document.elements[index]) ? snapshot : { ...snapshot, document: { ...snapshot.document, elements } }
      continue
    }
    if (!old?.document?.store) throw new CanvasMigrationError('version', `Unsupported canvas version ${commitId}. Original data is preserved.`)
    changed = true
    const store = old.document.store as Record<string, any>
    const shapes = Object.values(store).filter(s => s.typeName === 'shape').sort((a, b) => a.index.localeCompare(b.index))
    const pages = new Set(shapes.map(s => s.parentId).filter(id => String(id).startsWith('page:')))
    if (pages.size > 1) throw new CanvasMigrationError('legacy', 'This older canvas has multiple pages. Export each page before migration; no data was changed.')
    const elements: ExcalidrawElement[] = [], files: BinaryFiles = {}
    for (const s of shapes) {
      const p = s.props
      if (store[s.parentId]?.typeName === 'shape') throw new CanvasMigrationError('legacy', `Legacy nested object ${s.id} requires flattening before migration. No data was changed.`)
      const base = { id: s.id, x: s.x, y: s.y, angle: s.rotation ?? 0, opacity: Math.round((s.opacity ?? 1) * 100), locked: Boolean(s.isLocked), strokeColor: colors[p.color] ?? '#1e1e1e', strokeWidth: ({ s: 1, m: 2, l: 3, xl: 4 } as Record<string, number>)[p.size] ?? 2, roughness: p.dash === 'draw' ? 1 : 0, customData: s.meta }
      let element: any
      if (s.type === 'image') {
        const asset = store[p.assetId]
        if (!asset?.props.src || p.crop) throw new CanvasMigrationError('legacy', `Legacy image ${s.id} is missing its source or has a crop requiring export. No data was changed.`)
        const url = asset.props.src as string
        if (!downloads.has(url)) downloads.set(url, imageBytes(url))
        const file = { ...imageFile(await downloads.get(url)!), id: p.assetId as FileId }
        files[file.id] = file
        element = { ...base, type: 'image', width: p.w, height: p.h, fileId: file.id, status: 'saved', scale: [p.flipX ? -1 : 1, p.flipY ? -1 : 1], customData: { ...s.meta, ...asset.meta } }
      } else if (s.type === 'text') {
        const text = richText(p.richText) || p.text || ''
        const fontSize = ({ s: 18, m: 24, l: 36, xl: 44 } as Record<string, number>)[p.size] ?? 24
        const converted = convertToExcalidrawElements([{ ...base, type: 'text', text, fontSize, fontFamily: p.font === 'mono' ? 3 : p.font === 'sans' ? 2 : 5, ...(p.autoSize === false ? { width: p.w, autoResize: false } : {}) }], { regenerateIds: false })
        // The skeleton converter shrinks width to its initial text measurement,
        // even for autoResize:false. Preserve the user's fixed-width box; the
        // engine recalculates wrapping after its bundled font is ready.
        elements.push(...converted.map(el => p.autoSize === false ? { ...el, width: p.w } : el)); continue
      } else if (s.type === 'geo') {
        const type = ({ rectangle: 'rectangle', ellipse: 'ellipse', diamond: 'diamond' } as Record<string, string>)[p.geo]
        if (!type || richText(p.richText)) throw new CanvasMigrationError('legacy', `Unsupported legacy shape ${p.geo} or bound label. No data was changed.`)
        element = { ...base, type, width: p.w, height: p.h + (p.growY ?? 0), fillStyle: 'solid', backgroundColor: p.fill === 'none' ? 'transparent' : base.strokeColor }
      } else if (s.type === 'draw' || s.type === 'highlight') {
        const points = p.segments.flatMap(legacyStrokePoints)
        element = { ...base, type: 'freedraw', points, pressures: [], simulatePressure: true }
      } else throw new CanvasMigrationError('legacy', `Unsupported legacy ${s.type} object. Your original workspace is preserved.`)
      elements.push(...restoreElements([normalizeFreeDraw(element)], null))
    }
    const camera = old.session?.pageStates?.find((p: any) => p.pageId === old.session.currentPageId)?.camera ?? { x: 0, y: 0, z: 1 }
    snapshots[commitId] = migrationSnapshot({ engine: 'excalidraw', version: 1, document: { elements, files }, view: { scrollX: camera.x, scrollY: camera.y, zoom: camera.z } })
  }
  return changed ? { ...workspace, snapshots } : workspace
}
