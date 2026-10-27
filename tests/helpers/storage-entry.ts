// Bundled and injected by tests only; never an extension entry point.
import { portableAsset } from '../../packages/canvas/src'
import { IndexedDbWorkspaceRepository } from '../../packages/storage/src'
Object.assign(globalThis, { __galtaTestRepository: IndexedDbWorkspaceRepository, __galtaTestPortable: async (bundle: any) => {
  if (!bundle) return bundle
  const copy = structuredClone(bundle), encoded = new Map<object, any>()
  for (const snapshot of Object.values(copy.snapshots) as any[]) for (const [id, file] of Object.entries(snapshot?.document?.files ?? {}) as [string, any][]) {
    if (!(file.blob instanceof Blob)) continue
    if (!encoded.has(file)) encoded.set(file, await portableAsset(file))
    snapshot.document.files[id] = encoded.get(file)
  }
  return copy
} })
