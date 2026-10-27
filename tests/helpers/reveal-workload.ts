// Reveal-overlay fixtures. These exercise the branches the preview draws, so
// they live apart from the brush benchmark in `brush-workload.ts`.
export const mixedOperations = [
  ...Array.from({ length: 12 }, (_, i) => ({ type: 'create_element', id: `card-${i}`, elementType: 'rectangle', x: 120 + i * 40, y: 120, props: { width: 32, height: 24, groupIds: ['mixed-board'] } })),
  ...Array.from({ length: 12 }, (_, i) => ({ type: 'create_element', id: `oval-${i}`, elementType: 'ellipse', x: 120 + i * 40, y: 200, props: { width: 32, height: 24, groupIds: ['mixed-board'] } })),
  ...Array.from({ length: 12 }, (_, i) => ({ type: 'create_element', id: `gem-${i}`, elementType: 'diamond', x: 120 + i * 40, y: 280, props: { width: 32, height: 24, groupIds: ['mixed-board'] } })),
  ...Array.from({ length: 12 }, (_, i) => ({ type: 'create_text', id: `label-${i}`, x: 120 + i * 40, y: 360, text: `Row ${i}`, props: { groupIds: ['mixed-board'] } }))
]

/** Frame coverage is checked on its own: a frame adopts overlapping elements,
 * which would make a combined batch assertion depend on native frame geometry. */
export const frameOperations = [
  { type: 'create_element', id: 'board-frame', elementType: 'frame', x: 60, y: 60, props: { width: 520, height: 240 } }
]
