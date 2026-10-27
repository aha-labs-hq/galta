import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/types'
import { GALTA_MCP_INSTRUCTIONS, CANVAS_TOOLS, CANVAS_TOOL_NAMES, validateCanvasOperations, validateCanvasReadPage, validateCanvasQuery, type CanvasOperation, type ToolResult } from '../../packages/canvas/src/index'
import { BROWSER_TOOLS, BROWSER_TOOL_NAMES, validateBrowserInput } from '../../packages/canvas/src/browser'
import { discoverBridges, openBridge, type BridgeClient } from './client'
import { embeddedTool } from '../../packages/canvas/src/contract'
import type { Capability } from './capability'
import { EMBEDDED_TOOL_TIMEOUT_SECONDS } from '../../packages/canvas/src/execution'
import { mediaCapability } from '../media/capability'
import { galtaPaths } from '../paths'

const empty = { type: 'object' as const, properties: {}, additionalProperties: false }
const schemaValidator = new AjvJsonSchemaValidator()

/** The workspace of a UI-owned execution, where its generated files belong. */
async function executionWorkspace(executionId: string, signal: AbortSignal): Promise<string> {
  const [bridgeId, leaseId, surplus] = executionId.split('/')
  if (!bridgeId || !leaseId || surplus) throw new Error('Use the id from the current Galta execution context')
  const bridge = await openBridge(bridgeId)
  if (!bridge) throw new Error('The Galta execution is no longer available')
  try { return (await bridge.request('execution/workspace', { leaseId }, signal)).cwd }
  finally { bridge.close() }
}

const validators = new Map<string, ReturnType<typeof schemaValidator.getValidator>>([...CANVAS_TOOLS, ...BROWSER_TOOLS].map(tool => [tool.name, schemaValidator.getValidator(structuredClone(tool.inputSchema) as JsonSchemaType)]))

// The embedded server's tool timeout is EMBEDDED_TOOL_TIMEOUT_SECONDS; other
// clients commonly allow 60 s. A wait stays well inside either.
const WAIT_SECONDS = { embedded: EMBEDDED_TOOL_TIMEOUT_SECONDS - 70, external: 50 } as const

/** JSON Schema is owned by the canvas contract, so use the SDK's protocol API.
 * The canvas and webpage tools are always listed; each capability adds its
 * tools only while it can be used, and the list is re-announced when that
 * changes. Everything listed stays byte-stable between changes, for caching. */
export function createCanvasMcpServer({ uiOwned = false, capabilities = [mediaCapability({ directory: galtaPaths.mediaDirectory })] }: { uiOwned?: boolean; capabilities?: readonly Capability[] } = {}) {
  const server = new Server({ name: 'galta', version: '0.1.0' }, {
    capabilities: { tools: { listChanged: true } },
    instructions: GALTA_MCP_INSTRUCTIONS
  })
  const capabilityFor = (name: string) => capabilities.find(capability => capability.owns(name))
  let bridges: BridgeClient[] = []
  /** Why live bridges from other browsers were left out of discovery. */
  let incompatible: string[] = []
  const borrowed = new Set<BridgeClient>()
  let boundCalls = 0
  let active: { bridge: BridgeClient; leaseId: string; cwd: string } | undefined
  let transition: 'listing' | 'connecting' | 'disconnecting' | null = null
  let closed = false
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    ...BROWSER_TOOLS.map(tool => uiOwned ? embeddedTool(tool) : tool).map(({ execution: _, ...tool }) => structuredClone(tool)),
    // Keep the historical array result for canvas_list. The MCP outputSchema
    // contract requires an object root, so this discovery result remains
    // deliberately untyped until the wire shape can change coherently.
    ...(!uiOwned ? [
    { name: 'canvas_list', description: 'List open Galta canvases with stable target IDs and whether an agent is already active.', inputSchema: empty, annotations: { readOnlyHint: true, openWorldHint: false } },
    { name: 'canvas_connect', description: 'Connect to an explicit canvas ID from canvas_list. Captures selection and reserves the document. Disconnect before choosing a different canvas.', inputSchema: { type: 'object', properties: { canvasId: { type: 'string' } }, required: ['canvasId'], additionalProperties: false }, outputSchema: { type: 'object', properties: { canvasId: { type: 'string' }, workspace: { type: 'string' } }, required: ['canvasId', 'workspace'], additionalProperties: false }, annotations: { destructiveHint: false, openWorldHint: false } },
    { name: 'canvas_disconnect', description: 'Release the current canvas execution. Already completed edits remain saved.', inputSchema: empty, outputSchema: { type: 'object', properties: { disconnected: { const: true } }, required: ['disconnected'], additionalProperties: false }, annotations: { destructiveHint: false, openWorldHint: false } },
    ] : []),
    ...CANVAS_TOOLS.map(tool => uiOwned ? embeddedTool(tool) : tool).map(({ execution: _, ...tool }) => structuredClone(tool)),
    // A capability that cannot tell whether it is usable lists nothing; it never hides the canvas.
    ...(await Promise.all(capabilities.map(capability => capability.tools().catch(() => [])))).flat().map(tool => uiOwned ? embeddedTool(tool) : tool).map(({ execution: _, ...tool }) => structuredClone(tool))
  ] }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const { name, arguments: args = {} } = request.params
      const suppliedExecutionId = typeof args.executionId === 'string' ? args.executionId : undefined
      const { executionId: _executionId, ...toolArgs } = args
      if (uiOwned && ![...CANVAS_TOOL_NAMES, ...BROWSER_TOOL_NAMES].includes(name) && !capabilityFor(name)) throw new Error('The UI owns this execution; client connection management is unavailable')
      if (uiOwned && !suppliedExecutionId) throw new Error('Embedded Galta tools require executionId from the current execution application context. No call was applied.')
      try {
        // The same domain checks run in the editor. Run them before generic
        // union-schema validation so errors identify the chosen operation,
        // rather than listing failures for every unrelated union alternative.
        if (args.executionId !== undefined && typeof args.executionId !== 'string') throw new Error('executionId must be a string when supplied')
        if (name === 'canvas_edit' && Array.isArray(toolArgs.operations)) validateCanvasOperations(toolArgs.operations as CanvasOperation[])
        if (name === 'canvas_inspect' || name === 'canvas_extract') validateCanvasReadPage(toolArgs)
        if (name === 'canvas_inspect') validateCanvasQuery(toolArgs)
        if (BROWSER_TOOL_NAMES.includes(name)) validateBrowserInput(name, toolArgs)
        const validation = validators.get(name)?.(toolArgs)
        if (validation && !validation.valid) throw new Error(validation.errorMessage)
      } catch (error) {
        throw new Error(`Invalid ${name} arguments: ${error instanceof Error ? error.message : String(error)}${name === 'canvas_edit' || name === 'canvas_place' ? ' No edit was applied.' : ''}`)
      }
      if (closed) throw new Error('MCP connection closed')
      const capability = capabilityFor(name)
      if (capability) {
        // A capability's files belong to the bound execution's workspace, where canvas_place can commit them.
        const workspace = !capability.writesFiles(name) ? undefined : suppliedExecutionId !== undefined ? await executionWorkspace(suppliedExecutionId, extra.signal) : active?.cwd
        return await capability.call(name, toolArgs, { workspace, signal: extra.signal, maxWaitSeconds: uiOwned ? WAIT_SECONDS.embedded : WAIT_SECONDS.external }) as ToolResult & { [key: string]: unknown }
      }
      if ([...CANVAS_TOOL_NAMES, ...BROWSER_TOOL_NAMES].includes(name) && suppliedExecutionId !== undefined) {
        if (active || transition) throw new Error('Disconnect the client-owned canvas before using a supplied execution')
        const [bridgeId, leaseId, surplus] = suppliedExecutionId.split('/')
        if (!bridgeId || !leaseId || surplus) throw new Error('Use the id from the current Galta execution context')
        // The UI owns this lease. A tool connection cannot acquire or release it.
        boundCalls++
        let bridge: BridgeClient | undefined
        try {
          bridge = await openBridge(bridgeId)
          if (!bridge) throw new Error('The Galta execution is no longer available')
          if (closed) throw new Error('MCP connection closed')
          borrowed.add(bridge)
          return await bridge.request('execution/call', { leaseId, tool: name, args: toolArgs }, extra.signal) as ToolResult & { [key: string]: unknown }
        } finally {
          if (bridge) { borrowed.delete(bridge); bridge.close() }
          boundCalls--
        }
      }
      let result: unknown
      if (boundCalls && ['canvas_list', 'canvas_connect', 'canvas_disconnect'].includes(name)) throw new Error('Wait for UI-owned tool calls to finish before managing a client-owned canvas connection')
      if (['canvas_list', 'canvas_disconnect'].includes(name) && Object.keys(args).length) throw new Error(`${name} takes no arguments`)
      if (name === 'canvas_list') {
        if (transition) throw new Error(`Canvas connection is ${transition}`)
        transition = 'listing'
        try {
          if (!active) {
            bridges.forEach(bridge => bridge.close())
            const found = await discoverBridges()
            bridges = found.bridges; incompatible = found.incompatible
            if (closed) { bridges.forEach(bridge => bridge.close()); bridges = []; throw new Error('MCP connection closed') }
          }
          // With nothing else open, the incompatible browser is the one to fix.
          if (!bridges.length && incompatible.length) throw new Error(incompatible[0])
          const canvases = (await Promise.all(bridges.map(async bridge => {
            const canvases = await bridge.request('list', {}, extra.signal)
            return canvases.map((canvas: any) => ({ ...canvas, id: `${bridge.id}/${canvas.id}` }))
          }))).flat()
          // The array result keeps its historical shape; the omission travels beside it.
          return { content: [{ type: 'text' as const, text: JSON.stringify(canvases) }, ...(incompatible.length ? [{ type: 'text' as const, text: `Canvases in ${incompatible.length === 1 ? 'one other Galta browser are' : `${incompatible.length} other Galta browsers are`} not listed. ${incompatible[0]}` }] : [])] }
        } finally { transition = null }
      } else if (name === 'canvas_connect') {
        if (active || transition) throw new Error('Wait for discovery and disconnect the current canvas before connecting again')
        if (Object.keys(args).some(key => key !== 'canvasId')) throw new Error('canvas_connect accepts only canvasId')
        if (typeof args.canvasId !== 'string') throw new Error('An explicit canvasId is required')
        const [bridgeId, canvasId, surplus] = args.canvasId.split('/')
        if (!canvasId || surplus) throw new Error('Use a canvas ID returned by canvas_list')
        const bridge = bridges.find(bridge => bridge.id === bridgeId)
        if (!bridge) throw new Error('List open canvases before connecting')
        transition = 'connecting'
        try {
          const lease = await bridge.request('connect', { canvasId, client: server.getClientVersion()?.name ?? 'MCP client' }, extra.signal)
          if (closed || extra.signal.aborted) { await bridge.request('release', { leaseId: lease.id }); throw new Error('Connection cancelled') }
          active = { bridge, leaseId: lease.id, cwd: lease.cwd }
          result = { canvasId: args.canvasId, workspace: lease.cwd }
        } finally { transition = null }
      } else if (name === 'canvas_disconnect') {
        if (transition) throw new Error(`Canvas connection is ${transition}`)
        transition = 'disconnecting'
        try {
          if (active) { const current = active; active = undefined; await current.bridge.request('release', { leaseId: current.leaseId }) }
        } finally { transition = null }
        result = { disconnected: true }
      } else {
        if (![...CANVAS_TOOL_NAMES, ...BROWSER_TOOL_NAMES].includes(name)) throw new Error(`Unknown canvas tool: ${name}`)
        if (transition) throw new Error(`Canvas connection is ${transition}`)
        if (!active) throw new Error('Connect to a canvas before using its tools')
        return await active.bridge.request('call', { leaseId: active.leaseId, tool: name, args: toolArgs }, extra.signal) as ToolResult & { [key: string]: unknown }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], ...(result && typeof result === 'object' && !Array.isArray(result) ? { structuredContent: result as Record<string, unknown> } : {}) }
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }
    }
  })
  const unwatch = capabilities.map(capability => capability.watch(() => { if (!closed) void server.sendToolListChanged().catch(() => undefined) }))
  server.onclose = () => { closed = true; unwatch.forEach(stop => stop()); bridges.forEach(bridge => bridge.close()); borrowed.forEach(bridge => bridge.close()); borrowed.clear(); bridges = []; active = undefined }
  return server
}
