import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import ts from 'typescript'

/** Check the declaration delivered by the host, not a handwritten substitute.
 * Excess-property checks here model the inline calls an agent writes in Code Mode;
 * numeric bounds and cross-field semantic rules still belong to runtime validation. */
export async function verifyCanvasWriteDeclaration(declaration: string, directory: string) {
  const valid = [
    '{ type: "create_text", text: "Label", x: 0, y: 0, props: { fontSize: 24, groupIds: ["card"] } }',
    '{ type: "create_element", elementType: "image", props: { mediaPath: "/workspace/image.png" } }',
    '{ type: "create_element", elementType: "rectangle", x: 0, y: 0, props: { width: 100 } }',
    '{ type: "update_element", elementId: "card", props: { opacity: 50, groupIds: [] } }',
    '{ type: "move", elementId: "card", x: 10, y: 20, scope: "group" }',
    '{ type: "delete", elementId: "card" }',
    '{ type: "bind_arrow", elementId: "edge", start: "card", end: null }',
    '{ type: "bind_text", elementId: "label", containerId: null }'
  ]
  const invalid = [
    '{ type: "update_element", id: "card", props: { opacity: 50 } }',
    '{ type: "move", elementId: "card", x: 0 }',
    '{ type: "delete", elementId: "card", props: { opacity: 50 } }',
    '{ type: "move", elementId: "card", x: 0, y: 0, props: { opacity: 50 } }',
    '{ type: "bind_arrow", elementId: "edge", end: null, props: { opacity: 50 } }',
    '{ type: "bind_text", elementId: "label", containerId: null, props: { opacity: 50 } }',
    '{ type: "update_element", elementId: "card", props: { misspelledOpacity: 50 } }',
    '{ type: "create_text", text: "Label", x: 0, y: 0, props: { misspelledFontSize: 24 } }',
    '{ type: "create_element", elementType: "rectangle", x: 0, y: 0, props: { misspelledWidth: 100 } }',
    '{ type: "create_text", text: "Label", x: 0, y: 0, props: { mediaPath: "/workspace/image.png" } }',
    '{ type: "create_text", text: "Label", x: 0, y: 0, props: { htmlPath: "/workspace/page.html" } }',
    '{ type: "update_element", elementId: "card", props: { opacity: "half" } }',
    '{ type: "move", elementId: "card", x: 0, y: 0, scope: "everything" }',
    '{ type: "delete", elementId: "card", id: "creation-only" }'
  ]
  const call = (operation: string) => `tools.mcp__galta__canvas_edit({ revision: "observed", operations: [${operation}] });`
  return verifyCalls(declaration, directory, 'canvas-edit', valid.map(call), invalid.map(call))
}

export async function verifyCanvasReadDeclaration(declaration: string, directory: string) {
  const element = '(await tools.mcp__galta__canvas_inspect({})).elements![0]!'
  return verifyCalls(declaration, directory, 'canvas-inspect',
    [`async function validBounds() { const x: number = ${element}.bounds!.x; }`],
    [`async function invalidWidth() { const width: string = ${element}.bounds!.width; }`, `async function invalidShape() { const label = ${element}.bounds!.shapeLabel; }`])
}

export async function verifyBrowserDeclarations(action: string, capture: string, directory: string) {
  const validActions = [
    '{ action: "click", snapshotId: "s", ref: "1" }',
    '{ action: "fill", snapshotId: "s", ref: "1", text: "" }',
    '{ action: "select", snapshotId: "s", ref: "1", text: "a" }',
    '{ action: "scroll", snapshotId: "s", deltaX: 1 }',
    '{ action: "scroll", snapshotId: "s", deltaY: 1 }',
    '{ action: "scroll", snapshotId: "s", ref: "1", deltaX: 1, deltaY: 2 }',
    '{ action: "navigate", snapshotId: "s", url: "https://example.test" }'
  ]
  const invalidActions = [
    '{ action: "click", snapshotId: "s" }',
    '{ action: "fill", snapshotId: "s", ref: "1" }',
    '{ action: "select", snapshotId: "s", ref: "1" }',
    '{ action: "scroll", snapshotId: "s" }',
    '{ action: "navigate", snapshotId: "s" }',
    '{ action: "click", ref: "1" }',
    '{ action: "click", snapshotId: "s", ref: "1", url: "https://example.test" }',
    '{ action: "scroll", snapshotId: "s", deltaY: "500" }',
    '{ action: "scroll", snapshotId: "s", y: 500 }',
    '{ action: "fill", snapshotId: "s", ref: "1", text: 0 }'
  ]
  const act = (args: string) => `tools.mcp__galta__browser_act(${args});`
  const crop = (args: string) => `tools.mcp__galta__browser_capture(${args});`
  return {
    action: await verifyCalls(action, directory, 'browser-act', validActions.map(act), invalidActions.map(act)),
    capture: await verifyCalls(capture, directory, 'browser-capture', ['{}', '{ snapshotId: "s" }', '{ snapshotId: "s", ref: "1" }'].map(crop),
      ['{ ref: "1" }', '{ snapshot: "s" }', '{ snapshotId: "s", ref: 1 }'].map(crop))
  }
}

async function verifyCalls(declaration: string, directory: string, name: string, valid: string[], invalid: string[]) {
  const signature = declaration.match(/```ts\n([\s\S]*?)\n```/)?.[1]
  assert(signature, `Missing ${name} TypeScript declaration`)
  const path = join(directory, `code-mode-${name}-check.ts`)
  await writeFile(path, ['type CallToolResult<T = unknown> = T;', signature,
    ...valid, ...invalid.flatMap(call => ['// @ts-expect-error Invalid inline call must be rejected', call])].join('\n') + '\n')
  const program = ts.createProgram([path], { noEmit: true, strict: true, types: [], target: ts.ScriptTarget.ES2022 })
  const diagnostics = ts.getPreEmitDiagnostics(program)
  assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: path => path, getCurrentDirectory: () => directory, getNewLine: () => '\n'
  }))
  return { validCalls: valid.length, invalidCalls: invalid.length }
}
