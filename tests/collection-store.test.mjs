import { test, expect, beforeEach, afterAll } from 'bun:test'

const originalChrome = globalThis.chrome
let stored
const local = {
  async get(key) { return { [key]: stored } },
  async set(values) { stored = values[Object.keys(values)[0]] },
}
globalThis.chrome = { storage: { local } }
const { addToCollection, listCollection, removeFromCollection } = await import('../apps/extension/src/background/collectionStore.ts')

beforeEach(() => { stored = [] })
afterAll(() => { globalThis.chrome = originalChrome })

test('serializes concurrent source-tab saves without dropping either reference', async () => {
  const [first, second] = await Promise.all([
    addToCollection({ mediaUrl: 'https://cdn.example.com/first.jpg', pageUrl: 'https://example.com/one' }),
    addToCollection({ mediaUrl: 'https://cdn.example.com/second.jpg', pageUrl: 'https://example.com/two' }),
  ])
  const saved = await listCollection()
  expect(new Set(saved.map(item => item.mediaUrl))).toEqual(new Set([first.mediaUrl, second.mediaUrl]))
  expect(saved).toHaveLength(2)
})

test('removes one durable record and leaves the other reference intact', async () => {
  const first = await addToCollection({ mediaUrl: 'https://cdn.example.com/first.jpg' })
  const second = await addToCollection({ mediaUrl: 'https://cdn.example.com/second.jpg' })
  expect(await removeFromCollection(first.id)).toEqual([second])
  expect(await listCollection()).toEqual([second])
})
