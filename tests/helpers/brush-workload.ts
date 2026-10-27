// Comparable to the reported 120-operation replacement, without personal art.
export const brushBase = Array.from({ length: 46 }, (_, i) => ({ type: 'create_element', id: `old-${i}`, elementType: 'rectangle', x: 120 + i * 8, y: 140, props: { width: 6, height: 20 } }))
export const brushStrokes = Array.from({ length: 74 }, (_, i) => ({ type: 'create_element', id: `ink-${i}`, elementType: 'freedraw', x: 150 + (i % 10) * 90, y: 200 + Math.floor(i / 10) * 80,
  props: { points: Array.from({ length: 871 }, (_, p) => [p / 12, Math.sin(p / 60) * 25]), strokeColor: '#39332e', strokeWidth: 1, simulatePressure: true, pressures: [] } }))
export const brushOperations = [...brushBase.map(el => ({ type: 'delete', elementId: el.id })), ...brushStrokes]
