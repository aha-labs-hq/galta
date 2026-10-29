# Canvas as an agent's working environment

The agent should be able to find a target, inspect it, make a precise change,
and establish what was saved with the same confidence it has when working with
files. Galta owns that experience across discovery, host schema conversion,
execution, errors and receipts. A correct server implementation alone does not
establish that the agent received a usable interface.

## Tool necessity, sufficiency and naming

Start each tool decision from the task, the information or effect required, and
the evidence that establishes success. Distinguish a necessary capability from
a necessary standalone tool: a capability can belong to an existing operation,
and execution plumbing can belong to the host. For each proposed entry point,
explain what the caller loses if it is removed, whether existing tools compose
to achieve the same outcome, and why a separate choice is worth its cost.
A convenience tool can earn its place through demonstrated reductions in call
construction or mistakes; theoretical replaceability alone does not settle the
decision. Neither an existing implementation nor a smaller tool count is proof
of a good boundary.

A retained tool must be sufficient for its stated purpose: legal arguments are
discoverable, the result establishes what happened, partial coverage is explicit,
and errors support the next decision. Verify the advertised workflow across
discovery, execution and recovery. Do not broaden its promise to cover work that
still requires guessing, reconstructing hidden state or substituting a medium.

Evaluate tool and parameter names from the caller's perspective. Prefer familiar
verbs that predict the effect, a consistent noun for the same resource, and
parameter names that distinguish identifiers, values, coordinates and deltas.
Keep semantically different handles distinct, such as stable canvas element IDs
and snapshot-scoped webpage refs. A short name is useful only if it retains the
meaning needed to choose and compose calls correctly.

Judge the intended interface before deciding migration mechanics. Existing names
are not exempt from review, and compatibility cost is not evidence that a name is
clear. Apply renames coherently across schemas, runtime checks, receipts, host
declarations, examples and tests; avoid accumulating synonyms. Use representative
tasks to check selection of the tool and construction of the first call, as well
as final success. Keep design recommendations distinct from implemented changes.

## Familiar operations, native canvas semantics

| Familiar file operation | Canvas equivalent | Meaning |
| --- | --- | --- |
| `ls` | `canvas_inspect` | A page of object summaries and the document revision. |
| `grep` / `find` | `canvas_inspect` with `query`, `kind`, `groupId` | Literal text/name search, kind filtering, or native group membership. Filters combine with AND. |
| Read a specific file | `canvas_inspect` with `ids`, `detail: "elements"` | Exact fields for known objects; no need to reread the whole document. |
| Inspect rendered output | `canvas_capture` | Actual composition pixels with coverage and rendering limitations. |
| Record the basis of a conclusion | `canvas_report` | A bounded claim ledger tying each material claim to exact evidence IDs and certainty. |
| Apply a patch | `canvas_edit` | An ordered, atomic, persisted batch with a required observed revision. |
| Inspect a patch result | Successful mutation receipt | Changed object IDs and summaries, deleted IDs, revision and saved artifact paths. |
| Use source files with another tool | `canvas_extract`, then `canvas_edit` / `canvas_place` | Immutable image, video or embedded HTML source files and explicit placement of generated outputs. |

An element ID is a stable address, not a mutable name or coordinate. A read's
`id` becomes a write's `elementId`; only creation accepts an optional new `id`.
Native `groupIds` express membership and nesting. They are not a second directory
tree. Selection records what was selected when the request was submitted.
Its role follows from the user's words and conversation, and it can be imprecise:
unselected objects that the words or visual context point to remain relevant.
Selection never grants permission to edit an object.

There is no filesystem mirror or second document owner. Such a mirror would
introduce synchronization, file-to-object mapping and partial-write semantics
without resolving the demonstrated tool-contract failures. Canvas element
identities remain stable across edits; tool vocabulary is reviewed separately.

## User messages and canvas observations

A submitted message carries the original words, a structured canvas observation,
then one viewport image when rendering succeeds. That image is the only pixel
input; when the latest observed turn in the same thread saw the same commit and
viewport and no compaction has happened since, the preview is `unchanged` and
names that earlier image instead of resending it. The application reports facts; the agent interprets intent.
An empty selection does not make a drawing irrelevant. Several selected objects
can be a comparison, inspiration or the subject of a question. There is no input
intent enum, recency timeout, default edit-target policy or filename-based target
resolution. A selected native stroke needs no source file to be meaningful.

The observation identifies its saved commit and document revision, the submitted
viewport, selected IDs, visible object geometry, and net changes since the last
observation submitted to a real turn in this conversation. History supplies
`user`, `agent` and `import` provenance. Reverted edits and engine version counters
are not content changes. A first observation is `initial`; a baseline outside the
current ancestry is `unrelated-history`. Neither claims to know what recently
changed. A stopped preparation without a turn ID cannot advance the baseline.
Existing snapshots and conversation receipts own this state; there is no second
event journal or heuristic intent store.

The Zod schema and message budgets belong to `packages/canvas/src/message.ts`.
Each sample contains at most 12 records; the complete observation text is at most
12,000 characters, with exact totals and explicit truncation. Full records remain
available through `canvas_inspect` scopes `selection`, `viewport` and `changes`.
Evidence entries in the message are summaries without element ID lists; the
tool's ledger keeps the full records, which `canvas_report` returns.
The viewport scope reads current objects intersecting the submitted world bounds.
Visible records contain `id`, `kind` and `bounds`. The `bounds` schema lives in
`packages/canvas/src/bounds.ts`; `observation.elementBounds` delegates calculation
to the editor's `getCommonBounds`. The same projection serves viewport filtering,
inspection, submission and mutation receipts. It includes native offsets and
rotation; it describes geometric extent, not painted contours, clipping or actual
visibility. Brush smoothing can change the rendered outline.

Inspection retains top-level `x`, `y`, `width`, `height` and `rotation` as native
editable fields. For paths, `x/y` can be the first point, not the top-left corner.
Use `bounds` for spatial relations, and native fields for edits. Submitted visible
records omit the native fields so a partial path record cannot masquerade as a
world box. Existing conversation messages and artwork are not rewritten.
The changes scope retains submitted change identities and sources, including
deleted IDs, while exposing current object fields and the current read revision.
External executions without a conversation baseline reject the changes scope
explicitly. They retain ordinary canvas, selection and viewport reads.

The preview reuses `canvas_capture` with its low-detail limit: 1400 pixels on
the longer axis and a 600,000-byte JPEG limit. High-detail captures use 2800
pixels on the longer axis. The renderer computes scale from its final export
dimensions, including native padding and frame labels. World units are not
pixels: zooming into a small world region must not reduce observation quality.
Rendering happens from the native document at the chosen density; resizing a
previously undersampled bitmap cannot restore detail. The submitted viewport
and its empty margins are preserved. Every turn gets a fresh structured
observation. Pixels are reused only under the same-thread, same-commit,
same-viewport and no-compaction conditions above, including after resuming a
conversation. Otherwise a nonempty viewport receives fresh pixels. An empty
viewport has no image; a rendering failure
records `unavailable` and its reason. Unsupported embedded content is counted,
never described as rendered. Stop propagates instead of sending a partial request.
Selection, viewport and pixels remain tied to submission even if the visible
editor changes while preparation waits. Later writes still require a current
revision. Canvas content is data, never application instructions.

Every structure read and pixel capture returns an evidence record with an ID,
revision, scope, covered element IDs, total and covered identity counts,
completeness and capabilities. Pixel records additionally carry the JPEG
SHA-256, focus (`canvas`, `selection`, `related`, `exact` or `region`) and
detail level. `canvas_report` is an optional provenance audit, not a prerequisite
for an ordinary visual answer. It accepts a bounded list of claims and requires
the current revision. It returns an evidence-only assessment and the exact records
used by those claims. It rejects unknown IDs, mixed or stale revisions,
incomplete pages, deleted targets, geometry used to support an appearance
claim, and individual appearance claims based on a composite view. An
`evidence-sufficient` result carries `semantic: "unverified"`: it means only
that the declared medium and revision are eligible, never that the model's
wording is true. The agent remains responsible for interpreting pixels,
declaring uncertainty and recapturing a smaller exact target when the scene is
ambiguous. This gives failures a stable causal boundary without introducing a
shape classifier or a second canvas state.

Visual accuracy is verified separately from this evidence contract. The paired
perception runner (`scripts/verify-canvas-perception.ts`) freezes images and
questions before inference, keeps the answer key outside the model's context,
and scores exact factual answers without a model judge or answer retries.
New seeds and varied geometry provide held-out probes. Its results apply to
those fixtures and model conditions, not every future canvas. See the
pixel-density investigation
for the controlled comparison and rejected framing experiment.

### Failure attribution

There are two coordinate systems in an Excalidraw path: native `x/y` are
editable origins (often the first point), while `bounds` are the world-space
extent used by the renderer. They are both valid facts with different owners.
The model-facing observation uses `bounds` for position and reserves native
fields for edits. A diagnostic that freezes the same pixels and swaps only
these two representations is part of the visual regression protocol
(`bun scripts/diagnose-canvas-vision.ts prepare|run`, followed by its blinded
review). A paired difference is evidence of an application-context defect;
random or unresolved model wording remains a semantic failure and is retained
as such. The protocol never turns a finite holdout into a population success
claim.

## Discovery and reads

The short MCP instructions carry binding and the habits every agent needs; tool
descriptions and schemas carry document semantics and operation details. Code Mode hosts may prepend the shared instructions to each
discovered tool, so duplicating detailed workflows there increases every lookup.
The Codex adapter identifies the `mcp__galta__` namespace and asks for names first,
then only relevant declarations. It does not add a second tool catalog or infer
which tool a user's task requires.

`query` performs case-insensitive literal substring matching against full authored
text (`originalText`) and native names, including content beyond a summary's text
excerpt. Automatic wrapping changes the rendered `text`, not the searchable source;
explicit authored line breaks remain literal. It does not interpret regular
expressions or infer visual similarity. `kind` uses the
same vocabulary returned by reads (`geo` includes native geometric shapes;
`draw` means brush work). `groupId` matches any native group membership,
including nested members. Search is scoped to the canvas. It cannot silently
filter out frozen selection IDs, including missing objects.

### Marks and grid

Two failures on 2026-10-27 came from pixels the agent could not tie to the
document. Sorting five overlapping references, an agent assigned element IDs to
the wrong pictures from bounds alone and filed a photo of a cat in a suit as
abstract art. Asked to trace that photo with the brush, it drew from imagined
coordinates that matched the reference in neither proportion nor detail.

`canvas_capture` therefore takes two annotations, drawn over the view and never
into the document (`apps/extension/src/canvas/captureMarks.ts` and
`toolScene.ts`):

- `marks` numbers each object a person would point at: an outermost native
  group, or an ungrouped element, with text bound to a container counted as part
  of it. Each number sits at its object's top-left inside a dashed outline that
  also shows the extent of a covered object. Numbers follow reading order. The
  result's `marks` maps each number to its element IDs, outermost group and
  bounds; a view with more than 40 objects numbers the largest and reports
  `unmarkedObjectCount`.
- `grid` draws world-coordinate lines about ten to the longer side, on round
  values, labelled along the top and left edges. Lines invert what lies beneath
  them, so they read on paper, ink and saturated fills alike. Positions read off
  the picture are usable as `x`, `y` and `points` directly.

Both use an explicit export frame, so world-to-pixel mapping is exact; a view
without annotations renders as before. Neither can be combined with `file`,
which saves the canvas as drawn for generation. The message preview always
carries marks, and its visible records carry the same `mark`, computed by
`CanvasTool.marks` whether pixels are attached now or were attached earlier.

Judging visual work belongs to the agent and is stated in every live channel
(`CANVAS_LOOKING_INSTRUCTIONS`): capture the result before calling it done,
compare it with the request and any reference, and, when work must follow
something visible, capture that reference at high detail with the grid first.
Pixels do not show structure: in two of five diagram runs an agent that had
looked at its work left arrows drawn between boxes but unbound, so the rule
also asks it to confirm bindings and groups from the receipt or a read.
A brush stroke draws a pen about 4.25 × `strokeWidth` wide (Excalidraw's
`freeDrawPath.js`), while shapes and lines draw `strokeWidth` itself; the
`strokeWidth` and `points` descriptions say so, because an agent that assumed
pixels drew brush lines four times too heavy.

Search results preserve document order. `elementCount` is the canvas total;
`coverage.total` is the matching result count. No matches return an empty page,
not an error or substitute target. Existing native names appear in summaries.

`canvas_capture` reuses the same names with view-scoped meaning, and the two
limits it reports are deliberately distinct:

| Field | Meaning |
| --- | --- |
| `elementCount` | Elements this view rendered. A canvas-scope view renders the whole composition. |
| `elementIds` | The identities the record retains, capped by `CANVAS_PAGE_MAX`. |
| `evidence.totalElementCount` | Elements the view covered. |
| `evidence.coveredElementCount` | Identities the record retains. |
| `evidence.complete` | False when any content or identity was withheld, including the identity cap. |

Rendering coverage and identity retention are separate limits, and there is no
omission count. A 131-element canvas-scope capture renders all 131, names 64, and
reports `totalElementCount: 131, coveredElementCount: 64, complete: false` with a
limitation naming the cap. Reporting the identity cap as omission told the agent
that visible elements were missing; reporting it as coverage claimed more named
identities than the record carries. Both misstated the pixels, so neither field
exists.

Page defaults, maximum and text budget belong to `packages/canvas/src/reads.ts`.
Each status or paged export returns `next`: either the complete continuation
arguments for the same tool, or `null`. It preserves the filter, ordering,
detail, source choice, page size and revision. The caller retains the execution
binding supplied by its host. `coverage.nextOffset` remains available to clients
that explicitly construct requests. There is no mutable cursor registry.

A changed revision rejects continuation. A large canvas does not require a
larger `limit`; the default is 32 and the maximum is 64. Oversized limits fail
with a concrete continuation instruction, rather than being silently clamped.
Pagination never splits a record. A single detailed object can still exceed a
host's output budget; this change does not claim a universal token cap.

## Writes and recovery

Zod 4 operation schemas own each operation's fields and required keys. Runtime
parsing, generated per-verb JSON definitions and inferred operation types use
those schemas. The MCP wire schema is a deliberately shallow draft-07
projection: the current Code Mode converter erases deeply nested unions, so the
projection factors native properties only across verbs that accept `props` and
closes each branch with `propertyNames`. This is a transport representation,
not a second validation policy. Creation dependencies distinguish positioned
native objects, brush points, HTML artifacts and optionally centered media; the
runtime parser and domain checks remain authoritative for cross-field path and
dimension semantics.
Nullable enum conversion must preserve `null` in both the type and enum; otherwise
discovery can advertise a detachable arrowhead that validation rejects. Contract
tests compare Zod runtime validation, generated property schemas and MCP discovery.

The MCP adapter runs the shared domain checks before generic schema validation.
An invalid operation produces one explanation for the requested verb, rather
than errors for every unrelated union alternative. Browser execution applies
the same checks and retains the original batch index during cooperative work.

All three browser tools use Zod 4 definitions to generate their MCP draft-07
input schemas and validate calls. The native MCP adapter, embedded SourceBrowser
and extension worker invoke the same parser before page access. Scroll's
`deltaX`/`deltaY` alternatives preserve the "at least one delta" rule in JSON
Schema. Capture has separate viewport and referenced-target variants; a target
requires both `ref` and `snapshotId`. Runtime parsing selects the relevant
variant so errors name the missing field without unrelated union failures.

The shared parser owns argument constraints and navigation URL policy, including
protocol, credentials and URL validity. The worker owns live tab/document checks;
the content script owns snapshot freshness and live DOM/control semantics. The
content script uses the inferred action type without bundling the schema runtime
or repeating its field limits. Canvas operation parsing now uses the same Zod 4
dependency at the trusted MCP/editor boundary; browser and Canvas contracts
share the schema approach while each keeps its own domain parser.

For example, `{type:"move",id:"card",x:100,y:200}` is rejected with the
operation index, missing `elementId`, and the instruction to copy an observed ID
into that field. It is never rewritten automatically. A syntactically valid ID
that no longer exists produces a distinct, indexed missing-object error. Neither
case changes earlier objects in the failed batch.

An argument-validation failure at the MCP boundary can state that no edit was
applied. A transport failure cannot make that claim: the agent must observe
current state before deciding what remains. Revision conflicts require a fresh
read of the affected targets. Errors do not trigger automatic mutation retries,
target substitution, revision adoption or fallback rendering.

## Verify what the agent receives

The official host may transform JSON Schema before sending it to a model.
`scripts/verify-canvas-contract.ts` starts an isolated real Codex app-server and
the source MCP server, captures requests at a deterministic local model
endpoint, and checks both ordinary tools and Code Mode declarations. It also
compiles valid and deliberately invalid inline calls against the exact delivered
TypeScript declarations for canvas edits, browser actions and browser captures,
checking more than the presence of field names.

In Codex 0.155.0-alpha.9.2, the capture showed numeric bounds being removed from
the ordinary model-facing schema. Code Mode renders the limit as `number`.
Bounds therefore appear in descriptions as well as machine validation, derived
from the same constants. An initially attempted union that repeated the full
property vocabulary was simplified to unknown branches. Factoring that
vocabulary preserves concrete operation types and required target IDs. Giving
every verb shared `props`, or intersecting typed properties with a bare object,
also produced misleading Code Mode types: illegal fields and misspelled properties
were accepted. Restricting that intersection to the appropriate verbs and omitting
the bare object keeps these inline errors visible in TypeScript. These are observed
host behaviors, not claimed explanations of its internal algorithm. Numeric bounds
and cross-field conditions still require runtime validation.

This fixture uses fallback metadata for a local `fixture` model. It proves host
delivery, not real-model compliance or a measured improvement in task success.
It also verifies that every Canvas tool has a source output schema and that
Code Mode retains typed `CallToolResult<...>` output payloads. The ordinary
namespace can omit output schema metadata during host conversion, so readable
text and image blocks remain part of the compatibility contract.

`scripts/verify-input-context.ts` captures the actual per-turn observation and
image order through new, resumed and forked app-server conversations.
`scripts/verify-canvas-intent.ts` is opt-in real-model verification with synthetic
unselected drawings, a selected-image download beside an unrelated old output,
and a multi-selection comparison. It verifies document preservation and exact
source bytes and the file linked in the final reply, and records natural-language
replies for semantic review.
These isolated scenarios do not establish a population-level success rate.
The browser tests establish native search, identity, edits, receipts, pagination
and atomic failures; the MCP acceptance script covers native messaging and
IndexedDB persistence. These tests do not require a user's live canvas.

Future interface changes should be evaluated at those same boundaries. Add
capabilities when a task demonstrates the missing operation; do not add aliases,
more reminders or a parallel state representation to compensate for a broken
contract.
