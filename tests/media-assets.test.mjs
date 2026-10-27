import { test, expect } from 'bun:test'
import { readResponseBlob } from '../packages/canvas/src/assets'

test('media downloads stop at the declared or streamed byte limit and preserve valid binary bytes', async () => {
  let cancelled = false, pulls = 0
  const stream = () => new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(8)) }, cancel() { cancelled = true } })
  await expect(readResponseBlob(new Response(stream(), { headers: { 'content-length': '100' } }), 16, 'Too large')).rejects.toThrow('Too large')
  expect(cancelled).toBe(true)
  cancelled = false; pulls = 0
  await expect(readResponseBlob(new Response(stream()), 16, 'Too large')).rejects.toThrow('Too large')
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(cancelled).toBe(true); expect(pulls).toBeLessThanOrEqual(5)
  const blob = await readResponseBlob(new Response(new Uint8Array([2, 4, 6]), { headers: { 'content-type': 'video/webm' } }), 3, 'Too large')
  expect(blob.type).toBe('video/webm'); expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([2, 4, 6]))
})
