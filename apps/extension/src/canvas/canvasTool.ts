import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState } from '@excalidraw/excalidraw/types'
import type { CanvasOperation, CanvasShapeContext, CanvasToolScope, CanvasArtifacts, CreativeShapeKind, ToolResult, CanvasEvidence, CanvasSlot } from '@galta/canvas'
import { arrangePlaces, CANVAS_SLOT_LIMIT, CANVAS_SLOT_SIDE, assessCanvasClaim, assetBlob, canvasReportSchema, makePixelsEvidence, makeStructureEvidence, videoFile, validateCanvasOperations, CANVAS_WRITABLE_PROPS, isAbsoluteArtifactPath, joinArtifactPath, managedArtifactReference, resolveManagedArtifactPath, validateHtml, CANVAS_PAGE_DEFAULT, CANVAS_PAGE_MAX, CANVAS_PAGE_CHARACTERS, canvasReadContinuation, validateCanvasReadPage, validateCanvasQuery, sourceImageFormat } from '@galta/canvas'
import { videoData } from './video'
import { prepareMediaArtifact, type PreparedMediaArtifact } from './mediaArtifact'
import { htmlDocument } from './htmlEmbed'
import { objectLabel } from './objectLabel'
import { blobDataUrl } from './imageData'
import { planCreativeOperationsAsync } from './patchExecutor'
import { CanvasWork } from './canvasWork'
import type { SubmittedContext } from './context'
import { imageDimensions } from './imageImport'
import type { SceneSnapshot } from './scene'
import type { ToolScene } from './toolScene'
import { elementBounds, inRegion, observeCanvas } from './observation'
import { captureMarks } from './captureMarks'

export type PendingCanvasMutation = { before: SceneSnapshot; snapshot: SceneSnapshot; assertCurrent: () => void; apply: () => void }

/** Revision of the persisted document, including immutable asset identities.
 * Viewport and selection changes do not invalidate an edit. */
export function canvasRevision(scene: ToolScene): string {
  const value = JSON.stringify(scene.document)
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619)
  return `${value.length}:${(hash >>> 0).toString(16)}`
}
function textResult(value: Record<string, unknown>): ToolResult { return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } }
function extension(mimeType: string): string {
  return sourceImageFormat(mimeType)?.extensions[0] ?? (mimeType === 'text/html' ? 'html' : mimeType === 'video/quicktime' ? 'mov' : mimeType.split('/')[1]!)
}
function args(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid canvas tool arguments')
  return value as Record<string, any>
}
function shapeKind(el: ExcalidrawElement): CreativeShapeKind {
  if (videoData(el)) return 'video'
  if (htmlDocument(el)) return 'html'
  if (el.type === 'freedraw') return 'draw'
  if (['rectangle', 'ellipse', 'diamond'].includes(el.type)) return 'geo'
  return ['text', 'image', 'arrow', 'line', 'frame'].includes(el.type) ? el.type as CreativeShapeKind : 'unknown'
}

/** Project document fields, excluding version/seed bookkeeping and asset
 * bytes. Detailed reads expose the writable fields from their single registry. */
function describe(el: ExcalidrawElement, detail: 'summary' | 'elements', cwd?: string): CanvasShapeContext & Record<string, unknown> {
  const common = {
    id: el.id, kind: shapeKind(el), type: el.type, x: el.x, y: el.y,
    width: el.width, height: el.height, rotation: el.angle, bounds: elementBounds(el),
    ...(el.angle ? { angleDegrees: el.angle * 180 / Math.PI } : {}),
    ...(htmlDocument(el) ? { html: true } : {}),
    ...(videoData(el) ? { video: videoData(el) } : {}),
    ...('name' in el && typeof el.name === 'string' && el.name ? { name: el.name } : {}),
    ...objectLabel(el)
  }
  const text = el.type === 'text' ? { text: detail === 'summary' ? el.text.slice(0, 400) : el.text, ...(detail === 'summary' && el.text.length > 400 ? { textTruncated: true } : {}) } : {}
  const generated = typeof el.customData?.generatedPath === 'string' ? { generatedPath: cwd ? resolveManagedArtifactPath(el.customData.generatedPath, cwd) : el.customData.generatedPath } : {}
  if (detail === 'summary') return { ...common, ...text, ...generated, ...(el.groupIds.length ? { groupIds: el.groupIds } : {}) }
  return {
    ...common, ...text,
    ...Object.fromEntries(CANVAS_WRITABLE_PROPS.filter(key => key in el).map(key => [key, el[key as keyof ExcalidrawElement]])),
    groupIds: el.groupIds, frameId: el.frameId, boundElements: el.boundElements, link: el.link,
    ...('containerId' in el ? { containerId: el.containerId } : {}),
    ...(el.type === 'arrow' ? { startBinding: el.startBinding, endBinding: el.endBinding } : {}),
    ...(el.type === 'image' ? { fileId: el.fileId, crop: el.crop, scale: el.scale } : {}),
    ...(typeof el.customData?.sourceUrl === 'string' ? { sourceUrl: el.customData.sourceUrl } : {}),
    ...generated
  }
}

/** Shared document projection, revision checks and atomic persistence.
 * Adapters prepare effects; this boundary alone commits them. */
export class CanvasDocument {
  constructor(private readonly scene: ToolScene, private readonly artifacts: CanvasArtifacts, private readonly save: (mutation: PendingCanvasMutation) => Promise<void>, private readonly submitted?: SubmittedContext) {}

  get revision() { return canvasRevision(this.scene) }
  alive(signal: AbortSignal) {
    signal.throwIfAborted()
    if (this.scene.disposed) throw new Error('The canvas has been closed')
  }
  /** Refuses an edit without an observed or successfully committed revision. */
  requireRevision(value: unknown, signal: AbortSignal) {
    this.alive(signal)
    if (typeof value !== 'string' || !value) throw new Error('A revision is required. Use the revision returned by canvas_inspect or the preceding successful edit.')
    if (value !== this.revision) throw new Error('The canvas changed. Read it again before writing.')
  }

  read(input: Record<string, any>, cwd?: string) {
    const detail = input.detail ?? 'summary', scope = input.ids ? 'ids' : input.scope ?? 'canvas'
    const offset = input.offset ?? 0, limit = input.limit ?? CANVAS_PAGE_DEFAULT
    validateCanvasReadPage(input)
    validateCanvasQuery(input)
    if (!['summary', 'elements'].includes(detail)) throw new Error('Invalid canvas status detail')
    if (input.scope !== undefined && !['canvas', 'selection', 'viewport', 'changes'].includes(input.scope)) throw new Error('Invalid canvas status scope')
    if (input.ids !== undefined && (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > CANVAS_PAGE_MAX || !input.ids.every((id: unknown) => typeof id === 'string' && id.length) || new Set(input.ids).size !== input.ids.length)) throw new Error(`ids must contain 1 to ${CANVAS_PAGE_MAX} unique element ids`)
    if (input.ids !== undefined && input.scope !== undefined) throw new Error('Choose scope or ids, not both')
    const revision = this.revision
    if (offset > 0 && input.revision === undefined) throw new Error('Continuing a canvas read requires the revision from the first page')
    if (input.revision !== undefined && input.revision !== revision) throw new Error('The canvas changed. Start reading again from offset 0.')
    const selection = this.submitted?.selection ?? this.scene.selectedIds
    const viewport = this.submitted?.viewport ?? this.scene.viewport
    const selected = new Set(selection)
    const elements = this.scene.elements
    const byId = new Map(elements.map(el => [el.id, el]))
    const changes = this.submitted?.changes
    if (scope === 'changes' && !changes) throw new Error('No submitted change history is available for this execution')
    const changed = new Map(changes?.elements.map(change => [change.id, change]))
    const query = typeof input.query === 'string' ? input.query.toLowerCase() : undefined
    const matching = scope === 'canvas' ? elements.filter(el =>
      (query === undefined || [el.type === 'text' ? el.originalText : '', 'name' in el ? el.name : '', objectLabel(el).title, objectLabel(el).caption].some(value => typeof value === 'string' && value.toLowerCase().includes(query))) &&
      (input.kind === undefined || shapeKind(el) === input.kind) &&
      (input.groupId === undefined || el.groupIds.includes(input.groupId))
    ) : elements
    const ids: readonly string[] = input.ids ?? (scope === 'selection' ? selection
      : scope === 'viewport' ? inRegion(elements, viewport).map(element => element.id)
      : scope === 'changes' ? [...changed.keys()] : matching.map(el => el.id))
    const missingIds = input.ids?.filter((id: string) => !byId.has(id)) ?? []
    if (missingIds.length) throw new Error(`No canvas elements have these ids: ${missingIds.join(', ')}`)
    const total = ids.length
    if (offset > total) throw new Error('offset exceeds the result count')
    const records: Record<string, unknown>[] = []
    let characters = 0
    for (let i = offset; i < Math.min(total, offset + limit); i++) {
      const id = ids[i]!, el = byId.get(id)
      const record: Record<string, unknown> = el ? { ...describe(el, detail, cwd), ...(selected.has(id) ? { selectedAtSubmission: true } : {}) } : { id, missing: true }
      if (scope === 'changes') Object.assign(record, changed.get(id))
      // Page only between complete records. Exact geometry can make a single
      // detailed record larger; never splice IDs or fields to fit a text budget.
      const size = JSON.stringify(record).length
      if (records.length && characters + size > CANVAS_PAGE_CHARACTERS) break
      records.push(record); characters += size
    }
    const next = offset + records.length
    return {
      engine: 'excalidraw',
      revision,
      viewport,
      selectionCount: selection.length,
      elementCount: elements.length,
      ...(scope === 'changes' ? { changes: { since: changes!.since, status: changes!.status } } : {}),
      coverage: { scope, total, offset, returned: records.length, nextOffset: next < total ? next : null },
      next: canvasReadContinuation(input, next < total ? next : null, revision),
      detail, elements: records
    }
  }

  /** Materialize immutable bytes under their content identity. The native
   * publisher verifies reuse, including across executions and reconnects. */
  async materialize(scope: CanvasToolScope, options: { element: string; source?: 'submitted' | 'current' }) {
    const { cwd, signal } = scope
    const before = this.revision, restoration = this.scene.restorationVersion
    const capturedImage = options.source !== 'current' ? this.submitted?.images.find(image => image.element.id === options.element) : undefined
    const capturedVideo = options.source !== 'current' ? this.submitted?.videos.find(video => video.element.id === options.element) : undefined
    const capturedHtml = options.source !== 'current' ? this.submitted?.html.find(html => html.element.id === options.element) : undefined
    if (options.source === 'submitted' && !capturedImage && !capturedVideo && !capturedHtml) throw new Error(`Element ${options.element} has no source captured from the submitted selection. To extract this element from the current canvas, omit source or use source: "current".`)
    const element = capturedImage?.element ?? capturedVideo?.element ?? capturedHtml?.element ?? this.scene.elements.find(el => el.id === options.element)
    const liveVideo = element ? videoData(element) : undefined
    const liveHtml = element ? htmlDocument(element) : undefined
    const file = capturedImage?.file ?? capturedVideo?.file ?? (element?.type === 'image' && element.fileId ? this.scene.assets[element.fileId] : liveVideo?.fileId ? this.scene.assets[liveVideo.fileId] : undefined)
    const kind = capturedImage || element?.type === 'image' ? 'image' as const : capturedVideo || liveVideo ? 'video' as const : capturedHtml || liveHtml ? 'html' as const : undefined
    if (!kind) throw new Error('This element has no extractable source. Extractable kinds are image, video and HTML.')
    if (kind !== 'html' && (!file || (kind === 'image' ? !sourceImageFormat(file.mimeType) : !file.mimeType.startsWith('video/')))) throw new Error(`This ${kind} has no readable source bytes${file ? ` (${file.mimeType})` : ''}.`)
    if (kind === 'html' && !(capturedHtml?.html ?? liveHtml?.html)) throw new Error('This HTML element has no readable document.')
    const revision = !capturedImage && !capturedVideo && !capturedHtml ? before : undefined
    const mimeType = kind === 'html' ? 'text/html' : file!.mimeType
    const blob = kind === 'html' ? new Blob([capturedHtml?.html ?? liveHtml!.html], { type: mimeType }) : assetBlob(file!)
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
    const identity = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    const path = joinArtifactPath(cwd, 'sources', `${identity}.${extension(mimeType)}`)
    const dataURL = await blobDataUrl(blob)
    const dataBase64 = dataURL.slice(dataURL.indexOf(',') + 1)
    if (kind === 'image') await (this.artifacts.writeArtifact?.(path, dataBase64, mimeType, scope) ?? this.artifacts.writeImage(path, dataBase64, scope))
    else if (!this.artifacts.writeArtifact) throw new Error(`This canvas connection cannot extract ${kind} sources. Update the Galta bridge.`)
    else await this.artifacts.writeArtifact(path, dataBase64, mimeType, scope)
    // Writing is asynchronous. Stop during it must not report a successful
    // export, so the abort is rechecked before the result is returned.
    signal.throwIfAborted()
    const size = kind === 'image' ? await imageDimensions(dataURL, signal) : kind === 'video' ? { w: liveVideo?.width ?? capturedVideo?.element.width ?? element?.width ?? 0, h: liveVideo?.height ?? capturedVideo?.element.height ?? element?.height ?? 0 } : { w: element?.width ?? 0, h: element?.height ?? 0 }
    this.alive(signal)
    if (revision !== undefined && (revision !== this.revision || restoration !== this.scene.restorationVersion)) throw new Error('The canvas changed while exporting. Read it again.')
    return {
      path, artifactUri: managedArtifactReference(path, cwd), kind, mimeType, width: size.w, height: size.h,
      source: capturedImage || capturedVideo || capturedHtml ? 'submitted' as const : 'element' as const,
      ...(revision !== undefined ? { revision } : {}),
      ...(element ? { elementId: element.id } : {})
    }
  }

  async saveMutation(snapshot: SceneSnapshot, signal: AbortSignal, appState: Partial<AppState> = {}, reveal?: { previous: { has(id: string): boolean }; work: CanvasWork }) {
    const revision = this.revision, restoration = this.scene.restorationVersion
    let applied = false
    const assertCurrent = () => {
      signal.throwIfAborted()
      if (this.scene.disposed) throw new Error('The canvas has been closed')
      if (revision !== this.revision || restoration !== this.scene.restorationVersion) throw new Error('The canvas changed while saving. Current edits are preserved. Read the canvas again.')
    }
    await this.save({ before: this.scene.snapshot(), snapshot, assertCurrent, apply: () => {
      if (applied) throw new Error('The saved canvas edit was already applied')
      assertCurrent()
      this.scene.applyPrepared(snapshot, true, appState, reveal)
      applied = true
    } })
    if (!applied) throw new Error('The saved canvas edit was not applied')
  }
}

/** One verb per effect. `CanvasDocument` owns revision and persistence
 * checks for every adapter. */
export class CanvasTool {
  private readonly document: CanvasDocument
  private readonly evidence = new Map<string, CanvasEvidence>()
  private slots: CanvasSlot[] = []
  private nextSlot = 1
  /** `showSlots` puts this execution's reserved places in front of the user;
   * the host clears them when the execution ends. */
  constructor(private readonly scene: ToolScene, private readonly artifacts: CanvasArtifacts, save: (mutation: PendingCanvasMutation) => Promise<void>, private readonly submitted?: SubmittedContext, private readonly showSlots: (slots: readonly CanvasSlot[]) => void = () => {}) {
    this.document = new CanvasDocument(scene, artifacts, save, submitted)
  }
  private remember(evidence: CanvasEvidence) {
    this.evidence.set(evidence.id, evidence)
    while (this.evidence.size > 64) this.evidence.delete(this.evidence.keys().next().value!)
  }

  /** The numbers a marked canvas_capture of this view target draws, without
   * rendering it, so a message can name them even when its pixels were sent
   * earlier. */
  marks(target: Record<string, unknown>) {
    const elements = this.scene.elements
    return captureMarks(elements, observeCanvas(elements, target, this.submitted?.selection ?? this.scene.selectedIds).ids)
  }

  /** Throws for an unserved tool rather than answering with an empty success,
   * so a mismatched surface is reported instead of silently doing nothing. */
  async execute(tool: string, value: unknown, scope: CanvasToolScope): Promise<ToolResult> {
    switch (tool) {
      case 'canvas_inspect': return this.status(value, scope)
      case 'canvas_capture': return this.view(value, scope)
      case 'canvas_report': return this.report(value, scope)
      case 'canvas_edit': return textResult((await this.write(value, scope)).receipt)
      case 'canvas_place': return this.place(value, scope)
      case 'canvas_reserve': return this.reserve(value, scope)
      case 'canvas_extract': return this.export(value, scope)
      case 'canvas_deliver': return this.deliver(value, scope)
      default: throw new Error(`Unknown canvas tool: ${tool}`)
    }
  }

  private status(value: unknown, scope: CanvasToolScope): ToolResult {
    const input = value === undefined ? {} : args(value)
    this.document.alive(scope.signal)
    const result = this.document.read(input, scope.cwd)
    const recordScope = (input.ids !== undefined ? 'ids' : input.scope ?? 'canvas') as CanvasEvidence['scope']
    const records = result.elements
    const totalElementCount = Number(result.coverage?.total ?? records.length)
    const coveredElementCount = records.length
    const complete = result.next === null
    const evidence = makeStructureEvidence({ revision: String(result.revision), scope: recordScope, elementIds: records.map((item: any) => String(item.id)), totalElementCount, coveredElementCount, missingElementIds: records.filter((item: any) => item?.missing === true).map((item: any) => String(item.id)), complete, detail: input.detail ?? 'summary', limitations: complete ? [] : ['This is one page; continue with the returned next arguments before claiming complete coverage.'] })
    this.remember(evidence)
    return textResult({ ...result, evidence })
  }

  /** Render exactly the requested scope and report any non-renderable content. */
  private async view(value: unknown, scope: CanvasToolScope): Promise<ToolResult> {
    const input = args(value)
    this.document.alive(scope.signal)
    const before = this.document.revision
    const elements = this.scene.elements
    if (input.detail !== undefined && !['low', 'high'].includes(input.detail)) throw new Error('Invalid canvas view detail')
    if (input.file !== undefined && typeof input.file !== 'boolean') throw new Error('file must be true or false')
    if (input.marks !== undefined && typeof input.marks !== 'boolean') throw new Error('marks must be true or false')
    if (input.grid !== undefined && typeof input.grid !== 'boolean') throw new Error('grid must be true or false')
    const detail = input.detail === 'high' ? 'high' : 'low'
    const target = observeCanvas(elements, input, this.submitted?.selection ?? this.scene.selectedIds)
    if (!target.ids.length) throw new Error('There is nothing in that canvas view.')
    const viewedIds = new Set(target.ids)
    const viewed = elements.filter(el => viewedIds.has(el.id))
    const numbered = input.marks === true ? captureMarks(elements, target.ids) : undefined
    const overlay = numbered || input.grid === true ? { marks: numbered?.marks ?? [], grid: input.grid === true } : undefined
    if (overlay && input.file === true) throw new Error('file saves the canvas as drawn; request marks or grid in a separate view.')
    // Pages show as posters of the loaded page; other embedded content, and a
    // page whose poster could not be drawn, shows only its bounds or title.
    const titled: string[] = []
    const preview = await this.scene.preview(target.ids, detail, target.bounds, titled, overlay)
    const unsupported = [...viewed.filter(el => ['embeddable', 'iframe'].includes(el.type) && !videoData(el) && !htmlDocument(el)).map(el => el.id), ...titled]
    const pages = viewed.filter(el => htmlDocument(el) && !titled.includes(el.id)).map(el => el.id)
    this.document.alive(scope.signal)
    if (before !== this.document.revision) throw new Error('The canvas changed while rendering. Read it again.')
    if (!preview) throw new Error('There is nothing on the canvas to view.')
    const limit = input.detail === 'high' ? 1_500_000 : 600_000
    if (preview.size > limit) throw new Error('That view is too large. Use a smaller region or selection.')
    const imageUrl = await blobDataUrl(preview)
    this.document.alive(scope.signal)
    if (before !== this.document.revision) throw new Error('The canvas changed while rendering. Read it again.')
    const digest = await crypto.subtle.digest('SHA-256', await preview.arrayBuffer())
    this.document.alive(scope.signal)
    if (before !== this.document.revision) throw new Error('The canvas changed while rendering. Read it again.')
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    // Two different limits, never conflated: rendering covers every requested
    // element, while identity retention is capped by the page bound. Reporting
    // the identity cap as omission told the agent that visible elements were
    // missing; reporting it as coverage claimed more named identities than the
    // record carries. The limitation text states the cap, and `complete` flips.
    const truncatedIds = target.ids.length > CANVAS_PAGE_MAX
    const limitations = [
      ...(pages.length ? ['Embedded HTML shows as a poster of its page once loaded, without interaction state; remote resources that refuse cross-origin reads, nested frames and WebGL may be missing.'] : []),
      ...(unsupported.length ? ['Some embedded content could not be rendered; only its bounds or title are visible.'] : []),
      ...(truncatedIds ? [`This view renders all ${target.ids.length} elements but names only ${CANVAS_PAGE_MAX} identities; use a smaller exact view for object-level claims.`] : [])
    ]
    const complete = limitations.length === 0
    const implicitSelection = input.scope === undefined && input.element === undefined && input.ids === undefined && input.region === undefined && (this.submitted?.selection ?? this.scene.selectedIds).length > 0
    const selectionTarget = input.scope === 'selection' || implicitSelection
    const focus = input.region !== undefined ? 'region' : input.element !== undefined || input.ids !== undefined || selectionTarget && input.include === 'exact' ? input.include === 'exact' ? 'exact' : 'related' : selectionTarget ? 'selection' : 'canvas'
    const evidence = makePixelsEvidence({ revision: before, scope: target.scope, ...(target.bounds ? { region: target.bounds } : {}), elementIds: target.ids, totalElementCount: viewed.length, complete, detail, sha256, focus, limitations })
    this.remember(evidence)
    // The exact pixels the agent saw become a reference it can generate from.
    let saved: { path: string; artifactUri: string } | undefined
    if (input.file === true) {
      const path = joinArtifactPath(scope.cwd, 'sources', `${sha256}.jpg`)
      const dataBase64 = imageUrl.slice(imageUrl.indexOf(',') + 1)
      await (this.artifacts.writeArtifact?.(path, dataBase64, 'image/jpeg', scope) ?? this.artifacts.writeImage(path, dataBase64, scope))
      scope.signal.throwIfAborted()
      saved = { path, artifactUri: managedArtifactReference(path, scope.cwd) }
    }
    const metadata = { revision: before, scope: target.scope, ...(target.bounds ? { region: target.bounds } : {}), elementIds: evidence.elementIds, elementCount: viewed.length, complete, unrenderedElementIds: unsupported, videoPosterIds: viewed.filter(el => videoData(el)).map(el => el.id), htmlPosterIds: pages, ...(limitations.length ? { limitation: limitations.join(' ') } : {}),
      ...(numbered ? { marks: numbered.marks, ...(numbered.total > numbered.marks.length ? { unmarkedObjectCount: numbered.total - numbered.marks.length } : {}) } : {}), evidence, ...saved }
    return { content: [{ type: 'image', data: imageUrl.slice(imageUrl.indexOf(',') + 1), mimeType: 'image/jpeg' }, { type: 'text', text: JSON.stringify(metadata) }], structuredContent: metadata }
  }

  private report(value: unknown, scope: CanvasToolScope): ToolResult {
    const input = canvasReportSchema.parse(args(value))
    this.document.requireRevision(input.revision, scope.signal)
    const records = [...this.evidence.values()]
    const assessments = input.claims.map(claim => assessCanvasClaim(claim, records, input.revision))
    const used = new Set(input.claims.flatMap(claim => claim.evidenceIds))
    return textResult({ revision: input.revision, boundary: 'evidence-only', assessments, evidence: records.filter(record => used.has(record.id)) })
  }

  private async write(value: unknown, scope: CanvasToolScope, selectedIds?: string[]) {
    const input = args(value)
    this.document.alive(scope.signal)
    const revision = this.document.revision
    this.document.requireRevision(input.revision, scope.signal)
    const restoration = this.scene.restorationVersion
    const assertCurrent = () => {
      this.document.requireRevision(revision, scope.signal)
      if (this.scene.restorationVersion !== restoration) throw new Error('The canvas changed. Read it again before writing.')
    }
    if (!Array.isArray(input.operations)) throw new Error('Canvas operations are required')
    const operations = input.operations as CanvasOperation[]
    if (!operations.length) validateCanvasOperations(operations)
    const work = new CanvasWork(scope.signal)
    const artifacts = new Map<string, { html: string; generatedPath: string; executionId: string; provenance?: CanvasToolScope['provenance'] }>()
    const media = new Map<string, PreparedMediaArtifact>()
    let files = this.scene.assets
    for (const [index, op] of operations.entries()) {
      await work.checkpoint()
      validateCanvasOperations([op], index)
      const mediaPath = 'props' in op ? op.props?.mediaPath : undefined
      if (typeof mediaPath === 'string' && !media.has(mediaPath)) {
        const prepared = await prepareMediaArtifact(mediaPath, this.artifacts, scope, this.scene.viewport)
        assertCurrent()
        media.set(mediaPath, prepared); files = { ...files, ...prepared.files }
      }
      const path = 'props' in op ? op.props?.htmlPath : undefined
      if (typeof path !== 'string' || artifacts.has(path)) continue
      const artifact = await this.artifacts.readHtml(path, scope)
      assertCurrent()
      artifacts.set(path, { html: validateHtml(artifact.html), generatedPath: managedArtifactReference(path, scope.cwd), executionId: scope.executionId, provenance: scope.provenance })
    }
    // Reading artifacts is asynchronous, so the revision is rechecked here.
    // A concurrent edit must be reported as such, never resolved by preparing
    // an operation against a document that has already moved on.
    assertCurrent()
    // Native edits bump versions, including their related text and arrows.
    // Restoration also normalizes transient fields (e.g. lastCommittedPoint);
    // those are not document edits and must not inflate the reply.
    const before = new Map(this.scene.elements.map(el => [el.id, `${el.version}:${el.versionNonce}`]))
    const elements = await planCreativeOperationsAsync(this.scene.elements, operations, artifacts, work, media, new Map(this.slots.map(slot => [slot.id, slot])))
    assertCurrent()
    const snapshot = this.scene.prepare(elements, files)
    // Native bitmaps are warmed before the atomic swap; the reveal is replayed by
    // the commit itself, so decoration never delays the transaction. A failure
    // before the swap leaves nothing staged, and the commit path clears any
    // reveal from an earlier edit.
    await this.scene.prepareRender(snapshot.document.elements, work)
    await work.checkpoint()
    // Preparation yields to real input. Never adopt a newer revision for a
    // candidate constructed from the original document.
    assertCurrent()
    await this.document.saveMutation(snapshot, scope.signal, selectedIds ? { selectedElementIds: Object.fromEntries(selectedIds.map(id => [id, true])) } : {}, { previous: before, work })
    const filled = operations.flatMap(op => 'slot' in op && op.slot !== undefined ? [op.slot] : [])
    if (filled.length) this.endSlots(filled)
    // One pass classifies the outcome. A receipt states what the document now
    // is; grouping is the agent's judgement, so the note below neither blocks
    // the write nor invents a group. It surfaces a fact the caller could
    // otherwise only infer from a missing field: a batch that created several
    // elements and grouped none of them leaves the user with pieces that cannot
    // be selected or moved together. Any deliberate unit stays silent.
    const changed: Array<ReturnType<typeof describe> & { change: 'created' | 'updated' }> = []
    const present = new Set<string>()
    let created = 0, ungrouped = 0
    for (const el of this.scene.elements) {
      present.add(el.id)
      const was = before.get(el.id)
      if (was === `${el.version}:${el.versionNonce}`) continue
      if (was === undefined) { created++; if (!el.groupIds.length) ungrouped++ }
      changed.push({ ...describe(el, 'summary', scope.cwd), change: was === undefined ? 'created' as const : 'updated' as const })
    }
    const receipt = { revision: this.document.revision, elementCount: present.size, elements: changed,
      deletedIds: [...before.keys()].filter(id => !present.has(id)) }
    if (created > 1 && ungrouped === created) {
      // Reported as a count, so a caller reads the fact without parsing prose.
      return { media, receipt: { ...receipt, notes: [`${created} elements were created with no group. They cannot be selected or moved as one unit; if they are one deliverable, resubmit them sharing a props.groupIds entry.`] } }
    }
    return { media, receipt }
  }

  private async place(value: unknown, scope: CanvasToolScope): Promise<ToolResult> {
    const input = args(value)
    this.document.requireRevision(input.revision, scope.signal)
    if (typeof input.path !== 'string' || !isAbsoluteArtifactPath(input.path)) throw new Error('An absolute media path is required')
    for (const field of ['x', 'y', 'width', 'height', 'rotation']) if (input[field] !== undefined && (typeof input[field] !== 'number' || !Number.isFinite(input[field]) || (['width', 'height'].includes(field) && input[field] <= 0))) throw new Error(`Invalid media ${field}`)
    if ((input.x === undefined) !== (input.y === undefined)) throw new Error('Media x and y must be supplied together')
    if (input.replace !== undefined && (typeof input.replace !== 'string' || !input.replace)) throw new Error('Invalid replacement id')
    if (input.replace !== undefined && ['x', 'y', 'width', 'height', 'rotation'].some(key => input[key] !== undefined)) throw new Error('Replacement preserves geometry; place geometry applies only to new media')
    if (input.slot !== undefined && (typeof input.slot !== 'string' || !input.slot)) throw new Error('Invalid slot')
    if (input.slot !== undefined && ['x', 'y', 'width', 'height'].some(key => input[key] !== undefined)) throw new Error('A slot sets the geometry; omit x, y, width and height')
    if (input.slot !== undefined && !this.slots.some(slot => slot.id === input.slot)) throw new Error(`${input.slot} is no longer reserved. Place with geometry instead.`)
    const elementId = input.replace ?? crypto.randomUUID()
    const props = { mediaPath: input.path, ...(input.width === undefined ? {} : { width: input.width }), ...(input.height === undefined ? {} : { height: input.height }),
      ...(input.title === undefined ? {} : { title: input.title }), ...(input.caption === undefined ? {} : { caption: input.caption }) }
    const slot = input.slot === undefined ? {} : { slot: input.slot as string }
    const operation: CanvasOperation = input.replace ? { type: 'update_element', elementId, props, ...slot }
      : {
          type: 'create_element', id: elementId, elementType: videoFile(input.path) ? 'video' : 'image', props, ...slot,
          ...(input.x === undefined ? {} : { x: input.x, y: input.y }),
          ...(input.rotation === undefined ? {} : { rotation: input.rotation })
        }
    const { receipt, media } = await this.write({ revision: input.revision, operations: [operation] }, scope, [elementId])
    const element = this.scene.elements.find(el => el.id === elementId)!
    return textResult({ placed: true, action: input.replace ? 'updated' : 'created', kind: shapeKind(element), elementId,
      ...(media.get(input.path)?.kind === 'image' ? { width: media.get(input.path)!.width, height: media.get(input.path)!.height } : {}),
      revision: receipt.revision, element: describe(element, 'elements', scope.cwd) })
  }

  /** Held places are view state, so this needs no revision and changes no document. */
  private reserve(value: unknown, scope: CanvasToolScope): ToolResult {
    const input = args(value)
    this.document.alive(scope.signal)
    if (input.places === undefined && input.release === undefined) throw new Error('Give places to reserve or places to release')
    if (input.release !== undefined && (!Array.isArray(input.release) || !input.release.length || input.release.some((id: unknown) => typeof id !== 'string'))) throw new Error('release must list reserved place ids')
    const places = input.places ?? []
    if (!Array.isArray(places) || (input.places !== undefined && !places.length) || places.length > 12) throw new Error('places must list 1 to 12 places')
    for (const place of places) {
      if (!place || typeof place !== 'object') throw new Error('Each place needs a width and height')
      for (const field of ['width', 'height']) if (typeof place[field] !== 'number' || !(place[field] > 0 && place[field] <= CANVAS_SLOT_SIDE)) throw new Error(`Invalid place ${field}: from 0 to ${CANVAS_SLOT_SIDE}`)
      for (const field of ['x', 'y']) if (place[field] !== undefined && (typeof place[field] !== 'number' || !(Math.abs(place[field]) <= 1e7))) throw new Error(`Invalid place ${field}`)
      if ((place.x === undefined) !== (place.y === undefined)) throw new Error('Place x and y must be supplied together')
    }
    const kept = this.slots.filter(slot => !input.release?.includes(slot.id))
    if (kept.length + places.length > CANVAS_SLOT_LIMIT) throw new Error(`At most ${CANVAS_SLOT_LIMIT} places can be held at once; fill or release some first`)
    this.slots = [...kept, ...arrangePlaces(places, this.scene.viewport.center).map(box => ({ id: `place-${this.nextSlot++}`, ...box }))]
    this.showSlots(this.slots)
    return textResult({ slots: this.slots })
  }
  private endSlots(ids: readonly string[]) {
    this.slots = this.slots.filter(slot => !ids.includes(slot.id))
    this.showSlots(this.slots)
  }

  /** Submitted exports retain the original; current exports verify a live revision. */
  private async export(value: unknown, scope: CanvasToolScope): Promise<ToolResult> {
    const input = args(value)
    this.document.alive(scope.signal)
    if (input.source !== undefined && !['submitted', 'current'].includes(input.source)) throw new Error('Source must be submitted or current')
    const paged = input.scope !== undefined || input.ids !== undefined
    if (paged) {
      if (input.element !== undefined) throw new Error('Choose a paged scope/ids or one element, not both')
      if (input.scope !== undefined && input.scope !== 'selection') throw new Error('Extract scope must be selection; use ids for other elements')
      const page = this.document.read({ scope: input.scope, ids: input.ids, offset: input.offset, limit: input.limit, revision: input.revision }, scope.cwd)
      const restoration = this.scene.restorationVersion
      const materialized: Record<string, unknown>[] = []
      for (const record of page.elements) {
        this.document.alive(scope.signal)
        const extractable = ['image', 'video', 'html'].includes(String(record.kind)) || record.missing && this.submitted && [
          ...this.submitted.images, ...this.submitted.videos, ...this.submitted.html
        ].some(media => media.element.id === record.id)
        materialized.push(extractable ? { ...record, file: await this.document.materialize(scope, { element: String(record.id), source: input.source }) } : record)
      }
      this.document.requireRevision(page.revision, scope.signal)
      if (restoration !== this.scene.restorationVersion) throw new Error('The canvas changed while exporting. Read it again.')
      return textResult({ ...page, next: canvasReadContinuation(input, page.coverage.nextOffset, page.revision), elements: materialized })
    }
    if (['offset', 'limit', 'revision'].some(key => input[key] !== undefined)) throw new Error('Pagination requires scope or ids')
    if (typeof input.element !== 'string' || !input.element) throw new Error('Name a canvas element, or use scope/ids for a page.')
    const artifact = await this.document.materialize(scope, { element: input.element, source: input.source })
    return textResult(artifact)
  }

  private async deliver(value: unknown, scope: CanvasToolScope): Promise<ToolResult> {
    const input = args(value)
    this.document.alive(scope.signal)
    if (typeof input.source !== 'string' || !input.source.trim()) throw new Error('A source artifact reference is required')
    if (typeof input.destination !== 'string' || !input.destination.trim()) throw new Error('A destination filename is required')
    return textResult(await this.artifacts.deliver(input.source, input.destination, scope))
  }
}
