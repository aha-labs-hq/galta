import { test, expect } from 'bun:test'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { BROWSER_TOOLS, CANVAS_TOOLS, CANVAS_PROP_SCHEMA, canvasBoundsSchema, validateBrowserInput, validateCanvasOperations } from '../packages/canvas/src/index.ts'
import { createCanvasMcpServer } from '../native/mcp/server.ts'

const schema = new AjvJsonSchemaValidator().getValidator(structuredClone(CANVAS_TOOLS.find(tool => tool.name === 'canvas_edit').inputSchema))
const browserActionSchema = new AjvJsonSchemaValidator().getValidator(structuredClone(BROWSER_TOOLS.find(tool => tool.name === 'browser_act').inputSchema))
const accepts = operations => schema({ revision: 'observed', operations }).valid

test('nullable arrowheads agree across Zod runtime, generated properties and host discovery', () => {
  const props = new AjvJsonSchemaValidator().getValidator({ type: 'object', properties: CANVAS_PROP_SCHEMA, additionalProperties: false })
  for (const value of [null, 'arrow', 'triangle', 'invalid-head', 1]) {
    const operations = [{ type: 'create_element', elementType: 'arrow', x: 0, y: 0, props: { startArrowhead: value, endArrowhead: value } }]
    const valid = value === null || value === 'arrow' || value === 'triangle'
    expect(props(operations[0].props).valid).toBe(valid)
    expect(accepts(operations)).toBe(valid)
    if (valid) expect(() => validateCanvasOperations(operations)).not.toThrow()
    else expect(() => validateCanvasOperations(operations)).toThrow()
  }
})

test('spatial bounds have the same strict contract in messages and tool outputs', () => {
  const definition = CANVAS_TOOLS.find(tool => tool.name === 'canvas_inspect').outputSchema.properties.elements.items.properties.bounds
  const wire = new AjvJsonSchemaValidator().getValidator(definition)
  for (const bounds of [{ x: -100, y: 20, width: 0, height: 10 }, { x: 0, y: 0, width: -1, height: 10 }, { x: 0, y: 0, height: 10 }, { x: 0, y: 0, width: 10, height: 10, shapeLabel: 'arc' }]) {
    expect(wire(bounds).valid).toBe(canvasBoundsSchema.safeParse(bounds).success)
  }
})

test('operation discovery rejects ambiguous targets and incomplete verbs before execution', () => {
  const valid = [
    { type: 'create_text', id: 'label', text: 'Label', x: 0, y: 0, props: { fontSize: 24 } },
    { type: 'create_element', id: 'card', elementType: 'rectangle', x: 0, y: 0 },
    { type: 'create_element', elementType: 'freedraw', x: 0, y: 0, props: { points: [[0, 0], [10, 10]] } },
    { type: 'create_element', elementType: 'html', x: 0, y: 0, props: { htmlPath: '/workspace/outputs/page.html', width: 800 } },
    { type: 'create_element', elementType: 'image', props: { mediaPath: '/workspace/outputs/image.png', width: 100 } },
    { type: 'create_element', elementType: 'video', x: 10, y: 20, props: { mediaPath: '/workspace/outputs/movie.mp4' } },
    { type: 'update_element', elementId: 'card', props: { opacity: 50, groupIds: ['panel'] } },
    { type: 'move', elementId: 'card', x: 30, y: 40 },
    { type: 'bind_text', elementId: 'label', containerId: null },
    { type: 'bind_arrow', elementId: 'arrow', start: 'card' },
    { type: 'bind_arrow', elementId: 'arrow', end: null },
    { type: 'delete', elementId: 'card' }
  ]
  for (const op of valid) {
    expect(accepts([op])).toBe(true)
    expect(() => validateCanvasOperations([op])).not.toThrow()
  }
  for (const op of [
    { type: 'update_element', id: 'card', props: { opacity: 50 } },
    { type: 'move', id: 'card', x: 30, y: 40 },
    { type: 'delete', elementId: '' }, { type: 'delete', elementId: '  ' },
    { type: 'move', elementId: 'card', x: 30 },
    { type: 'delete', elementId: 'card', props: { opacity: 50 } },
    { type: 'move', elementId: 'card', x: 0, y: 0, props: { opacity: 50 } },
    { type: 'bind_arrow', elementId: 'edge', end: null, props: { opacity: 50 } },
    { type: 'bind_text', elementId: 'label', containerId: null, props: { opacity: 50 } },
    { type: 'update_element', elementId: 'card', props: { misspelledOpacity: 50 } },
    { type: 'create_text', text: 'Label', x: 0, y: 0, props: { misspelledFontSize: 24 } },
    { type: 'create_element', elementType: 'rectangle', x: 0, y: 0, props: { misspelledWidth: 100 } },
    { type: 'update_element', elementId: 'card', props: { opacity: 'half' } },
    { type: 'create_text', text: 'Label' },
    { type: 'create_text', text: 'Label', x: 0, y: 0, props: { mediaPath: '/workspace/image.png' } },
    { type: 'create_text', text: 'Label', x: 0, y: 0, props: { htmlPath: '/workspace/page.html' } },
    { type: 'create_element', elementType: 'rectangle' },
    { type: 'create_element', elementType: 'freedraw', x: 0, y: 0 },
    { type: 'create_element', elementType: 'html', x: 0, y: 0 },
    { type: 'create_element', elementType: 'image' },
    { type: 'create_element', elementType: 'image', x: 0, props: { mediaPath: '/workspace/image.png' } },
    { type: 'bind_arrow', elementId: 'arrow' },
    { type: 'bind_text', elementId: 'label' }
  ]) {
    expect(accepts([op])).toBe(false)
    expect(() => validateCanvasOperations([op])).toThrow()
  }
  expect(() => validateCanvasOperations([valid[0], { type: 'move', id: 'card', x: 1, y: 2 }])).toThrow('operations[1] (move): Missing elementId')
})

test('MCP argument errors identify the failed operation and how to continue without needing a canvas connection', async () => {
  const server = createCanvasMcpServer({ capabilities: [] }), client = new Client({ name: 'Contract verification', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b); await client.connect(a)
  try {
    const status = await client.callTool({ name: 'canvas_inspect', arguments: { limit: 100 } })
    expect(status.isError).toBe(true)
    expect(status.content[0].text).toContain('1 to 64')
    expect(status.content[0].text).toContain('returned next')
    const write = await client.callTool({ name: 'canvas_edit', arguments: { revision: 'observed', operations: [
      { type: 'create_text', text: 'Valid earlier operation', x: 0, y: 0 },
      { type: 'update_element', id: 'card', props: { opacity: 50 } }
    ] } })
    expect(write.isError).toBe(true)
    expect(write.content[0].text).toContain('operations[1] (update_element): Missing elementId')
    expect(write.content[0].text).toContain('Copy the target element id into elementId')
    expect(write.content[0].text).toContain('No edit was applied')
    expect(write.content[0].text).not.toContain('Connect to a canvas')
    const capture = await client.callTool({ name: 'browser_capture', arguments: { ref: '1' } })
    expect(capture.isError).toBe(true)
    expect(capture.content[0].text).toContain('snapshotId')
  } finally { await client.close(); await server.close() }
})

test('capture discovery and runtime require a snapshot for a referenced crop, but allow a viewport capture', () => {
  const capture = new AjvJsonSchemaValidator().getValidator(structuredClone(BROWSER_TOOLS.find(tool => tool.name === 'browser_capture').inputSchema))
  for (const input of [{}, { snapshotId: 's' }, { snapshotId: 's', ref: '1' }]) {
    expect(capture(input).valid).toBe(true)
    expect(() => validateBrowserInput('browser_capture', input)).not.toThrow()
  }
  for (const input of [{ ref: '1' }, { ref: '1', snapshotId: '' }, { snapshot: 's' }]) {
    expect(capture(input).valid).toBe(false)
    expect(() => validateBrowserInput('browser_capture', input)).toThrow()
  }
})

test('browser action schema and runtime parser agree on action-specific arguments', () => {
  const valid = [
    { action: 'click', snapshotId: 'snapshot-1', ref: '1' },
    { action: 'fill', snapshotId: 'snapshot-1', ref: '2', text: '' },
    { action: 'select', snapshotId: 'snapshot-1', ref: '3', text: 'option-a' },
    { action: 'scroll', snapshotId: 'snapshot-1', deltaX: 10 },
    { action: 'scroll', snapshotId: 'snapshot-1', deltaY: -4000, ref: '4' },
    { action: 'navigate', snapshotId: 'snapshot-1', url: 'https://example.test/path' }
  ]
  for (const action of valid) {
    expect(browserActionSchema(action).valid).toBe(true)
    expect(() => validateBrowserInput('browser_act', action)).not.toThrow()
  }
  for (const action of [
    { action: 'click', snapshotId: 'snapshot-1' },
    { action: 'fill', snapshotId: 'snapshot-1', ref: '2' },
    { action: 'select', snapshotId: 'snapshot-1', ref: '3' },
    { action: 'scroll', snapshotId: 'snapshot-1' },
    { action: 'scroll', snapshotId: 'snapshot-1', deltaY: 4001 },
    { action: 'navigate', snapshotId: 'snapshot-1' },
    { action: 'navigate', snapshotId: 'snapshot-1', url: 'ftp://example.test' },
    { action: 'click', snapshotId: 'snapshot-1', ref: '1', text: 'unrelated' }
  ]) {
    expect(browserActionSchema(action).valid).toBe(false)
    expect(() => validateBrowserInput('browser_act', action)).toThrow()
  }
  const malformedUrl = { action: 'navigate', snapshotId: 'snapshot-1', url: 'https://example.test:bad-port' }
  expect(browserActionSchema(malformedUrl).valid).toBe(true)
  expect(() => validateBrowserInput('browser_act', malformedUrl)).toThrow('absolute HTTP(S) URL')
})

test('a held place can be filled by any element with a box, and only in place of geometry', () => {
  const filled = [
    { type: 'create_element', elementType: 'rectangle', slot: 'place-1' },
    { type: 'create_element', elementType: 'frame', slot: 'place-1', props: { name: 'Research' } },
    { type: 'create_element', elementType: 'html', slot: 'place-1', props: { htmlPath: '/workspace/outputs/page.html' } },
    { type: 'create_element', elementType: 'image', slot: 'place-1', props: { mediaPath: '/workspace/outputs/image.png' } },
    { type: 'update_element', elementId: 'page', slot: 'place-1', props: { htmlPath: '/workspace/outputs/page.html' } }
  ]
  for (const op of filled) {
    expect(accepts([op])).toBe(true)
    expect(() => validateCanvasOperations([op])).not.toThrow()
  }
  // Neither coordinates nor a place: rejected before execution on both layers.
  const nowhere = { type: 'create_element', elementType: 'rectangle' }
  expect(accepts([nowhere])).toBe(false)
  expect(() => validateCanvasOperations([nowhere])).toThrow('Invalid creation coordinates')
  for (const [op, message] of [
    [{ type: 'create_element', elementType: 'rectangle', slot: 'place-1', x: 0, y: 0 }, 'A slot sets the geometry'],
    [{ type: 'create_element', elementType: 'html', slot: 'place-1', props: { htmlPath: '/workspace/outputs/page.html', width: 800 } }, 'A slot sets the geometry'],
    [{ type: 'update_element', elementId: 'page', slot: 'place-1', x: 10 }, 'A slot sets the geometry'],
    [{ type: 'create_element', elementType: 'arrow', slot: 'place-1' }, 'A slot holds a shape, frame, page, image or video'],
    [{ type: 'create_element', elementType: 'freedraw', slot: 'place-1', x: 0, y: 0, props: { points: [[0, 0], [1, 1]] } }, 'A slot holds a shape, frame, page, image or video'],
    [{ type: 'create_text', text: 'Label', x: 0, y: 0, slot: 'place-1' }, 'A slot holds a shape, frame, page, image or video']
  ]) expect(() => validateCanvasOperations([op])).toThrow(message)
})
