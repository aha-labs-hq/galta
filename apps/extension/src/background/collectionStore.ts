import { addCollectionItem, COLLECTION_STORAGE_KEY, normalizeCollection, removeCollectionItem, type CollectionItem, type CollectionItemInput } from '../shared/collection'

/* chrome.storage.local is the extension-wide authority. A short serialized
 * queue prevents two source tabs collecting at the same time from overwriting
 * one another with stale reads. The queue is deliberately local to the
 * service-worker lifetime; every operation still reads the durable value first.
 */
let writes = Promise.resolve()

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const next = writes.then(operation, operation)
  writes = next.then(() => undefined, () => undefined)
  return next
}

async function read(): Promise<CollectionItem[]> {
  const result = await chrome.storage.local.get(COLLECTION_STORAGE_KEY)
  return normalizeCollection(result[COLLECTION_STORAGE_KEY])
}

async function write(items: readonly CollectionItem[]): Promise<void> {
  await chrome.storage.local.set({ [COLLECTION_STORAGE_KEY]: items })
}

export function listCollection(): Promise<CollectionItem[]> {
  return read()
}

export function addToCollection(input: CollectionItemInput): Promise<CollectionItem> {
  return serialized(async () => {
    const next = addCollectionItem(await read(), input)
    await write(next)
    return next[0]!
  })
}

export function removeFromCollection(id: string): Promise<CollectionItem[]> {
  return serialized(async () => {
    const next = removeCollectionItem(await read(), id)
    await write(next)
    return next
  })
}
