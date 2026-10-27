#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createCanvasMcpServer } from './server'
import { EMBEDDED_MCP_ENV } from '../../packages/canvas/src/execution'
import { MEDIA_WORKER_ENV } from '../media/service'
import { carryGeneration } from '../media/worker'

// The same executable carries a paid generation in a detached worker.
if (Bun.env[MEDIA_WORKER_ENV] === '1') { await carryGeneration(await Bun.stdin.text()); process.exit(0) }
if (Bun.argv.slice(2).length) throw new Error('galta-mcp takes no arguments; it serves both canvas and browser tools')
const server = createCanvasMcpServer({ uiOwned: Bun.env[EMBEDDED_MCP_ENV] === '1' })
await server.connect(new StdioServerTransport())
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void server.close() })
