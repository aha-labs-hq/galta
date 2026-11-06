import { test, expect } from 'bun:test'
import { modelTransport } from '../native/adapters/codex/transport.ts'
const page = (items, nextCursor = null) => ({ data: items.map(item => ({ item })), nextCursor })
const text = content => ({ type: 'userMessage', content: [{ type: 'text', text: content }] })
const small = async () => page([text('A small conversation')])
const input = { threadId: 'thread', inputBytes: 400 }

test('new and small threads retain WebSocket without reading any private Codex files', async () => {
  const calls = []
  const request = async (...args) => { calls.push(args); return small() }
  expect(await modelTransport({ inputBytes: 100 }, request)).toEqual({ modelProvider: 'galta_openai', reason: 'websocket' })
  expect(calls).toHaveLength(0)
  expect(await modelTransport(input, request)).toEqual({ modelProvider: 'galta_openai', reason: 'websocket' })
  expect(calls[0]).toEqual(['thread/items/list', { threadId: 'thread', cursor: undefined, limit: 32, sortDirection: 'desc' }])
})
test('large current input and accumulated image results select HTTP before starting a model turn', async () => {
  expect((await modelTransport({ inputBytes: 9 * 1024 * 1024 }, () => { throw Error('unexpected read') })).modelProvider).toBe('galta_openai_http')
  let calls = 0
  const result = await modelTransport(input, async () => { calls++; return page([{ type: 'imageGeneration', result: 'a'.repeat(5 * 1024 * 1024) }], String(calls)) })
  expect(result).toEqual({ modelProvider: 'galta_openai_http', reason: 'large-context' })
  expect(calls).toBe(2)
})
test('view_image path receipts count encoded pixels and unreadable images never imply empty context', async () => {
  const request = async () => page([{ type: 'imageView', path: '/fixture/image.png' }])
  expect((await modelTransport(input, request, async path => { expect(path).toBe('/fixture/image.png'); return 7 * 1024 * 1024 })).reason).toBe('large-context')
  expect((await modelTransport(input, request, async () => { throw Error('missing') })).reason).toBe('unmeasured-context')
})
test('unknown or pathological history is bounded and does not trigger compaction or replay', async () => {
  for (const request of [async () => { throw Error('unsupported RPC') }, async () => ({}), async () => page([],'repeated')]) {
    expect((await modelTransport(input, request)).reason).toBe('unmeasured-context')
  }
  let calls = 0
  expect((await modelTransport(input, async method => { expect(method).toBe('thread/items/list'); return page([], String(++calls)) })).reason).toBe('unmeasured-context')
  expect(calls).toBe(64)
})
test('compaction does not imply historical images have disappeared from the next request', async () => {
  const result = await modelTransport(input, async () => page([{ type: 'contextCompaction', id: 'compact' }, text('a'.repeat(9 * 1024 * 1024))]))
  expect(result.reason).toBe('large-context')
})
test('malformed input fails before any history access', async () => {
  for (const params of [{ inputBytes: -1 }, { inputBytes: NaN }, { inputBytes: 2 ** 32 }, { inputBytes: 1, threadId: '../other' }]) {
    await expect(modelTransport(params, () => { throw Error('unexpected read') })).rejects.toThrow('Invalid model transport')
  }
})
