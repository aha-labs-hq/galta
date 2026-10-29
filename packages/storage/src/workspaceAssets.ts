import type { WorkspaceBundle } from './index'

type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined
}

/** Versions, elements and files already shared. Each is shared once: a first
 * pass shares every version with every other, and later writes share only the
 * objects their new versions add, against the version each came from. */
const sharedVersions = new WeakSet<object>()
const sharedObjects = new WeakSet<object>()

const sameArray = (value: unknown[], other: unknown[]) => value.length === other.length && value.every((item, index) => {
  const previous = other[index]
  return Object.is(item, previous) || Array.isArray(item) && Array.isArray(previous) && item.length === previous.length && item.every((n, i) => Object.is(n, previous[i]))
})
const sameRecord = (value: RecordValue, other: RecordValue) => {
  const keys = Object.keys(value)
  return Object.keys(other).length === keys.length && keys.every(key => Object.hasOwn(other, key) && other[key] === value[key])
}
const isFile = (file: RecordValue | undefined): file is RecordValue => !!file && (file.blob instanceof Blob || typeof file.dataURL === 'string')

/** IndexedDB preserves shared object references. Intern immutable payloads
 * across history, retaining exact coordinates, content and metadata. */
export function shareWorkspaceAssets(bundle: WorkspaceBundle): WorkspaceBundle {
  const entries = Object.entries(bundle.snapshots)
  const fresh = entries.filter(([, value]) => !(value !== null && typeof value === 'object' && sharedVersions.has(value)))
  if (!fresh.length) return bundle
  const shared = fresh.length === entries.length ? shareAll(bundle) : shareWithParents(bundle, fresh.map(([commit]) => commit))
  for (const [commit] of fresh) {
    const value = shared.snapshots[commit], document = record(record(value)?.document)
    if (value !== null && typeof value === 'object') sharedVersions.add(value)
    for (const file of Object.values(record(document?.files) ?? {})) if (file !== null && typeof file === 'object') sharedObjects.add(file)
    for (const element of Array.isArray(document?.elements) ? document.elements : []) if (element !== null && typeof element === 'object') sharedObjects.add(element)
  }
  return shared
}

/** Each new version against the version it came from: only objects it has not
 * shared before are compared, with the parent's object of the same ID. */
function shareWithParents(bundle: WorkspaceBundle, commits: string[]): WorkspaceBundle {
  const parents = (bundle.project as { commits?: Record<string, { parentId?: string | null }> }).commits ?? {}
  let snapshots: Record<string, unknown> | undefined
  for (const commit of commits) {
    const value = bundle.snapshots[commit], snapshot = record(value), document = record(snapshot?.document)
    const parentId = parents[commit]?.parentId, base = record(record(parentId ? bundle.snapshots[parentId] : undefined)?.document)
    if (!document || !base) continue
    const files = record(document.files), baseFiles = record(base.files)
    let sharedFiles: RecordValue | undefined
    for (const [id, value] of Object.entries(files ?? {})) {
      const file = record(value), other = record(baseFiles?.[id])
      if (!isFile(file) || sharedObjects.has(file) || !other || other === file || !sameRecord(file, other)) continue
      sharedFiles ??= { ...files }; sharedFiles[id] = other
    }
    const elements = Array.isArray(document.elements) ? document.elements : []
    let byId: Map<unknown, RecordValue> | undefined, sharedElements: unknown[] | undefined
    elements.forEach((value, index) => {
      const element = record(value)
      if (!element || sharedObjects.has(element) || typeof element.id !== 'string') return
      byId ??= new Map((Array.isArray(base.elements) ? base.elements : []).map(other => [record(other)?.id, record(other)!]))
      const other = byId.get(element.id)
      if (!other) return
      let next = element
      for (const field of ['points', 'pressures']) {
        const array = element[field], previous = other[field]
        if (Array.isArray(array) && Array.isArray(previous) && array !== previous && sameArray(array, previous)) next = { ...next, [field]: previous }
      }
      const customData = record(element.customData), html = record(customData?.htmlDocument), previousHtml = record(record(other.customData)?.htmlDocument)
      if (element.type === 'embeddable' && typeof html?.html === 'string' && previousHtml && previousHtml !== html && sameRecord(html, previousHtml)) {
        next = { ...next, customData: { ...customData, htmlDocument: previousHtml } }
      }
      if (next !== element) { sharedElements ??= [...elements]; sharedElements[index] = next }
    })
    if (sharedFiles || sharedElements) {
      snapshots ??= { ...bundle.snapshots }
      snapshots[commit] = { ...snapshot, document: { ...document, ...(sharedFiles ? { files: sharedFiles } : {}), ...(sharedElements ? { elements: sharedElements } : {}) } }
    }
  }
  return snapshots ? { ...bundle, snapshots } : bundle
}

/** Every version with every other: compacts histories saved before sharing. */
function shareAll(bundle: WorkspaceBundle): WorkspaceBundle {
  const assets = new Map<string, RecordValue[]>()
  const geometry = new Map<string, unknown[][]>()
  const sharedArrays = new WeakMap<unknown[], unknown[]>()
  function internArray(id: string, value: unknown[]): unknown[] {
    const cached = sharedArrays.get(value)
    if (cached) return cached
    const key = `${id}:${value.length}`, variants = geometry.get(key) ?? []
    const existing = variants.find(other => other === value || sameArray(value, other))
    if (!existing) { variants.push(value); geometry.set(key, variants) }
    const result = existing ?? value
    sharedArrays.set(value, result)
    return result
  }
  function intern(id: string, value: RecordValue): RecordValue {
    const variants = assets.get(id) ?? []
    const existing = variants.find(other => other === value || sameRecord(value, other))
    if (existing) return existing
    variants.push(value); assets.set(id, variants)
    return value
  }
  let snapshots: Record<string, unknown> | undefined
  for (const [commitId, value] of Object.entries(bundle.snapshots)) {
    const snapshot = record(value), document = record(snapshot?.document), files = record(document?.files)
    let shared: RecordValue | undefined
    for (const [id, value] of Object.entries(files ?? {})) {
      const file = record(value)
      if (!isFile(file)) continue
      const existing = intern(`file:${id}`, file)
      if (existing !== file) { shared ??= { ...files }; shared[id] = existing }
    }
    const elements = Array.isArray(document?.elements) ? document.elements : []
    let sharedElements: unknown[] | undefined
    elements.forEach((value, index) => {
      const element = record(value), customData = record(element?.customData), html = record(customData?.htmlDocument)
      if (!element || typeof element.id !== 'string') return
      let next = element
      for (const field of ['points', 'pressures']) {
        const array = element[field]
        if (!Array.isArray(array)) continue
        const existing = internArray(`${element.id}:${field}`, array)
        if (existing !== array) next = { ...next, [field]: existing }
      }
      if (element.type === 'embeddable' && typeof html?.html === 'string') {
        const existing = intern(`html:${element.id}`, html)
        if (existing !== html) next = { ...next, customData: { ...customData, htmlDocument: existing } }
      }
      if (next !== element) { sharedElements ??= [...elements]; sharedElements[index] = next }
    })
    if (shared || sharedElements) {
      snapshots ??= { ...bundle.snapshots }
      snapshots[commitId] = { ...snapshot, document: { ...document, ...(shared ? { files: shared } : {}), ...(sharedElements ? { elements: sharedElements } : {}) } }
    }
  }
  return snapshots ? { ...bundle, snapshots } : bundle
}
