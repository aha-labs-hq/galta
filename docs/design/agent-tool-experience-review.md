# Galta tool experience review — 2026-09-23

Scope: all Galta MCP tools, including browser and connection management.
This is an interface review from the perspective of a Codex caller. It combines
source inspection, the captured official host declarations and targeted checks;
it is not a real-model task-success benchmark. Existing canvas verification is
recorded separately under `docs/evidence/agent-canvas-contract-2026-09-23`.

The core canvas workflow is familiar: find objects, read relevant fields, inspect
pixels, apply an atomic change, inspect the saved receipt. Stable identities,
literal search, reusable pagination arguments, revisions and honest incomplete
views make that workflow predictable. These choices should remain.

The whole interface still requires the caller to translate identities, remember
conditional arguments, manage execution plumbing and decode return envelopes.
These are concrete costs even when an experienced caller can work around them.

The review also applies the necessity/sufficiency and naming criteria in
`agent-canvas-contract.md`. Existing tools and names are candidates, not fixed
constraints. Decide the desired interface first, then account for migration.

| Tool | Assessment | Remaining cost or boundary |
| --- | --- | --- |
| `canvas_inspect` | A necessary structured observation capability. | Listing, searching and targeted reads remain one coherent projection API; use `canvas_capture` when pixels are the evidence. |
| `canvas_capture` | A useful visual check with explicit coverage. | Default scope follows selection whereas `canvas_inspect` reads the canvas. Related expansion differs from exact reads. HTML has no rendered preview through this tool. |
| `canvas_report` | A necessary evidence-boundary capability for material visual claims. | It requires the current revision, verifies medium, target identity and counted coverage, and returns the exact records used; `semantic: "unverified"` makes clear that it cannot certify that a model interpreted pixels correctly. |
| `canvas_edit` | A necessary mutation capability: ordered, atomic, revision checked, with a saved receipt. | There is no native duplication operation; reconstruction should not be represented as lossless copying. |
| `canvas_place` | A convenience entry point with no independent mutation capability. | Candidate for consolidation into edit. Retain separately only if representative media tasks demonstrate enough reduction in construction or mistakes to justify another choice, argument vocabulary and receipt shape. |
| `canvas_extract` | Necessary for giving file-based tools access to canvas source inputs. | It materializes image, video and embedded HTML sources; ordinary geometry and text remain metadata-only. Four selectors, source semantics and single/paged reply shapes still require care. |
| `browser_inspect` | A bounded source-page observation. | Viewport filtering and truncation are disclosed, but there is no targeted query or continuation for the omitted portion. Repeating a read cannot establish complete coverage of a dense unchanged viewport. |
| `browser_capture` | Pixel verification for the bound active tab. | Requires focus on that tab; it is not a general browser or embedded HTML preview. These boundaries must remain honest. |
| `browser_act` | Understandable actions with stale-snapshot checks and a generated action union. | Numeric bounds disappear in host conversion, so descriptions and runtime checks remain necessary. The repaired contract is covered by the real host fixture. |
| `canvas_list` | Appropriate discovery for an external client. | Embedded callers already have an execution and must ignore this entry point. |
| `canvas_connect` | Appropriate explicit external binding. | Embedded and external callers receive the same surface but follow different protocols. |
| `canvas_disconnect` | Explicitly releases external ownership. | Embedded execution ownership belongs to the UI; callers must remember not to release it. |

## Boundary and naming decisions

Structured reads and pixel views remain separate: they supply different evidence
and have different costs. Editing and exporting also remain separate: one commits
the document, while the other materializes source files. Browser actions cannot
share the canvas atomic-edit promise because a webpage interaction may produce
external effects. Tool count alone is not a reason to collapse these boundaries.

External discovery and connection are necessary in an unbound client. That does
not establish their necessity on an already-bound embedded agent's tool surface.
The host must own any simplification of that entry path while retaining isolation.

The implemented names are `canvas_inspect`, `canvas_capture`, `canvas_report`, `canvas_edit`,
`canvas_extract`, `browser_inspect` and `browser_capture`. Canvas mutation verbs
use `create_element`/`update_element`, `elementType` and `elementId`; creation
can still supply a new `id`. Browser calls use `snapshotId` and scroll
`deltaX`/`deltaY`. Webpage `ref` stays distinct because its lifetime belongs to
one observation.

The earlier suggestions `elementIds` and detail `full` are not implemented.
Reads still accept `ids` and detail `summary`/`elements`; capture/extract retain
`element`, and placement retains `replace`. These differences remain candidates
for task-based review, not completed migrations. Keep `revision`, `query`,
`limit`, `next` and `groupId`: their roles are already clear. Review effect,
resource, units and lifetime rather than making every name look identical.

## Repaired browser contract

The former `browser_act` contract accepted click without a ref, fill without
text and navigate without a URL, while the host reduced the visible input to
`action` and `snapshotId`. The action union now derives its JSON Schema and
runtime parser from one Zod 4 definition. The direct host capture preserves the
five action branches and their required fields; Code Mode preserves the same
union, with scroll bounds retained in descriptions because the host removes
numeric limits during conversion. Runtime validation remains authoritative for
those limits and for URL policy.

The double check found that shared validation previously covered only actions
in the embedded adapter, and the worker did not invoke it. All three browser
tools now validate at the native MCP, embedded adapter and worker boundaries.
The content script retains live DOM checks; shared argument constraints belong
to the schema. Capture's schema also now requires `snapshotId` whenever a `ref`
is supplied, and runtime errors identify the relevant missing field.

The contract tests cover valid and invalid calls, and the real app-server
fixture captures ordinary declarations and compiles positive and negative calls
against the delivered Code Mode action/capture types. The production extension
test sends malformed calls directly to the real worker port and verifies that
they do not change input values, click outcomes or scroll position before a
legal interaction sequence succeeds.
Selector combinations in canvas reads/extracts and the remaining convenience
entry points still need the same task-based review before any further schema
abstraction is introduced.

## Return values should support composition

Canvas and browser tools now declare output schemas and return `structuredContent`
alongside readable text and image blocks. The schemas describe the stable
receipt, coverage, source-file and capture fields while allowing the detailed
element projection to evolve. The real Codex fixture confirms that Code Mode
preserves typed `Promise<CallToolResult<...>>` results for all seven canvas tools;
the ordinary model-facing namespace may omit output schemas, so the text path
remains necessary for clients that do not consume structured content.

Paged reads and extraction retain explicit `next` continuation arguments. A
single source result includes `file` metadata; a page returns records with the
same field rather than changing the field name for image, video or HTML. The
source and runtime tests verify this composition at the browser, MCP and host
boundaries.

Errors should distinguish invalid arguments, stale observations, missing targets,
unavailable capabilities and unknown write outcomes with stable machine-readable
codes plus concise messages. A transport failure must never claim that no edit
was applied without evidence. Keep mutation retries under explicit caller control.

## Remove plumbing without weakening ownership

The embedded caller copies executionId into every request while external callers
use list/connect/disconnect. That is routing state, not creative work. An
execution-scoped host binding could own it and advertise the relevant entry points.
This requires isolation in the trusted transport; removing executionId from a
shared MCP server or guessing the active canvas would violate the current contract.

The same canvas object is still addressed as returned `id`, mutation
`elementId`, read/capture/extract `ids`, capture/extract `element` and placement
`replace`. Browser `snapshotId` identifies an observation rather than an object.
Adding aliases would create more ways to express the same operation without
completing the migration.

## Capability gaps need task evidence

Native duplication, targeted reading of a dense webpage and rendered inspection
of embedded HTML are concrete candidates for future work. Validate them with
tasks such as copying a grouped card with bindings, finding a control omitted
from a truncated read, or checking the actual embedded result. Do not promise
lossless copying, full-page access or visual verification using the present tools.

Keep canvas objects as the authoritative document. Files remain the natural
interface for media and HTML artifacts. A synchronized filesystem mirror would
add a second state model without resolving the current declaration/response gaps.

## Acceptance criteria

Evaluate complete tasks from a fresh session using only the delivered tools and
context. Include title editing, grouped movement, source-image replacement, a
browser fill/click sequence, a revision conflict and a lost mutation response.
For proposed capabilities, include the concrete gap tasks above. The current
contract work is implemented and verified; future changes still require the
same task evidence.

Measure avoidable rejected calls, unnecessary full rereads, reconstruction of
known arguments, recovery correctness and verified saved results. A minimal call
count must not reward skipping pixel inspection or required state checks.

First settle tool boundaries and the intended vocabulary; then implement them
with browser/selector contract precision, composable outputs and errors, and
execution plumbing. Verify necessity, sufficiency and naming in task flows as
well as schema tests. Add domain capabilities when those tasks demonstrate their
value. This review does not implement these additional changes.

Current follow-up evidence:
double-check report.
The parent `audit.json` and declarations describe the earlier pass; the
double-check directory contains the final host receipt and declarations after
the Canvas Zod, structured-output and source-extraction changes. Character
counts in earlier evidence describe source size only; they are not token
measurements or evidence of a latency or success-rate effect.
