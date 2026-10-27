import type { WorkspaceBundle } from './index'

type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined
}

/** IndexedDB preserves shared object references. Intern immutable payloads
 * across history, retaining exact coordinates, content and metadata. */
export function shareWorkspaceAssets(bundle: WorkspaceBundle): WorkspaceBundle {
  const assets = new Map<string, RecordValue[]>()
  const geometry = new Map<string, unknown[][]>()
  const sharedArrays = new WeakMap<unknown[], unknown[]>()
  function internArray(id: string, value: unknown[]): unknown[] {
    const cached = sharedArrays.get(value)
    if (cached) return cached
    const key = `${id}:${value.length}`, variants = geometry.get(key) ?? []
    const existing = variants.find(other => other === value || value.every((item, index) => {
      const previous = other[index]
      return Object.is(item, previous) || Array.isArray(item) && Array.isArray(previous) && item.length === previous.length && item.every((n, i) => Object.is(n, previous[i]))
    }))
    if (!existing) { variants.push(value); geometry.set(key, variants) }
    const result = existing ?? value
    sharedArrays.set(value, result)
    return result
  }
  function intern(id: string, value: RecordValue): RecordValue {
    const variants = assets.get(id) ?? [], keys = Object.keys(value)
    const existing = variants.find(other => other === value || Object.keys(other).length === keys.length && keys.every(key => Object.hasOwn(other, key) && other[key] === value[key]))
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
      if (!file || !(file.blob instanceof Blob) && typeof file.dataURL !== 'string') continue
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
