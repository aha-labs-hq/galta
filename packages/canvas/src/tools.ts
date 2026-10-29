import { CANVAS_OPERATION_SCHEMA, OBJECT_CAPTION_DESCRIPTION, OBJECT_CAPTION_MAX, OBJECT_TITLE_DESCRIPTION, OBJECT_TITLE_MAX } from './operations'
import { CANVAS_IDS_SCHEMA, CANVAS_PAGE_SCHEMA, CANVAS_QUERY_SCHEMA, CANVAS_PAGE_DEFAULT, CANVAS_PAGE_MAX } from './reads'
import { MAX_HTML_BYTES } from './html'
import { CANVAS_GROUPING_INSTRUCTIONS } from './instructions'
import type { ToolDefinition } from './execution'
import { canvasChangeSchema, canvasChangesMetadataSchema } from './message'
import { z } from 'zod'
import { canvasBoundsSchema, CANVAS_COORDINATE_INSTRUCTIONS } from './bounds'
import { canvasEvidenceSchema, canvasReportSchema } from './evidence'
import { CANVAS_SLOT_SIDE } from './slots'

const { $schema: _boundsDraft, ...boundsOutput } = z.toJSONSchema(canvasBoundsSchema, { target: 'draft-7' })

const elementOutput = { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string' }, type: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, rotation: { type: 'number' }, bounds: boundsOutput, text: { type: 'string' }, title: { type: 'string' }, caption: { type: 'string' }, missing: { type: 'boolean' }, selectedAtSubmission: { type: 'boolean' }, change: { enum: canvasChangeSchema.shape.change.options }, sources: { type: 'array', items: { enum: canvasChangeSchema.shape.sources.element.options } }, generatedPath: { type: 'string' } }, required: ['id'], additionalProperties: true } as const
const coverageOutput = { type: 'object', properties: { scope: { type: 'string' }, total: { type: 'integer', minimum: 0 }, offset: { type: 'integer', minimum: 0 }, returned: { type: 'integer', minimum: 0 }, nextOffset: { type: ['integer', 'null'], minimum: 0 } }, required: ['scope', 'total', 'offset', 'returned', 'nextOffset'], additionalProperties: true } as const
const viewportOutput = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, zoom: { type: 'number' } }, required: ['x', 'y', 'width', 'height', 'zoom'], additionalProperties: true } as const
const fileOutput = { type: 'object', properties: { path: { type: 'string', description: 'Absolute machine path for subsequent Galta tool calls. Prefer artifactUri for a user-facing link; a plain path is never made clickable.' }, artifactUri: { type: 'string', pattern: '^galta-workspace:/', description: 'Stable user-facing artifact reference. Copy this value verbatim into a Markdown link when delivering the extracted source.' }, kind: { enum: ['image', 'video', 'html'] }, mimeType: { type: 'string' }, source: { enum: ['submitted', 'element'] }, width: { type: 'number' }, height: { type: 'number' }, elementId: { type: 'string' } }, required: ['path', 'artifactUri', 'kind', 'mimeType', 'source', 'width', 'height'], additionalProperties: true } as const
const deliveryOutput = { type: 'object', properties: { path: { type: 'string', description: 'Exact destination path created inside the current execution workspace.' }, artifactUri: { type: 'string', pattern: '^galta-workspace:/', description: 'Canonical user-facing URI for the delivered copy. Use this value verbatim if the final response includes a link.' }, sourceArtifactUri: { type: 'string', pattern: '^galta-workspace:/' }, name: { type: 'string' }, mimeType: { type: 'string' }, size: { type: 'integer', minimum: 0 }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, version: { type: 'string' } }, required: ['path', 'artifactUri', 'sourceArtifactUri', 'name', 'mimeType', 'size', 'sha256', 'version'], additionalProperties: false } as const
const { $schema: _changesDraft, ...changesOutput } = z.toJSONSchema(canvasChangesMetadataSchema, { target: 'draft-7' })
const { $schema: _evidenceDraft, ...evidenceOutput } = z.toJSONSchema(canvasEvidenceSchema, { target: 'draft-7' })
const { $schema: _reportDraft, ...reportInput } = z.toJSONSchema(canvasReportSchema, { target: 'draft-7' })
const pageOutput = { type: 'object', properties: { engine: { type: 'string' }, revision: { type: 'string' }, viewport: viewportOutput, selectionCount: { type: 'integer', minimum: 0 }, elementCount: { type: 'integer', minimum: 0 }, detail: { enum: ['summary', 'elements'] }, coverage: coverageOutput, next: { type: ['object', 'null'] }, evidence: evidenceOutput, changes: changesOutput, elements: { type: 'array', items: elementOutput } }, required: ['revision', 'coverage', 'next', 'evidence'], additionalProperties: true } as const
const receiptOutput = { type: 'object', properties: { revision: { type: 'string' }, elementCount: { type: 'integer', minimum: 0 }, elements: { type: 'array', items: elementOutput }, deletedIds: { type: 'array', items: { type: 'string' } }, notes: { type: 'array', items: { type: 'string' } } }, required: ['revision', 'elementCount', 'elements', 'deletedIds'], additionalProperties: true } as const

export const CANVAS_TOOLS = [
  {
    name: 'canvas_inspect',
    annotations: { readOnlyHint: true, openWorldHint: false },
    execution: { resource: 'canvas', exclusive: false },
    outputSchema: pageOutput,
    description: `List, search or read canvas elements and their revision. Like ls/grep: use query for text/name, kind for object kind, groupId for group contents. Like reading a file: use ids and detail elements for exact fields. Defaults to summary, scope canvas, ${CANVAS_PAGE_DEFAULT} records; limit is 1–${CANVAS_PAGE_MAX}. ${CANVAS_COORDINATE_INSTRUCTIONS} Scope selection reads objects selected at submission, viewport reads objects in the submitted view, changes reads recorded net differences since the previous submitted observation (including deleted IDs and change sources). These are observations, not inferred edit targets. Every result includes an evidence record for this page. A page is not the whole set: pass next back to this tool with its continuation revision until next is null. No pixels: use canvas_capture.`,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        detail: { type: 'string', enum: ['summary', 'elements'], description: 'summary lists geometry, a text excerpt and groupIds (innermost first; omitted means ungrouped). elements adds exact writable fields, bindings, crop, file and provenance; individual records can be large, so target relevant IDs.' },
        scope: { type: 'string', enum: ['canvas', 'selection', 'viewport', 'changes'], description: 'canvas reads current elements; selection keeps submitted selection order; viewport uses submitted world-coordinate bounds; changes retains submitted change identities with current fields and a changes status (initial/compared/unrelated-history). Change history must have been supplied by the host. Mutually exclusive with ids.' },
        ids: { ...CANVAS_IDS_SCHEMA, description: `${CANVAS_IDS_SCHEMA.description} Mutually exclusive with scope and search filters.` },
        ...CANVAS_QUERY_SCHEMA,
        ...CANVAS_PAGE_SCHEMA
      }
    }
  },
  {
    name: 'canvas_capture',
    annotations: { readOnlyHint: true, openWorldHint: false },
    execution: { resource: 'canvas', exclusive: false },
    outputSchema: { type: 'object', properties: { revision: { type: 'string' }, scope: { type: 'string' }, region: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['x', 'y', 'width', 'height'], additionalProperties: false }, elementIds: { type: 'array', items: { type: 'string' } }, elementCount: { type: 'integer', minimum: 0 }, complete: { type: 'boolean' }, unrenderedElementIds: { type: 'array', items: { type: 'string' } }, videoPosterIds: { type: 'array', items: { type: 'string' } }, htmlPosterIds: { type: 'array', items: { type: 'string' } }, path: { type: 'string', description: 'Present with file: the saved view, usable as a file reference in later tool calls.' }, artifactUri: { type: 'string', pattern: '^galta-workspace:' }, limitation: { type: 'string' }, marks: { type: 'array', description: 'Present with marks: the number drawn on each object, with its element IDs, outermost group and world bounds.', items: { type: 'object', properties: { label: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } }, groupId: { type: 'string' }, bounds: boundsOutput }, required: ['label', 'ids', 'bounds'], additionalProperties: false } }, unmarkedObjectCount: { type: 'integer', minimum: 1, description: 'Objects left unnumbered because the view holds too many; the largest are numbered.' }, evidence: evidenceOutput }, required: ['revision', 'scope', 'elementIds', 'elementCount', 'complete', 'unrenderedElementIds', 'evidence'], additionalProperties: true },
    description: 'Look at the canvas as an image. Returns a JPEG plus revision, coverage, a content hash and an evidence record. Look before you call visual work done or say it matches a reference. scope canvas includes every element regardless of selection. Embedded HTML shows as a poster of its page once loaded, without interaction state, and makes the view incomplete. This action costs image tokens; prefer the smallest useful scope and canvas_inspect for textual checks. marks numbers each object in the view and returns which IDs each number names, so overlapping or similar objects are never confused. grid draws world-coordinate lines labelled on the edges, so positions read off the image can be used directly as x/y and points. Both are annotations over the view, not canvas content. With file, the same view is also saved as a JPEG in the workspace and its path returned, so a sketch, a layout or marks drawn over an image can become a generation reference.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        element: { type: 'string', description: 'Render this element and its native group, contained text and frame children. include exact renders only the named element.' },
        ids: { ...CANVAS_IDS_SCHEMA, description: `Render 1 to ${CANVAS_PAGE_MAX} unique element IDs together, including related content by default.` },
        region: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 } }, required: ['x', 'y', 'width', 'height'], additionalProperties: false, description: 'World-coordinate crop of the live composition; includes overlapping text, images and backgrounds regardless of grouping. Choose exactly one target: element, ids, region or scope.' },
        include: { type: 'string', enum: ['related', 'exact'], description: 'related (default) includes native group members, bound text and frame children. exact isolates the requested IDs. For element, ids and selection targets only.' },
        scope: { type: 'string', enum: ['canvas', 'selection'], description: 'What to render when no element id is given. Defaults to the submitted selection when there is one, otherwise the whole canvas.' },
        file: { type: 'boolean', description: 'Also save this exact view as a workspace JPEG and return its path, to use as a generation reference. Not with marks or grid.' },
        marks: { type: 'boolean', description: 'Number each object (outermost group or ungrouped element) at its top-left inside a dashed outline, and return marks mapping each number to its IDs.' },
        grid: { type: 'boolean', description: 'Draw world-coordinate grid lines with their values on the top and left edges.' },
        detail: { type: 'string', enum: ['low', 'high'], description: 'Raster budget, independent of document units or zoom: low (default) uses 1400 pixels on the longer side, high uses 2800. The agent host controls subsequent image resizing and model token cost; use a smaller region for fine details.' }
      }
    }
  },
  {
    name: 'canvas_report',
    annotations: { readOnlyHint: true, openWorldHint: false },
    execution: { resource: 'canvas', exclusive: false },
    outputSchema: { type: 'object', properties: {
      revision: { type: 'string' }, boundary: { const: 'evidence-only' },
      assessments: { type: 'array', items: { type: 'object', properties: {
        claim: { type: 'string' }, category: { type: 'string' }, basis: { type: 'string' }, certainty: { type: 'string' }, evidenceIds: { type: 'array', items: { type: 'string' } }, targetIds: { type: 'array', items: { type: 'string' } }, status: { enum: ['evidence-sufficient', 'insufficient-evidence', 'mixed-revision', 'stale-revision', 'unverified'] }, reason: { type: 'string' },
        semantic: { const: 'unverified' }
      }, required: ['claim', 'category', 'basis', 'certainty', 'evidenceIds', 'targetIds', 'status', 'semantic', 'reason'], additionalProperties: false } },
      evidence: { type: 'array', maxItems: 128, items: evidenceOutput }
    }, required: ['revision', 'boundary', 'assessments', 'evidence'], additionalProperties: false },
    description: 'Declare material canvas claims and the exact evidence IDs they rely on. Pass the revision from the latest inspect or capture; the report fails if the canvas has changed. The result checks only medium, identity, coverage and revision; `semantic: "unverified"` is always explicit because this tool cannot judge whether a model described pixels correctly. Use pixels for appearance, bounds for spatial relations, native fields for editable structure, and state uncertainty when the image is ambiguous. A rejected claim requires another inspect/capture or an explicit unknown in the answer.',
    inputSchema: reportInput
  },
  {
    name: 'canvas_edit',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    execution: { resource: 'canvas', exclusive: true },
    outputSchema: receiptOutput,
    description: `Change the canvas document. Requires a revision from canvas_inspect, canvas_capture, a paged canvas_extract or the preceding successful edit; a mismatch means the canvas changed and you must read it again. Returns changed element summaries with change created/updated, saved generatedPath where applicable, and deleted IDs. Use this authoritative receipt for structure and grouping checks; read again only for fields it does not contain or after a revision conflict. Every operation is validated, and the whole batch is applied as one atomic edit the user can undo.
Creation uses optional id; update_element, move, delete, bind_arrow and bind_text require elementId copied from a returned element.id. For example: {type:"move",elementId:"<element.id>",x:100,y:200}. Native creation requires x/y; freedraw also requires props.points. bind_arrow requires start or end (null detaches); bind_text requires containerId (null detaches). Each operation accepts only its own declared fields. Errors identify the zero-based operations[index]; fix that operation, not unrelated artwork.
${CANVAS_GROUPING_INSTRUCTIONS} A task that needs several independent units may commit several batches, but a single deliverable must not be left ungrouped. This is a judgement about the work, never a count of elements or batches.
For images and videos, use create_element with elementType image/video and props.mediaPath, or update_element with elementId and props.mediaPath to replace the same media kind. Media creation may omit x/y to center in the execution viewport; one dimension preserves aspect ratio, two set exact size. Replacement preserves identity, geometry and grouping unless explicitly edited in the batch, and resets image crop to show the full new image. Combine media, layout, groups and native elements in one batch after choosing the outputs. Generation alone never changes the canvas. Name a page, image or video with props.title and describe it with props.caption; Galta shows them as its header and caption, so do not draw separate label text for it.
For interactive HTML, save a complete UTF-8 .html document in the creative workspace (at most ${MAX_HTML_BYTES} bytes). Inline local CSS, JavaScript and images or use absolute HTTPS resources; relative files are not served. Create with {type:"create_element",elementType:"html",x:100,y:100,props:{htmlPath:"/absolute/workspace/outputs/page.html",width:960,height:640}}; update with update_element, elementId and props.htmlPath. The isolated preview supports scripts, forms and scrolling, but interaction state is not saved. Canvas bitmap views show HTML as a poster of the loaded page, not its interaction. Verify behavior from source or use your host's browser tools; do not substitute a screenshot for requested HTML. The receipt confirms the saved element and generatedPath.`,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        revision: { type: 'string', description: 'Revision from the latest status or successful edit; reuse it for the next edit unless the canvas changes.' },
        operations: {
          type: 'array', minItems: 1, description: 'Operations are applied in order as one atomic edit. There is no operation-count limit. Creation IDs may be referenced by later operations in this batch.',
          items: CANVAS_OPERATION_SCHEMA
        }
      }, required: ['revision', 'operations']
    }
  },
  {
    name: 'canvas_place',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    execution: { resource: 'canvas', exclusive: true },
    outputSchema: { type: 'object', properties: { placed: { const: true }, action: { enum: ['created', 'updated'] }, kind: { type: 'string' }, elementId: { type: 'string' }, revision: { type: 'string' }, element: { type: 'object' } }, required: ['placed', 'action', 'kind', 'elementId', 'revision', 'element'], additionalProperties: true },
    description: 'Convenience for committing one image or video file. Uses the same atomic transaction as canvas_edit; use canvas_edit to commit multiple media and native/layout edits together. This is how a generated image reaches the user: image generation itself never changes the canvas. Pass an absolute PNG, JPEG, WebP, MP4, WebM, MOV or OGV path inside the creative workspace. Videos are native playable objects (up to 128 MB, browser-supported codecs); canvas_capture shows their saved poster, not playback. Replacement must keep the same media kind. Returns action created/updated, kind, the saved element and revision. Image replacement resets crop to show the full new image.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        revision: { type: 'string', description: 'Revision from the latest status or successful edit; reuse it for the next edit unless the canvas changes.' },
        path: { type: 'string', description: 'Absolute path of the real image or video file.' },
        replace: { type: 'string', description: 'Existing image or video to replace, preserving geometry; cannot combine with placement geometry.' },
        slot: { type: 'string', description: 'A place from canvas_reserve to fill: new media is fitted inside it, keeping its proportions, and the place ends. Cannot combine with placement geometry; with replace it only ends the place.' },
        x: { type: 'number', description: 'New media left position; supply together with y. Omit both to center in the execution viewport returned by canvas_inspect.' }, y: { type: 'number' },
        width: { type: 'number', exclusiveMinimum: 0, description: 'New media width. One dimension preserves aspect ratio; two dimensions set the exact size.' },
        height: { type: 'number', exclusiveMinimum: 0 }, rotation: { type: 'number', description: 'New media rotation in radians.' },
        title: { type: 'string', maxLength: OBJECT_TITLE_MAX, description: OBJECT_TITLE_DESCRIPTION }, caption: { type: 'string', maxLength: OBJECT_CAPTION_MAX, description: OBJECT_CAPTION_DESCRIPTION }
      }, required: ['revision', 'path']
    }
  },
  {
    name: 'canvas_reserve',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    execution: { resource: 'canvas', exclusive: false },
    outputSchema: { type: 'object', properties: { slots: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['id', 'x', 'y', 'width', 'height'], additionalProperties: false } } }, required: ['slots'], additionalProperties: false },
    description: `Show the user where slow work will land before it is ready. Each reserved place glows on the canvas until an edit fills it through slot (canvas_place for media, canvas_edit for pages, shapes and frames), release ends it, or the turn ends. Brush strokes, lines and text cannot fill a place: draw them at its coordinates, then release it. It is not part of the document: no revision, history or export. Size each place to the result's proportions; places without x and y line up in a row centred in the execution viewport. Returns every place this execution holds.`,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        places: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', additionalProperties: false, properties: {
          width: { type: 'number', exclusiveMinimum: 0, maximum: CANVAS_SLOT_SIDE }, height: { type: 'number', exclusiveMinimum: 0, maximum: CANVAS_SLOT_SIDE },
          x: { type: 'number', description: 'Left position; supply together with y.' }, y: { type: 'number' }
        }, required: ['width', 'height'] } },
        release: { type: 'array', minItems: 1, maxItems: 24, items: { type: 'string' }, description: 'Places to end without filling, such as when their work failed.' }
      }
    }
  },
  {
    name: 'canvas_extract',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    execution: { resource: 'canvas', exclusive: false },
    outputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute machine path for subsequent Galta tool calls. Prefer artifactUri for a user-facing link; a plain path is never made clickable.' }, artifactUri: { type: 'string', pattern: '^galta-workspace:' }, kind: { enum: ['image', 'video', 'html'] }, mimeType: { type: 'string' }, source: { enum: ['submitted', 'element'] }, width: { type: 'number' }, height: { type: 'number' }, elementId: { type: 'string' }, file: fileOutput, revision: { type: 'string' }, coverage: coverageOutput, next: { type: ['object', 'null'] }, elements: { type: 'array', items: elementOutput } }, additionalProperties: true },
    description: 'Extract reusable source files without changing the canvas. Images, videos and embedded HTML return immutable paths; ordinary geometry and text retain metadata without a file. Use scope selection to get a page of target metadata and files together; ids chooses known canvas elements. No preceding status call is needed for these scopes. Pass next back to this tool with its continuation revision until null. Paged results include coverage and a checked revision for subsequent edits. Missing submitted targets remain missing even when captured bytes survive. Identical bytes reuse a content-addressed file; never modify files in sources. By default submitted targets use original bytes; source current reads the current live source. Single element calls return only that source. Use canvas_capture to inspect composition.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        element: { type: 'string', description: 'Extractable element id from canvas_inspect: image, video or embedded HTML.' },
        scope: { type: 'string', enum: ['selection'], description: 'Prepare a page of frozen targets in submitted order. Mutually exclusive with ids and element.' },
        ids: { ...CANVAS_IDS_SCHEMA, description: `${CANVAS_IDS_SCHEMA.description} Mutually exclusive with scope and element.` },
        ...CANVAS_PAGE_SCHEMA,
        source: { type: 'string', enum: ['submitted', 'current'], description: 'Usually omit: selected-at-submission elements use their captured original; other known element IDs use their current canvas source. submitted explicitly requires an original captured from the submitted selection; it cannot read other elements. current requires a live element and reads its current bytes.' }
      }
    }
  },
  {
    name: 'canvas_deliver',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    execution: { resource: 'canvas', exclusive: true },
    outputSchema: deliveryOutput,
    description: 'Make a user-facing copy of exact source bytes in the current execution workspace. Use source as the artifactUri returned by canvas_extract (or an existing absolute path inside this workspace for a generated file) and destination as a workspace-relative filename such as selected-image.png or outputs/selected-image.png. The host binds the execution and project; it rejects traversal, symlinks, outside paths and conflicting existing bytes. This is the delivery declaration: do not copy long host paths with a shell and do not make a final link from memory. The result contains the canonical artifactUri and exact byte hash; the runtime preserves the delivery for the final conversation even if prose omits the link.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        source: { type: 'string', description: 'Exact galta-workspace URI from canvas_extract, or an absolute path already inside this execution workspace.' },
        destination: { type: 'string', description: 'Workspace-relative destination filename or path. Parent directories are created inside the workspace; `..`, absolute paths and symlinks are rejected.' }
      }, required: ['source', 'destination']
    }
  }
] as const satisfies readonly ToolDefinition[]

export const CANVAS_TOOL_NAMES: ReadonlyArray<string> = CANVAS_TOOLS.map(tool => tool.name)

/** The declared surface as a type. A surface that renders per-verb copy keys a
 * total record on this, so adding a tool above fails to compile until every
 * such surface has words for it. */
export type CanvasToolName = typeof CANVAS_TOOLS[number]['name']
