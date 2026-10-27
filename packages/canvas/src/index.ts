export * from './tools'
export * from './contract'
export * from './message'
export * from './instructions'
export * from './operations'
export * from './html'
export * from './artifactPaths'
export * from './browser'
export * from './capabilities/media'
export * from './execution'
export * from './assets'
export * from './sourceImages'
export * from './video'
export * from './reads'
export * from './bounds'
export * from './evidence'
export * from './slots'

import type { CreativeShapeKind } from './reads'
import type { CanvasBounds } from './bounds'
export type CanvasShapeContext = { id: string; kind: CreativeShapeKind; bounds: CanvasBounds; x: number; y: number; width?: number; height?: number; text?: string; selected?: boolean; sourceUrl?: string }
export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export type ToolResult = { content: ToolContent[]; structuredContent?: Record<string, unknown>; isError?: boolean }
export type CanvasToolScope = {
  executionId: string
  cwd: string
  signal: AbortSignal
  provenance?: { providerId: string; sessionId: string; turnId?: string }
}
export interface CanvasArtifacts {
  readImage(path: string, scope: CanvasToolScope): Promise<{ dataUrl: string }>
  readVideo?(path: string, scope: CanvasToolScope): Promise<Blob>
  readHtml(path: string, scope: CanvasToolScope): Promise<{ html: string }>
  writeImage(path: string, dataBase64: string, scope: CanvasToolScope): Promise<void>
  /** Write an immutable source of any supported extracted kind. Image-only
   * bridges may omit this and continue to use writeImage. */
  writeArtifact?(path: string, dataBase64: string, mimeType: string, scope: CanvasToolScope): Promise<void>
  /** Copy an exact source into the execution workspace as an explicit user
   * delivery. The bridge owns path validation and returns its canonical URI. */
  deliver(source: string, destination: string, scope: CanvasToolScope): Promise<{ path: string; artifactUri: string; sourceArtifactUri: string; name: string; mimeType: string; size: number; sha256: string; version: string }>
}
export type CanvasExecutor = (tool: string, args: unknown, scope: CanvasToolScope) => Promise<ToolResult>
