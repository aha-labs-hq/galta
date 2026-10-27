import { test, expect } from 'bun:test'
import { addCollectionItem, COLLECTION_LIMIT, normalizeCollection, removeCollectionItem } from '../apps/extension/src/shared/collection.ts'

test('collection keeps source and browsing page provenance while deduplicating newest first', () => {
  const first = addCollectionItem([], {
    mediaUrl: 'https://cdn.example.com/a.jpg',
    sourceUrl: 'https://www.example.com/pin/1',
    pageUrl: 'https://www.example.com/search?q=quiet',
    title: ' Quiet object ',
    pageTitle: ' Search results ',
  }, 10, 'a')
  const second = addCollectionItem(first, {
    mediaUrl: 'https://cdn.example.com/b.jpg',
    pageUrl: 'https://www.example.com/',
  }, 20, 'b')
  const refreshed = addCollectionItem(second, {
    mediaUrl: 'https://cdn.example.com/a.jpg',
    sourceUrl: 'https://www.example.com/pin/1',
    pageUrl: 'https://www.example.com/pin/1',
    title: 'Updated title',
  }, 30, 'ignored')
  expect(refreshed.map(item => item.id)).toEqual(['a', 'b'])
  expect(refreshed[0]).toMatchObject({ id: 'a', title: 'Updated title', pageUrl: 'https://www.example.com/pin/1', collectedAt: 30 })
})

test('normalization rejects non-web media and preserves the newest valid record', () => {
  const result = normalizeCollection([
    { id: 'bad', mediaUrl: 'file:///tmp/a.png', collectedAt: 99 },
    { id: 'old', mediaUrl: 'https://cdn.example.com/a.jpg', collectedAt: 10, pageUrl: 'https://example.com/old' },
    { id: 'new', mediaUrl: 'https://cdn.example.com/a.jpg', collectedAt: 20, pageUrl: 'https://example.com/new' },
  ])
  expect(result).toEqual([{ id: 'new', mediaUrl: 'https://cdn.example.com/a.jpg', pageUrl: 'https://example.com/new', collectedAt: 20 }])
})

test('removal is an immutable operation', () => {
  const items = normalizeCollection([{ id: 'a', mediaUrl: 'https://cdn.example.com/a.jpg', collectedAt: 1 }, { id: 'b', mediaUrl: 'https://cdn.example.com/b.jpg', collectedAt: 2 }])
  expect(removeCollectionItem(items, 'a').map(item => item.id)).toEqual(['b'])
  expect(items.map(item => item.id)).toEqual(['b', 'a'])
})

test('collection retains a thousand lightweight references for retrieval', () => {
  const items = Array.from({ length: 1000 }, (_, index) => ({ mediaUrl: `https://cdn.example.com/${index}.jpg`, collectedAt: index + 1 }))
  expect(COLLECTION_LIMIT).toBe(1000)
  expect(normalizeCollection(items)).toHaveLength(1000)
  expect(addCollectionItem(items, { mediaUrl: 'https://cdn.example.com/new.jpg' }, 2000)).toHaveLength(1000)
})
