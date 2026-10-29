// A mixed deliverable: shapes and labels in one group, apart from the brush
// benchmark in `brush-workload.ts`.
export const mixedOperations = [
  ...Array.from({ length: 12 }, (_, i) => ({ type: 'create_element', id: `card-${i}`, elementType: 'rectangle', x: 120 + i * 40, y: 120, props: { width: 32, height: 24, groupIds: ['mixed-board'] } })),
  ...Array.from({ length: 12 }, (_, i) => ({ type: 'create_element', id: `oval-${i}`, elementType: 'ellipse', x: 120 + i * 40, y: 200, props: { width: 32, height: 24, groupIds: ['mixed-board'] } })),
  ...Array.from({ length: 12 }, (_, i) => ({ type: 'create_element', id: `gem-${i}`, elementType: 'diamond', x: 120 + i * 40, y: 280, props: { width: 32, height: 24, groupIds: ['mixed-board'] } })),
  ...Array.from({ length: 12 }, (_, i) => ({ type: 'create_text', id: `label-${i}`, x: 120 + i * 40, y: 360, text: `Row ${i}`, props: { groupIds: ['mixed-board'] } }))
]
