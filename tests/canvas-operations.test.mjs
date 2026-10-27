import { test, expect } from 'bun:test'
import { validateCanvasOperations } from '../packages/canvas/src/operations.ts'

test('native colors accept exactly CSS hex lengths and reject malformed text styles', () => {
  const text = (props) => [{ type: 'create_text', text: '精确排版', x: 0, y: 0, props }]
  for (const value of ['#123', '#1234', '#123456', '#12345678', 'transparent', 'blue']) {
    expect(() => validateCanvasOperations(text({ strokeColor: value }))).not.toThrow()
  }
  for (const value of ['#12', '#12345', '#1234567', '#ggg', 'red;display:none']) {
    expect(() => validateCanvasOperations(text({ strokeColor: value }))).toThrow('strokeColor')
  }
  for (const props of [{ fontSize: -2 }, { opacity: 101 }, { fontFamily: 4 }, { htmlPath: '/tmp/no.html' }, { unknown: true }]) {
    expect(() => validateCanvasOperations(text(props))).toThrow()
  }
})

test('axis-aligned paths accept zero dimensions while boxes and negative dimensions fail', () => {
  for (const elementType of ['line', 'arrow', 'freedraw']) {
    expect(() => validateCanvasOperations([{ type: 'create_element', elementType, x: 0, y: 0, props: { width: 120, height: 0, points: [[0, 0], [120, 0]] } }])).not.toThrow()
  }
  for (const elementType of ['rectangle', 'ellipse', 'diamond', 'frame']) {
    expect(() => validateCanvasOperations([{ type: 'create_element', elementType, x: 0, y: 0, props: { width: 120, height: 0 } }])).toThrow('height')
  }
  expect(() => validateCanvasOperations([{ type: 'update_element', elementId: 'a', props: { height: -1 } }])).toThrow('height')
})

test('native relationships accept IDs and reject malformed targets before mutation', () => {
  const valid = [
    { type: 'create_element', id: 'card', elementType: 'rectangle', x: 0, y: 0, props: { groupIds: ['inner', 'outer'], link: 'https://example.test/source' } },
    { type: 'bind_arrow', elementId: 'edge', start: 'card', end: null },
    { type: 'bind_text', elementId: 'text', containerId: 'card' },
    { type: 'move', elementId: 'card', x: 30, y: 40, scope: 'group' }
  ]
  expect(() => validateCanvasOperations(valid)).not.toThrow()
  for (const op of [
    { type: 'delete' }, { type: 'bind_arrow', elementId: 'edge' },
    { type: 'bind_text', elementId: 'text' }, { type: 'bind_arrow', elementId: 'edge', end: 42 },
    { ...valid[0], props: { groupIds: ['a', 'a'] } }, { ...valid[0], props: { groupIds: 'a' } },
    { ...valid[0], props: { link: 'javascript:alert(1)' } }, { ...valid[0], props: { roundness: { type: 1, value: NaN } } }
  ]) expect(() => validateCanvasOperations([op])).toThrow()
})

test('text aliases cannot disagree about the editable content', () => {
  expect(() => validateCanvasOperations([{ type: 'update_element', elementId: 'label', props: { text: 'One', originalText: 'Two' } }])).toThrow('text')
  expect(() => validateCanvasOperations([{ type: 'create_text', x: 0, y: 0, text: 'One', props: { originalText: 'Two' } }])).toThrow('text')
  expect(() => validateCanvasOperations([{ type: 'update_element', elementId: 'label', props: { originalText: 'Revised' } }])).not.toThrow()
})

test('media creation and replacement are native batch operations with explicit artifact kinds', () => {
  for (const elementType of ['image', 'video']) {
    expect(() => validateCanvasOperations([{ type: 'create_element', elementType, props: { mediaPath: '/workspace/output.png', width: 120 } }])).not.toThrow()
  }
  expect(() => validateCanvasOperations([{ type: 'update_element', elementId: 'image', props: { mediaPath: '/workspace/output.png', groupIds: ['card'] } }])).not.toThrow()
  for (const op of [
    { type: 'create_element', elementType: 'image', props: {} },
    { type: 'create_element', elementType: 'image', x: 1, props: { mediaPath: '/workspace/image.png' } },
    { type: 'create_element', elementType: 'image', props: { mediaPath: 'relative.png' } },
    { type: 'create_element', elementType: 'rectangle', x: 0, y: 0, props: { mediaPath: '/workspace/image.png' } },
    { type: 'update_element', elementId: 'image', props: { mediaPath: '/workspace/image.png', htmlPath: '/workspace/page.html' } }
  ]) expect(() => validateCanvasOperations([op])).toThrow()
})

test('pages, images and videos carry a bounded title and caption; text and shapes do not', () => {
  const words = { title: 'The Garden House', caption: 'A slower weekend, kept at home.' }
  for (const op of [
    { type: 'create_element', elementType: 'html', x: 0, y: 0, props: { htmlPath: '/workspace/page.html', ...words } },
    { type: 'create_element', elementType: 'image', props: { mediaPath: '/workspace/output.png', ...words } },
    { type: 'update_element', elementId: 'page', props: { title: '', caption: 'Changes follow the element' } }
  ]) expect(() => validateCanvasOperations([op])).not.toThrow()
  for (const op of [
    { type: 'create_text', text: 'Label', x: 0, y: 0, props: { title: 'Label' } },
    { type: 'create_element', elementType: 'rectangle', x: 0, y: 0, props: { caption: 'Card' } },
    { type: 'update_element', elementId: 'page', props: { title: 'x'.repeat(121) } },
    { type: 'update_element', elementId: 'page', props: { caption: 'x'.repeat(281) } },
    { type: 'update_element', elementId: 'page', props: { title: 42 } }
  ]) expect(() => validateCanvasOperations([op])).toThrow()
})
