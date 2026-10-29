# Galta implementation architecture

This document describes the implementation. The blueprint describes acceptance
targets; verification.md records evidence and remaining gaps.

## Ownership

Galta uses Bun, TypeScript, React 19, Vite 7, Excalidraw 0.18.1, Tailwind CSS 4, shadcn/ui and a Chromium MV3 extension.
There is no hosted workspace service or Pinterest API.

```text
Website content script
  native DataTransfer → CanvasApp → referenceDrop → imageImport → Excalidraw
                           │
                           └→ snapshot + commit graph + provenance → IndexedDB
                           │
                           └→ CanvasDocument ← native canvas bridge ← Galta MCP
                                                        ← embedded / external agents
```

The agent surface is eight verbs: `canvas_inspect` (read the document),
`canvas_capture` (see pixels), `canvas_report` (record evidence for a claim), `canvas_edit` (change the document),
`canvas_place` (single-media convenience), `canvas_reserve` (hold a place for
work in progress), `canvas_extract` (prepare sources), and `canvas_deliver`
(make an explicit user-facing copy).
One verb per tool keeps every schema readable on its own and lets the model
choose by intent instead of by reading one large action enum.
`@galta/canvas` owns that provider-independent contract. The canvas bridge owns
document execution leases; the MCP adapter adds discovery, connection and
release. Codex app-server remains an independent embedded runtime. See the
[agent architecture](agent-architecture.md) for topology, ownership and setup.

The side panel and canvas page mount the same CanvasApp directly. Neither
embeds the other in an iframe. The source remains a normal browser page.
Browser chrome owns side-panel open/close and width. The top-right view action
means **Expand canvas** in the panel and **Back to page** in a workbench. A
workbench returns beside the page it was expanded from; one opened on its own,
such as by Galta for Mac, returns beside the page last used in its window, and
names it in the hint. With no other page in the window, or in a browser without
extension side panels, there is no return action, and no canvas has an
application fullscreen toggle. Browser fullscreen remains a
browser command.

`canvasViewNavigation` owns native view delivery, independently of project
navigation. It saves the scene and draft before handing over selected IDs and
the viewport center and shorter-edge world span of the clear editing area.
The receiving editor adapts that span to its dimensions. A receipt is sent only
after scene and draft hydration; the source panel stays open until that receipt.
Timeouts and Chrome errors preserve the source. A handoff timeout is an
ancillary navigation status, not a canvas error: the current view remains
usable and the action can be attempted again without asking the user to recover
work. Root resizing preserves the clear area's center and span; ordinary
composer edits update the measured frame without moving the artwork.

Returning opens Galta alongside the original page and closes the temporary full
canvas tab after the source panel acknowledges hydration. A window/project
address in `chrome.storage.session` lets the next expansion reuse an existing
document when one is still open. The target validates and saves its own state
before loading the latest scene and draft. A stale address is checked against the tab's
extension origin, project, and view identity; it cannot navigate an unrelated
tab. Closed source pages are reported, never replaced with invented blank tabs.
The browsing workbench uses the manifest's global side-panel entry for the
whole browser window. It never creates a tab-specific copy of the same panel,
and keeps the manifest URL unchanged when loading or switching projects. The
window's selected project belongs to session storage; only full canvas tabs
write project identities into their URLs. Changing or closing source tabs must
preserve the panel document. Both directions use a one-time session mailbox:
the full presentation envelope is stored before creating or waking the target,
addressed by project/view identity for a canvas tab and window identity for a
panel. Receivers subscribe to session changes and read the mailbox after their
scene and draft are ready, so an absent or remounting receiver cannot lose the
request. `BroadcastChannel` only accelerates delivery; it is not the state
authority. Receipts are also stored by token, so a lost channel message cannot
turn successful hydration into a timeout. Duplicate tokens share the in-flight
hydration and acknowledge completed work without loading it again. The sender
cleans up its request and receipt after success or failure; a 12-second expiry
prevents a late receiver from applying an abandoned request. Full canvas tabs
remain independent and disable the window panel only after hydration is
acknowledged.

Conversation and canvas names are metadata projections. Local workspace state
is authoritative for creative work; publishing names to Codex is best effort
and never gates a turn or canvas edit. A transient publication or automatic
naming failure receives one bounded background retry and remains observable in
diagnostic logs, while the creative surface continues without a retry prompt.
Publication, automatic naming and interrupted-attempt recovery each limit Web
Lock acquisition to five seconds. This limit does not abort work that already
holds the lock: RPC publication and ephemeral naming retain their own transport
deadlines. Lock contention follows the same bounded background retry policy,
then waits for a new publication change or connection. Retry timers belong to
the connection lifecycle and are cancelled on disconnect; a new connection
gets a fresh retry allowance. Local names and drafts remain authoritative
through contention and transport failure. Publication, naming and interrupted
recovery have independent retry counters: a failure in one cannot start extra
attempts or model turns in another.
Publication attempt identity contains the local values to publish, independently
of acknowledgement fields. A partial success cannot give a failed later step
extra retry allowance; a new local edit still gets its own attempt. Metadata
diagnostics serialize their context into one console argument so Chromium's
extension error page retains the project/session identifiers and the failed RPC
method and reason, rather than displaying `[object Object]`.
The connection lifetime owns its generation directly. Establishing a connection
does not trigger a second state update that cancels and immediately restarts
pending lock requests. Interrupted recovery fences a failed acquisition by that
generation and its own retry counter, so unrelated renders cannot requeue it.

Embedded generation belongs to one extension offscreen task host, independently
of the visible panel. The host retains tasks by task ID, so several conversations
can run on one canvas while each observer follows its selected session. Switching
projects, handing off views, hiding or closing a panel only detaches its observer.
Reopening subscribes to every retained task, including pending approvals; only an
explicit, task-ID-fenced Stop cancels the chosen task. A running turn exposes a
task-ID-fenced steer command, which is serialized per turn and persisted with the
conversation before its next streamed update. A follow-up reaches the turn only
after the provider reports its turn boundary: the command is advertised through
`canSteer`, and a follow-up submitted before that boundary stays open until it is
delivered or refused. A turn that ends first refuses every follow-up it was still
holding with its reason, so an accepted command never ends in silence; the refusal
travels back to the composer, which keeps the draft, and never marks the request
itself as failed.
External MCP leases still bind to their selected visible canvas, and unfinished
imports still block view handoff. Installed-extension lifecycle acceptance is
covered by `scripts/verify-background-tasks.ts`, separately from preview fixtures.
The visible workspace owns one Codex RPC client across project navigation;
project components subscribe without disposing that shared connection.

The host mounts no editor. `TaskScene` shares native geometry and image export
with `CanvasScene` through the document-only `ToolScene` interface. IndexedDB
owns durable artwork and conversations. Each task tool reads the latest saved
head; a mutation checks that head again inside the storage transaction. Saved
user edits invalidate stale agent revisions; unsaved local edits remain in the
editor and workspace synchronization offers the other version without replacing
them. Background results commit atomically before views display them. Stop after
that commit preserves the result even if its acknowledgement is still pending.
Visible application preserves camera and native undo. The camera moves only
when the reader asks to be shown a change; see Agent presence in
[conversation-reading.md](design/conversation-reading.md). Progress notifications are
coalesced to at most 20 per second; transcript checkpoints occur at thread/turn
boundaries, at most once per second during streaming, and before releasing the
execution fence at termination.

The host uses Chrome's `offscreen` API with the `BLOBS` reason for canvas/media
processing. Its lifetime covers browser sessions, not browser shutdown or
extension reload. A replacement host marks unfinished saved turns as interrupted
failures; it never replays them automatically. Source-page capture/actions retain
their original active-tab requirement. External MCP execution remains view-bound.

The background port owns the offscreen lifetime. A confirmed disconnection
notifies open task observers, which retire all active view projections and ask
for a replacement host when visible. Only that host repairs durable interrupted
records; it never replays a turn. This event is distinct from an empty status
snapshot, so a normal status/start race cannot manufacture a failed task. Session
merges retain a durable terminal receipt when a stale provider snapshot lacks
finalization; conversation hydration cannot erase recovery's completed state.
Recovery also settles locally started records whose provider status is terminal
but whose completedAt receipt is missing; provider completion precedes Galta's
final delivery and persistence boundary.

### Source and import

For import, the content script observes an explicit native dragstart. It adds an
HTTP(S) image URL and source link in application/x-galta-reference while
preserving native types. It does not crawl, mutate every image's draggable
state, create capture menus, attach handlers per image, or persist workspaces.

The page integration owns its extension-context lifetime. After an extension
reload or disable, its next pointer/click/drag interaction checks runtime
identity and stops the old collector and delegated page listeners. A save that
loses its runtime channel aborts the same lifetime, restores its source image,
and reports neither collection success nor an ordinary storage failure. Ordinary
storage failures still retain their failure feedback and diagnostic error.

A browser runs declared content scripts only in pages that load after the
extension does, so a tab already open when Galta installs, updates or reloads
has no script. `messagePage` (`shared/pageScript.ts`) is the one way to message
a page: when a page has no script it adds `content.js` to the top frame once,
with `scripting`, logs it, and delivers the message. Concurrent requests for
one tab share that addition, and the script starts only when no live instance
holds the page. A page Galta may not script, such as the browser's own,
reports the browser's reason; the source-view handoff then keeps no view, and
an agent turn keeps its canvas tools. No page or extension is reloaded.

For agent work it also answers source-page reads and operations in Chrome's
isolated content-script world. `SourceBrowser` binds the source tab when the
request is submitted; the background port retains that identity for the execution.
`browser_inspect` returns visible text, image sources and document-scoped element
refs. `browser_capture` captures the active source tab and optionally crops to a
returned ref. `browser_act` offers click, fill, select, scroll and HTTP(S)
navigation. Actions require a fresh snapshot; replaced documents and changed
targets fail explicitly. Switching tabs never retargets the execution, and
view/actions refuse an inactive or moved source tab. Stop closes the port.
An operation already dispatched may have taken effect and is never retried.

Chrome requires `<all_urls>` for captureVisibleTab without a fresh activeTab
gesture. The worker still restricts source binding and navigation to HTTP(S).
File URLs, browser pages, nested frames, closed shadow roots, native dialogs and
trusted-input-only controls are unsupported. There is no debugger permission,
browser launch, cookie extraction or credential transfer. Password, payment
autocomplete and file controls are excluded from refs. Page text is bounded;
truncation and viewport/frame limits are included in every read.

The canvas bridge routes browser tools through the active document execution.
External MCP clients use their connected canvas. Embedded Codex uses the same
full MCP executable with no mode flags; the MCP adapter binds calls without
requiring the model to copy a bridge or lease ID. A legacy `executionId` is
accepted when supplied, but is stripped before dispatch. The adapter borrows
tool access from the submitted turn's UI-owned lease when trusted execution
context is present, cannot acquire or release it, and stops working when the
execution ends. Calls without that context may borrow only a unique active
lease; ambiguous concurrent UI leases fail explicitly. Every submitted turn
receives source-page context on the untrusted channel. Historical imports remain
provenance and are no longer sent as fresh references; canvas previews are labeled
explicitly so they cannot be mistaken for webpage screenshots.

referenceDrop.ts reads DataTransfer synchronously before the browser revokes
it, preferring the image over its wrapping link. It supports native HTML and
URL payloads. Dropped and chosen image files use the same local import jobs;
Excalidraw still owns its clipboard and native scene-file handlers. Image URL
imports use the HTTP(S) host access declared at extension installation. Imports
and legacy image migration do not request per-site permissions during use.
Chrome can still withhold site access through its own extension settings.

imageImport.ts loads actual dimensions with a bounded 12-second timeout and
awaits image shape creation at the captured canvas coordinate. One successful
placement records one import snapshot. Failure shows an error and creates no
bookmark, text substitute or placeholder commit.

Images are native Excalidraw elements backed by binary Blob assets. The editor
adapter supplies lifetime-scoped Object URLs; stored snapshots reference shared
source records. Portable exports contain each source once. Sources remain metadata; the rendered image
does not depend on its host after import. A failed download is visible and
creates no substitute object.

### Canvas and history

Excalidraw owns editable element records, selection, pointer input and camera. The
domain package owns commits and fork-on-write. The live canvas stores a versioned Excalidraw
snapshot per commit with an empty events array. The pure event reducer has
tests, but semantic event replay is not the live document's source of truth.

DrawingTools exposes the native tools, including the stroke/object eraser.
Box selection uses Excalidraw's `boxSelectionMode`, backported within the pinned
dependency patch. Galta defaults to Overlap and exposes Wrap in the Shapes
palette through the shared drawing choice control. Excalidraw owns the live preference and selection geometry;
the preference stays outside document/history snapshots. See `patches/README.md`
for upstream provenance, version adaptations and the removal condition.
`drawingStyleModel` projects applicable properties from the live selection,
including text bound to selected containers; mixed values remain mixed. Creation
defaults apply when no object is selected. `DrawingStyle` owns only transient
input drafts and commits one action per choice or slider gesture.
The maintained Excalidraw patch exposes `executeAction` on its imperative API;
Galta maps properties to registered native actions through `changeDrawingStyle`.
Font loading, text bounds, container layout, arrow bindings and undo therefore
stay inside the editor. The API also preserves the editor's view-mode guard.
The same small API extension is applied to development, production and types.

`canvasShortcuts` owns Galta's tool-key registry and the engine shortcut policy.
Toolbar hints and accessible shortcut names use that registry. The maintained
patch adds `UIOptions.allowKeyboardShortcut` at the engine's canvas handler and
window-level command/search handlers; returning false skips engine handling
without consuming browser input. This disables the original toolbar's numeric
aliases and UI-only modes that Galta does not expose. Text entry, IME, native
editing, undo/redo and modified zoom shortcuts keep their own behavior. No
document-level event blocker or post-event state correction is needed.

The initial agent invitation is a system-owned native scene composition.
`agentInvitationScene` authors filled shapes, pressure strokes and editable text;
the existing editor owns rendering, erasing, grouping, dragging and undo. `AgentInvitation`
maps native pointer hits to the Settings root and supplies unpainted
keyboard targets derived from the same elements' bounds. No bitmap, SVG display
layer, additional editor or custom brush renderer is used. The invitation keeps
a native Georgia heading, Helvetica labels, the OpenAI outline as a filled native
polygon and Claude's measured pen centerlines. Brush outlines are computed at a
normalized pen size so camera-dependent scene units cannot distort short marks;
live rendering and worker exports share that adapter. The illustration is a
cartoon wireframe of Galta itself: the page being browsed, the canvas beside
it and four numbered notes for the loop (drag anything in, say it or sketch it,
watch it take shape, go back to any moment). A picture travels from the page
onto the canvas; the composer holds a request; three places held for the
agent show a page, a film and a poster, in the drawing palette's blue, the one
colour, as the running agent is in the product; the Time Machine ruler sits at
the top. The character, drawn from the mark's own geometry
(`marks/geometry.ts`) as filled native polygons in the mark's two tones, peeks
over the window and looks at the held places. Narrow layouts drop the page and
use a heavier pen, since they are drawn smaller. The illustration
itself opens setup; only the charcoal dock carries the visible connection
label. A dashed thread in the muted foreground links them.
Small colored marks use the existing drawing palette; controls use the common
interface tokens. Provider marks are compatibility signatures, not action targets. Georgia uses
the same system-font contract as native Helvetica (family 10001, outside the
upstream family range) and is also available in Drawing Style. Its geometry is
measured by the engine; text remains editable rather than converted to outlines.
`CanvasScene.showGuide` registers system identities before applying them with
noncapturing history semantics. Document reads, observations and snapshots
exclude those identities. Copying creates new identities, so copied ink becomes
artwork even though native custom metadata survives the copy. Dismissal removes
system ink without removing existing user history; edits made only to the guide
can be discarded before the first drawing. Retired guide identities are also
filtered on undo. No user file can declare itself system-owned through metadata.

CanvasApp mounts CanvasWorkspace, which owns the project catalog and navigation.
Its keyed CanvasSession is permanently bound to one projectId and coordinates
writes. It hydrates the saved head once before attaching
document listeners. Startup copies and warms native brush caches in cooperative
slices; editing and submission become available only after the complete restore.
The editor draws its static scene from world tiles, never one bitmap per
element ([patch](../patches/README.md#tiled-static-scene)), so a canvas of
thousands of strokes renders in bounded memory. Programmatic zoom shows the
tiles of the previous scale during the gesture, then prepares visible brush
outlines in slices before returning to exact-resolution tiles. Cancellation
and canvas disposal retire pending preparation without editing artwork. Every artwork write runs an updater against the latest workspace
inside one IndexedDB readwrite transaction. The live editor owns a mutable
cursor position; queued user edits advance that position, while navigation and
successful agent application create a new one. A lifecycle save captured before
agent application cannot adopt that later cursor and overwrite the result.
Queued camera-only saves follow the successfully applied version's view owner;
their document parent stays unchanged. Agent saves leave pending user autosave
timers intact, so their failure cannot silently cancel saving user drawing.
Concurrent document edits therefore use domain fork-on-write,
instead of replacing another window's entire workspace. A save
does not rehydrate the editor. An unreadable head fails visibly and remains
preserved instead of being replaced with a blank canvas. Pending edits are
committed before opening Time Machine.

Document snapshots are immutable artwork versions. The public bundle's
`canvasView` holds the latest camera with its commit ID. IndexedDB version 5
retains the separate `canvas-views` store introduced in version 4. Upgrades
atomically preserve existing cameras while normalizing historical records.
Camera-only autosave calls `saveView`, touching only `canvas-views` and the
small catalog head projection, without cloning a scene or reading history.
It shares the session's write queue with artwork saves. The catalog head and
archive state fence stale camera writes in the same transaction. Camera changes
create neither artwork commits nor document revisions and do not broadcast
document changes. A saved camera is restored only for the matching head.
`revision` is a monotonically increasing logical-update sequence, independent
of timestamps and artwork commit IDs.

The storage repository shares identical image file records, HTML documents,
point arrays and pressure arrays between snapshots through `shareWorkspaceAssets`;
each version is shared once, when first written, against the version it came
from. Since version 5, `workspaces` contains the project, conversations and an
immutable snapshot-address manifest; `canvas-snapshots` contains element
metadata and asset references; `canvas-assets` contains the exact shared
payloads. Addresses are opaque storage IDs, not content hashes or another
revision scheme.

Storage format 2 (2026-10-28) stores a version as its change from its parent's
stored version: the elements whose version or content changed, the IDs it
removed, where changed elements now stand when the order moved, and its files
only when they changed. A commit therefore writes what changed, not the whole
canvas. A version is stored complete when a change touches more than half its
elements or would extend a chain of 64. Each record lists its own assets; the
manifest no longer lists every asset. A save writes only new records and
assets, then updates the manifest and catalog atomically. A record stays while
any kept version is built on it, even after its own version is cut; records and
assets nothing kept still uses are collected, with derived previews, in that
same transaction. Reading rebuilds each version over its base, so an unchanged
element is one object across versions in memory as on disk. Format 1 manifests
and complete records stay readable and become bases for new changes; a build
from before format 2 refuses a format 2 manifest rather than misreading it.

Storage version 6 converts old image Data URLs to Blobs atomically. Images and
videos share this binary file boundary; playback state stays out of the document.
See [Canvas media](design/video.md) for rendering and resource ownership.

Different pixels or file metadata remain separate. HTML documents are shared
per element ID and complete content; geometry is shared per element ID and
exact array contents, including signed zero. Restoring clones the mutable editor
document. Captures are read-only: `CanvasScene.snapshot` returns, for every
element whose version is unchanged, the copy history already holds
(`saveCanvasSnapshot`), and a new version reuses its parent's object for every
equal element (`saveCanvasVersion`), so an unchanged canvas compares by
identity. Development builds freeze these copies; clone a capture to edit it. The repository caches only its last workspace's immutable records;
every transaction rereads the authoritative manifest, loads missing records,
and prunes the cache. Aborted transactions never publish their cache. Old
embedded-history databases upgrade atomically; failed writes roll back the
upgrade. Migration backups retain their complete original logical bundle.
Checking for a backup uses a key count, avoiding deserializing it at startup.
The public bundle and portable JSON export format are unchanged; exports still
contain complete assets per version and can be large.

`galta-v1` IndexedDB version 3 introduced `canvas-catalog`, populated from existing
workspace records during upgrade. The project remains the authority for name,
identity and archive state; the catalog projects those fields and owns only visit
order and a disposable, head-checked thumbnail. Workspace and catalog writes are
atomic. Ordinary saves reject archived records; an explicit archive recovery
write may retain another open view's unsaved artwork as history without changing
the archive state or selected head. Agent execution holds a shared Web Lock for
its project through terminal persistence; archiving requires an exclusive lock.

CanvasWorkspace saves the departing editor and draft, validates the target and
then remounts its session. Embedded tasks remain with the offscreen host while
the view detaches; an external connection must end before leaving. Each full
tab carries `?project=...`.
The side panel additionally remembers its project per browsing window in Chrome
session storage, so changing source tabs does not silently change the drop target.
Import validates the history graph, creates a new project ID and removes native
thread, fork and checkpoint authority. Duplicate starts fresh history with copied
artwork and bytes. Neither copies message drafts. See the
[multi-canvas contract](design/multi-canvas.md) and verification.

CanvasWorkspace also serializes portable export with navigation and metadata
changes. Its operation kind is the single busy-state authority; the menu projects
that state in the parent picker, so closing its action submenu cannot hide export
progress. The session commits current artwork before a short-lived worker captures
and encodes an immutable workspace. Embedded tasks keep running, and their later
commits cannot change the captured export. Base64 decoding writes into one
preallocated byte buffer; it must not materialize a JavaScript character list
with `TypedArray.from(string)` for large media. Export scope is visible beside the
action, including the exclusion of unsent drafts. Import failures cross the worker
boundary as typed codes: storage owns format/version recognition, the portable
input boundary owns actionable copy, and the coordinator records operation/project
identifiers without file contents or parser fragments. Creation/storage failures
remain outside input validation and preserve their actual failure category.

`HistoryBrowser.tsx` owns Time Machine and its explicit actions.
`historyTimeline.ts` orders versions and groups them into moments,
`historyLayout.ts` lays out the multiverse, `historyChanges.ts` describes
changes, `historyRecovery.ts` computes what Bring back takes and
`historyTrim.ts` cuts. `HistoryStage.tsx` is a read-only Excalidraw over the
live editor's box; it never restores the live editor.

`canvasPreviews.ts` owns preview scheduling and a bounded decoded cache for
the canvas picker's thumbnail of the current version. Native exports produce
lossless PNGs in `canvas-previews`, keyed by project, commit and appearance and
fenced against the physical immutable snapshot address. Once the current
version's thumbnail request completes, every other version's cached preview
is released (`prunePreviews`), including when the current canvas is empty:
nothing reads those older previews. Canvases that are not opened keep theirs
until the workspace loads; then, at idle, one transaction keeps only each
canvas's current-version previews, read from the catalog (`pruneAllPreviews`). Background requests use idle time and yield
during user gestures. A Worker computes brush SVG outlines with the same pure
function used by Excalidraw; main-thread native rendering keeps owning shape
composition and pixels. The worker's derived-path cache is bounded
separately. Neither path simplifies geometry. Closing or archiving a canvas
cancels its pending background requests. Preview storage is derived data, not
history; the full document remains the authority. The timeline orders versions by creation
time, never placing one before its parent, and includes unapplied agent
candidates. `namedVersions` is metadata on the workspace and travels with
exports; naming creates no artwork commit.

Restore verifies the captured head and live document, persists a fork plus
creative session, then restores its document while retaining the live camera.
The replaced canvas and everything after it stay on the timeline. A failed save
leaves review open. This deliberate switch resets native undo to the new
working document; opening, browsing or closing review never resets it. Bring
back adds what the selected version shows and the current canvas no longer
does, with fresh element IDs and their mutual relationships, at their original
place, as one undoable transaction.
An external head change during review is queued for explicit loading; stale
restores and recoveries are rejected inside the database transaction.

The repository uses IndexedDB with a per-project manifest, separate immutable
snapshots/assets, one camera record, and the lightweight catalog projection. `WorkspaceSync` uses a
BroadcastChannel as an invalidation signal between open panels; the receiving
panel reloads a newer committed head when it has no local run or pending edit,
and shows an explicit load prompt when replacing the current view could discard
local work. The database remains authoritative and the channel never carries
canvas bytes. Loading another view first commits local edits as their own
branch and persists the selected head while retaining both futures. If the
user edits during that asynchronous transition, restoration is rejected and
the live edit remains. Canvas edits flush on hidden, frozen and pagehide lifecycle
signals, but a hard process kill cannot be guaranteed by browser JavaScript.
A panel with an unsaved local edit receives a load prompt and keeps its scene
until the user chooses the newer head.

`SelectionActions` presents the [element capsule](design/README.md): a named
primary operation, Export and an overflow menu. Style reuses `DrawingStyle`;
grouping, ungrouping and deletion invoke registered native editor actions.
`CanvasScene.select` preserves exactly the requested pointer IDs while marking
only fully selected groups in the editor's selection state, including text
owned by a selected container. A partial group never grows to include unrequested
objects; complete nested groups retain their native Ungroup behavior.
Crop mode itself is not an undo step; native handle
gestures are. Replacement captures an element nonce and history-restoration
version before the file chooser opens. It fits the replacement within the old
bounds without stretching, preserves center/identity/rotation and unrelated
metadata, and clears obsolete source/generation provenance. Original bytes
remain in prior snapshots and native undo. Export renders the captured visible
selection, including its containers' bound text, as transparent PNG through
Excalidraw, capped at 4096 pixels.

Alignment/distribution use Excalidraw's rotated bounds and keep fully selected
image groups together. Distribution expands overlapping selections with at
least a 12-unit gap. Tidy uses deterministic compact columns, preserving ratios
and originals. Cross-frame arrangements are rejected explicitly.

`useCanvasInsets` measures header and composer. Short windows scroll the drawing
dock within the remaining space, above the zoom control. The contextual strip
is clamped into the remaining work area, and its moving anchor is tracked while
the camera changes. Secondary menus may overlay artwork while open; permanent
instruments and the primary strip must not cover each other.

### Codex kernel and canvas adapter

Codex app-server owns the agent loop, persistent threads, native tools, skills,
model discovery, authentication and inference. Galta supplies supplementary
creative instructions and the unified Galta MCP server. There is no
replacement base prompt, JSON-only final answer, ephemeral thread per prompt,
proposal acceptance layer or deterministic substitute agent.

`packages/runtime/src/codex.ts` owns thread start/resume/fork, turn streaming,
server requests and Stop. Threads register no dynamic Galta tools. Galta uses only
public app-server interfaces and never rewrites its rollout metadata or databases.
Legacy threads retain their history; a new conversation obtains a fresh tool catalog.
No retired-tool handler remains in the runtime. All canvas and browser calls use the MCP server and native canvas
bridge. The UI owns embedded execution
leases; external MCP clients acquire their own.

Galta's project ID identifies its canvas and managed creative directory, not a
registered Codex project. Thread creation uses that directory as `cwd` and omits
Codex's `projectId`; canvas context retains the Galta ID.

A thread item becomes a conversation item in one function, `conversationItem`,
so the live stream and `thread/read` restoration cannot disagree about a field.
The item carries the tool name the provider reported, and a surface with copy
per canvas verb keys on that name rather than on the item's prose label.
`CanvasToolName` is derived from the declared tool list and the dock's copy
table is total over it, so a new verb fails to compile until it has words.
`ConversationItem` is declared once, in `@galta/domain`: the runtime produces
it, the workspace stores it and the canvas renders it, and a field added to a
second copy would be invisible to the others instead of a build error.
Command receipts retain the working directory, process exit code and captured
output in that same projection. The dock shows them on expansion, with output
in a bounded scroll area. A nonzero exit code remains a reported process result;
the UI does not infer success or a root cause from shell command text.

`@galta/canvas` owns the provider-neutral working contract used by both embedded
Codex and MCP. The Codex adapter adds only host-specific guidance and the optional
local image configuration. Each turn sends this current contract separately as
`additionalContext.galta_instructions` (`application`, delivered as a developer
message). It explicitly revokes historical Galta language/route rules, including
on loaded and forked threads, without replacing Codex's base or collaboration
instructions. User text remains user text. Canvas context has its own application
key; web captures are `untrusted`. Provider cache
hits and model compliance are not mechanically guaranteed by this delivery.

`CanvasDocument` owns canvas reads and mutations, and the canvas tools are thin
adapters over it, one verb each:

- `canvas_inspect` returns the revision, viewport, selection and a compact
  projection with exact native type, existing name, geometry and rotation in radians. Canvas-scoped
  `query` searches full authored text (`originalText`)/name with a case-insensitive
  literal substring, unaffected by automatic wrapping and preserving explicit line breaks;
  `kind` and `groupId` combine with it to find typed objects or group members.
  Empty matches succeed with an empty page. Filters do not apply to the frozen
  selection or explicit IDs. Optional
  `ids` filters up to 64 targets, failing on missing IDs. `detail: "elements"`
  includes every applicable field from `CANVAS_WRITABLE_PROPS`, plus bindings,
  groups, frame, crop and image scale. Asset bytes and version/seed bookkeeping
  stay out of the response. Total and returned counts distinguish targeted reads.
  Status and paged exports return `next` arguments for the same tool (or null
  when complete), preserving the query, source choice and checked revision.
  Clients retain their execution binding; `coverage.nextOffset` remains available.
  Read limits and their model-visible descriptions share `packages/canvas/src/reads.ts`.
- `canvas_capture` accepts one target: `element`, `ids`, `region` or `scope`.
  Element, ID and selection views include native group members, bound text and
  frame children by default; `include: "exact"` isolates the named elements.
  A world-coordinate `region` crops the composition, including independent text
  and intersecting backgrounds. Excalidraw renders that crop with a detached
  export frame; no frame is added to the document. Explicit
  `scope: "canvas"` overrides the submitted selection; an empty explicit
  selection fails. A low-detail JPEG is bounded at 1400 pixels and high detail
  doubles the rendering scale up to 2800 pixels. Codex controls subsequent image
  resizing and model detail after receiving the MCP image block.
  Results include revision, count and completeness. Embedded HTML shows as
  a poster of its loaded page, listed in `htmlPosterIds`, and makes the view
  incomplete; other iframe content, and a page whose poster cannot be drawn,
  is listed in `unrenderedElementIds`.
  Initial model context contains orientation and counts; these do not limit
  paged status reads or canvas images.
  Oversized images fail explicitly rather than dropping elements.
- `canvas_report` records a bounded claim ledger against the evidence IDs
  returned by reads and captures. It requires the current revision and returns
  the exact records used by the claims. It checks that evidence belongs to one
  revision, covers the declared targets, is complete, and has the medium the
  claim category requires. Every record carries total and covered identity
  counts, so a bounded ID sample cannot masquerade as complete coverage.
  Geometry cannot support an appearance claim, and a single-object appearance
  claim requires one exact capture per target rather than a composite viewport.
  Its `evidence-sufficient` status is deliberately a boundary check and always
  carries `semantic: "unverified"`; it is not a semantic vision verdict.
  Uncertain model interpretation remains explicit in the claim and final answer.
- `canvas_edit` validates the revision and native Excalidraw operations,
  prepares a normalized immutable candidate without changing the editor,
  persists a history version, then applies the exact saved document in one
  native undo step. Its operation union and runtime required/allowed-field
  checks share `CANVAS_OPERATION_DEFINITIONS`. Public properties are factored
  once so host schema simplification retains the operation types and required
  `elementId`. The MCP and editor use the same domain validation, with original
  zero-based operation indices in errors. The response contains the new revision, total element count,
  changed element summaries marked `change: created|updated`, saved artifact paths
  and deleted IDs; unchanged elements stay out of it. These fields are the
  authoritative structural receipt. Query changed IDs with detailed status only
  when exact fields absent from the receipt are needed. Successful
  revisions can be reused for subsequent edits. Missing and stale revisions have
  distinct errors. `create_text` applies explicit native
  props over its size/color presets. Only line, arrow and freedraw elements may
  have a zero width or height; validation of updates uses the actual target type.
  Media use the same planner: `create_element` with `elementType: image|video` and
  `props.mediaPath`, or `update_element` with `props.mediaPath`. Each artifact path
  is loaded once per batch. Bytes, native elements, grouping and layout enter
  one persisted edit; unreadable media, kind mismatches or invalid later
  operations leave the document untouched. New media may omit coordinates to
  use the execution viewport; one supplied dimension preserves aspect ratio.
  The execution viewport, like held places' centre, is what the reader can see
  (`visibleCanvasFrame`): the clear frame less the reading sheet while it is
  open, measured at the height the sheet is rising to, so work lands and is
  sized in view while the reply is read. The camera and locating keep the
  clear frame. The submitted viewport stays the whole editor at the time of
  the request, so it does not change as the sheet opens and closes and
  unchanged views keep reusing their pixels. A built-in task runs in the
  background page, so while any runs on a canvas its view reports the reader's
  current view to the task (`view`) as the camera, window and sheet change, and
  the task places work there.
  Replacement keeps identity and existing geometry unless explicitly changed,
  and resets image crop to show the complete replacement.
  There is no operation-count limit. Validation and draft planning yield to
  browser tasks on a 5 ms scheduling budget; visible native brush caches are
  prepared the same way before application. This is a cooperative target, not
  a hard frame-time guarantee: one native geometry operation, JSON parsing,
  normalization, persistence serialization and final scene application remain
  indivisible. Transport size and dispatch time bounds still apply.
  After every asynchronous preparation phase, the original document revision
  and restoration generation must still match. Stop, closure and concurrent
  drawing cannot adopt a stale candidate.

  `CanvasPresentation` owns a disposable SVG reveal, never live artwork. After a
  batch commits, the newly added elements are replayed over the native paint and
  fade out for 120 ms, so the camera follows the live view and the decoration
  never enters persistence or undo. Because the reveal follows the commit rather
  than preceding it, it covers a document that is already final: it cannot change
  the transaction, delay it, or leak into a receipt. Decoration spends at most a
  4 ms budget per frame and continues across frames until the batch is staged,
  skips offscreen content and reduced motion, and removes each node as its fade
  ends. Elements the overlay cannot draw faithfully — bound text, whose rendered
  origin is container-relative, and HTML or video bodies, which need their native
  mount — are omitted rather than approximated. Error, Stop, unmount and
  completion remove the reveal and its listeners.
  This is progressive execution of a complete MCP request, not streaming of
  incomplete model arguments; the contract is identical for every agent.
- `canvas_place` is the single-file convenience adapter to that same transaction,
  with optional viewport placement and selected result. It has no separate
  image/video save pipeline. It preserves the existing single-file contract;
  the receipt adds `action: created|updated` and `kind: image|video`. Replacement
  preserves geometry; layout changes belong in `canvas_edit`. With `slot` it
  fills a place held by `canvas_reserve`, fitted in the media's own
  proportions, and the place ends.
- `canvas_reserve` holds places where slow work will land. They are view state
  drawn over the canvas with the agent's working light, never written to the
  document, and they end when filled, released or when the execution ends. A
  `slot` on `canvas_place` or on a `canvas_edit` create or update fills one.
- `canvas_extract` prepares image, video and embedded HTML source files on demand.
  Paged `scope: selection` or explicit `ids` return the
  same target metadata and coverage as inspection, with a neutral `file` record
  on extractable sources plus a fenced revision. Discovery and file preparation
  therefore need one call. Ordinary geometry and text remain metadata; missing
  submitted targets stay missing even when original bytes survive. Pagination
  uses the same revision and coverage rules as inspection.
  Ordinary `canvas_inspect` stays read-only and never materializes files.

  Source files are named by SHA-256 of their bytes under `sources/`. Identical
  bytes reuse a path across targets and executions; different bytes
  cannot overwrite the original. The native publisher verifies an existing
  file before reuse, rejects changed contents and symlinks, and publishes new
  files atomically without truncation. Repeated explicit exports still transfer
  bytes for this integrity check; callers should reuse returned paths. This is
  a bounded workspace artifact mechanism, not a second asset registry.

  Submitted targets retain captured originals after replacement, movement
  or deletion. Explicit `source: current` exports current canvas bytes; default
  exports of non-submitted elements also fence the live revision and restoration
  generation. Single frozen-source exports do not claim a current revision.
  Paged exports fence their current target metadata even if bytes are frozen.
  Stop rejects unfinished exports; successfully published immutable files may
  remain reusable. No export mutates the canvas or recreates deleted objects.

Successful MCP receipts also drive compact conversation activity: adding an
image, replacing an image and updating several objects are distinct effects.
The runtime projects only confirmed counts/kind from public app-server results,
using the same projection for live and restored history. Failed, interrupted or
historical calls without effects remain generic; arguments are never treated as
proof of success. Visual checks remain explicit and generation never commits
candidates automatically.

`CANVAS_PROP_SCHEMA` owns property discovery and the accepted property names and
enums. Creation may supply an ID for later operations in the same batch. Native
`groupIds` are ordered innermost first; every member must agree on each group's
parent. `move` defaults to the element with its bound text and frame children;
`scope: "group"` moves its complete native group. `bind_text` and `bind_arrow`
accept target IDs, with null to detach. Excalidraw owns text wrapping, label
position and arrow geometry. The planner clones the scene before invoking these
mutating native algorithms, maintains reverse references and validates the whole
batch before committing. Geometry and typography edits refresh affected
relationships; style-only edits do not remeasure text. Snapshot preparation
repairs native records without remeasuring unrelated artwork.

Selection actions using `CanvasScene.replace` update attached relationships on a
detached draft too; image alignment, tidy, rotation and replacement cannot leave
connectors at the old geometry. The operation planner already resolves its
relationships, so it commits through prepare/apply without a second layout pass.
Binding existing text places it above its container. Detaching restores its
unwrapped original content. Standalone text with attached arrows must first have
those arrows rebound or detached before it can become container text, since
native arrows cannot target bound text. Empty text updates remove the text and
its reverse references in the same edit. `text` and its legacy `originalText`
alias must agree when both are supplied. Path dimensions derive from `points`;
resizing a path with only width/height fails instead of silently doing nothing.

`canvas_capture` returns structured MCP image and text blocks. The former dynamic
image workaround (`direct_only_tool_namespaces`) has been removed. The native
host configures the required full `galta` MCP server, and the extension verifies
its effective configuration after initialization. One cleanup path handles local
errors and remote disconnects, rejecting pending calls and ignoring retired-port
events. No Codex source, executable or global configuration is changed.
The canvas bridge allocates the workspace once, as part of acquiring execution.
Codex consumes that lease's directory and only reads its local runtime settings
through `galta/config/read`; it does not create or resolve canvas workspaces.
Export/place exchange bytes through the workspace filesystem. A 2800-pixel Galta
render does not guarantee the model receives that resolution; region views
provide focused inspection.

HTML uses `canvas_edit` with `create_element`, `elementType: "html"`, and
`props: { htmlPath: "/absolute/workspace/outputs/page.html", width: 960, height: 640 }`.
The required `x` and `y` locate its top-left corner. `update_element` with the same
`htmlPath` property replaces an existing HTML object's source while preserving
its ID and geometry. Other ordinary operations move, resize and delete it.
`CanvasDocument` validates all operations, reads artifacts through
`artifact/read-html` on the canvas bridge, rechecks revision and Stop, then prepares the entire
batch before the normal staged save/apply/activation sequence. Invalid artifacts
or an invalid later operation never partially change the editor.

A page, image or video carries its own words: `props.title` (at most 120
characters) and `props.caption` (at most 280) on `create_element`,
`update_element` and `canvas_place`. They live in the element's
`customData.title` and `customData.caption` (`objectLabel.ts`), so they travel
with the object through history, copies, export and import. An empty string
removes one; any other target kind is refused with the operation's index.
`canvas_inspect` returns them and its `query` searches them. Galta draws them
beside the object (`ObjectLabels`, see the [interface rules](design/README.md));
they are presentation, so exports, posters and `canvas_capture` show the object
alone.

The native bridge accepts complete UTF-8 `.html`/`.htm` documents up to 4 MB
inside the opened creative workspace, resolving symlinks before checking scope.
Documents must inline local dependencies or use absolute HTTPS resources;
relative filesystem resources are not served. The original HTML is stored in
`customData.htmlDocument`, with path/thread/turn provenance on the element.
The native `embeddable` owns geometry, selection and click-to-interact behavior;
Galta supplies `renderEmbeddable` only for its `/html-preview.html` link.
The packaged MV3 sandbox page owns a nested `srcdoc`, allowing scripts, forms,
scrolling and HTTPS resources without extension APIs or parent DOM access.
The renderer prepends the first `<base href="about:srcdoc">` before parsing the
source, so fragment links, including dynamically created links, navigate within
the generated document rather than to the extension wrapper. Sandbox CSP allows
only `about:` base URLs; network, data and script base URLs remain disallowed.
The renderer's base is runtime markup, never a change to saved or exported HTML.
The privileged extension CSP stays `script-src 'self'`; generated code runs
only in the opaque sandbox. Only messages from the owning parent can load HTML.
Repeated identical document messages preserve the current interaction state.
Changing source or reopening initializes the document anew; form and JavaScript
runtime state are not workspace state.

The shared `canvas_edit` description owns this contract for every adapter.
Existing Codex threads retain their previously registered tool descriptions.
`canvas_inspect` reports an HTML element as kind `html` with
its `generatedPath`, so no document bytes enter model context. `.galta`
exports retain full HTML.

The selected-element capsule downloads this stored source as UTF-8 HTML;
original image/video downloads retain their source bytes. PNG uses the shared
`selectionExport.ts` renderer, capturing the selection and export state before
asynchronous poster rendering. It includes visible crops and rotations, has a
transparent background and limits the longest edge to 4096 px. Local downloads
do not require an account or a connected agent.

Webpage **Open** opens a tab with the user gesture and flushes the current editor
through the existing commit queue. Only after the immutable saved snapshot
matches the requested HTML does it navigate to `page/index.html`, addressed by
project, version and element ID. The preview reads that snapshot from the same
workspace repository and uses `HtmlEmbed`'s existing opaque sandbox. It never
executes generated HTML in an extension-origin document, retains no second HTML
store, and can reload after the canvas tab closes. Trimming or deleting the
version produces an explicit unavailable message; it never substitutes a newer
version. A blocked popup or failed save is reported on the canvas, and a failed
save closes its unused tab. The local preview URL is not a public share link.
The development sharing study has no production publishing backend.

Every bitmap of the canvas (thumbnails, history frames, selection export and
`canvas_capture`) shows a page as its poster, projected by `withPosters` in
`htmlPoster.ts` alongside video posters. The page loads once, unseen, at its
element's size in the same sandbox page; a capture script ahead of the source
waits for load and fonts, then returns the page as self-contained markup: what
its scripts built, canvases as pictures, form values and link styles, and the
remote images, style sheets and used web fonts whose servers allow a
cross-origin read within 2.5 s. The canvas draws that markup as an SVG image,
so nothing in it runs, and caches the poster per document and size. Posters
lack interaction and scroll state, nested frames, WebGL without a kept buffer,
and remote content that refuses the read. A page that cannot be drawn within
8 s shows its title instead, is logged with its element ID, and is reported as
unrendered.

Images, video and speech come from Galta's generate tools, listed only while
the user has a provider account connected in Settings; they write files into
the execution workspace's `outputs`; see
[generation](agent-architecture.md#generation).

Galta deliberately uses `approvalPolicy: never` and full-access
execution (`sandbox: danger-full-access` on thread start/resume/fork,
`sandboxPolicy: {type: dangerFullAccess}` on every turn). Both approval and
sandbox policy are sent at the turn boundary because loaded threads can ignore
resume configuration. The creative workspace remains the working directory;
it is not a filesystem security boundary for Agent commands.
The reasoning model/provider and global Codex configuration are unchanged.
Generation alone does not change the canvas: Codex must present the
artifact through the canvas tool. Galta does not replace an image request with
text or claim placement before the adapter succeeds. Each mutation checks a
fresh document revision; an intervening user edit requires Codex to read again.
Stopping preserves already completed edits, each recoverable through history.
Both `canvas_edit` and `canvas_place` use three ordered steps. `stageAgentSnapshot`
atomically preserves preceding user drawing as the active base and saves the
candidate on its own branch. It does not select the candidate as the workspace
head. Application then rechecks the abort signal, document revision and history
visit before touching the editor. Only after actual application does
`activateCanvasSnapshot` select that existing version for reopening and save the
current camera. Branches that are ancestors of the active head are not shown as
alternative rails, so ordinary successive agent edits remain visually linear.

A failed staging save leaves original objects, pixels and native undo intact.
An intervening edit, Stop or restoration prevents application. The candidate
remains a recoverable alternative; later current drawing is saved normally.
An unchanged base after Stop needs no duplicate artwork commit. Destroying the
owning page between the database commit and application cannot make the candidate
appear as the active canvas on reopening: the base was already preserved in the
same transaction. This is verified with actual production-page destruction and
reload under controlled native messages, not installed-sidebar lifecycle.

If saving later user edits also fails, the explicit error identifies the saved
candidate and unsaved later edits. If selecting an already applied candidate
fails, the error distinguishes its visible, durable artwork from the unchanged
default reopening version. Both versions remain reachable; no automatic retry
or rollback hides either failure. Durable writes are broadcast even if post-save
application fails. Camera movement alone does not invalidate a candidate, and
application keeps the live camera.
Late initialization fills only its captured root snapshot and cannot overwrite
a newer head.

`WorkspaceBundle.agentSessions` stores the real thread ID, turn IDs and a
bounded-to-this-project conversation projection. `agentCheckpoints` associates
canvas versions with completed turns. Restoring a version creates a new session
immediately and copies the current message draft.
Its `forkFrom` stores the selected session's nearest completed ancestor checkpoint.
Every history submission persists this pending fork on the session before task
dispatch; the transient task request has no separate fork override.
The next request uses `thread/fork` at that point. `normalizeSessionBinding`
repairs records saved by older versions with both fields, and
`bindSessionThread` consumes `forkFrom` when app-server returns the new native
thread ID. Later saves cannot restore the pending fork. Task startup applies the
same invariant before choosing fork/resume.
Subsequent turns resume the existing thread; they do not fork again. Previously
created native branches remain intact because each may contain unique turns.
With no checkpoint it starts a new thread.
An established session cannot be rebound to another native thread by a concurrent
save. The runtime accepts either a resume ID or a fork checkpoint, never both.
A failed fork retains its pending origin. Once Codex returns a new thread ID,
Galta saves that binding before starting a turn, even if Stop arrives while the
fork response is pending. A failed first turn therefore resumes the same branch
on the next explicit submission. No automatic request replay is introduced.
This follows the official [app-server thread lifecycle](https://developers.openai.com/codex/app-server):
`thread/fork.lastTurnId` is inclusive; `thread/resume` appends to the recorded ID;
`excludeTurns` only omits returned history. Codex owns the native ancestry and
model context. See fork verification
for real protocol and browser coverage, including failure boundaries.
The existing canvas branch and session remain intact. Changing sessions changes
conversation context, not the canvas. Reopening reads Codex history to reconcile
a stale running state while retaining recorded tool activities omitted by
`thread/read`.

Live plan, public reasoning-summary and command-output deltas are bounded before
they enter a task snapshot. This keeps string growth and BroadcastChannel
serialization finite while a provider is still running. A completion receipt is
authoritative and can replace the preview with its full output; a sparse receipt
retains the explicit preview marker so an interrupted stream never looks
complete.

`ConversationDock` renders chronological Markdown replies and compact activity
rows on a light reading surface above the bottom-attached charcoal input.
Tailwind owns this layout and styling; shadcn Button, Textarea, Tooltip and
Collapsible own controls. Dedicated composer CSS only draws the concave shoulders.
Composer context appears only for a selection (`N selected`) or an unavailable
submitted webpage. Default canvas and source-domain labels are omitted;
source-page observation and task binding remain automatic.
Sending opens the reading surface so the new request is immediately visible;
questions also open it, and closed unseen results have an unread indicator. The
header owns the single down-chevron collapse control. `SessionMenu`
is composed into the reading header through `actions`; it owns the direct session
picker and creation action. New session persistence completes before closing the
reading surface and requesting input focus. `RuntimeMenu` is composed into the
footer through `runtime`; App retains runtime state and callbacks. Its single
explicit anchor is the input's top edge. The popover stays above it and scrolls in
short viewports. Model radios and segmented Thinking choices share the popover.
App's `runtimeMenuOpen` state allows one session or model menu at a time. Active
runs keep model and Thinking changes disabled while session creation and
switching remain available. Selecting a model preserves supported effort or
selects its first advertised effort, reflected immediately in the UI. A failed
disconnected send opens Model. Send and Stop share one fixed icon footer target;
while a run is active, the target shows Stop without a draft and keeps the
Send message action for a drafted follow-up. The task registry fences that
follow-up by task identity and queues it until the provider turn boundary,
so steering remains an internal transport detail and the composer never
rejects a deliberate user instruction merely because the agent is still opening
its turn.
`WorkspaceMenu` is the named canvas picker beside the Galta wordmark. It exposes
search, recent thumbnails, creation, rename, duplication, archive/restore, deletion of archived canvases and
import/export. Its file input remains mounted when the popover closes. Navigation
is coordinated by CanvasWorkspace; editor and runtime state stay in CanvasSession.
Command/file approvals, permission requests and structured
user questions route back through their original JSON-RPC request IDs. Unknown
interactive request types fail explicitly; they are never silently approved.
Artifact delivery separates a model's declaration from download authority.
Tool results expose an absolute `path` for subsequent agent calls and a portable
`galta-workspace:/...` `artifactUri` for final Markdown links. On a completed
turn, an explicit `canvas_deliver` declaration is authoritative and carries its
source URI, version and SHA-256; finalization freezes those declared source
bytes even if the destination path changes. Without an explicit declaration,
the task executor parses each `final_answer` as Markdown and submits its local
link destinations to the registered canvas bridge. Workspace-relative
paths, absolute paths and `file:` URLs are also valid declarations when the
host verifies that they resolve inside this workspace. Code, bare paths,
images, commentary, external links and files merely inspected by a tool do
not declare a delivery.

The host validates every destination ancestor before creating directories,
rejects traversal, workspace symlinks and non-regular files, then
copies each accepted file into delivery storage outside the Agent working
directory. Its persisted receipt records the exact bytes' SHA-256, size,
filename and file version, bound to the project, thread, turn and message.
The conversation stores these receipts with their originating message and
projects them into download controls. An explicit receipt also repeats the
portable destination alias as `artifactUri`; the conversation indexes the
absolute link, receipt URI and alias as one delivery, so Markdown and the
dedicated control cannot produce two actions. A matched Markdown link always
uses the receipt grant. Receipt downloads require the matching host manifest
and remain valid after the original file changes; a URI alone does not
authorize reading a delivery snapshot. Failed declarations remain
visible as delivery failures. Absolute paths without a receipt remain inert.
Existing managed source links retain their workspace-scoped, version-fenced
read behavior, but do not acquire a historical snapshot merely by replaying
an old conversation.

`ExtensionCodexRpc` owns one client lease. The MV3 bridge owns transport routing:
client RPC responses and server tool requests have distinct ID directions.
Each running thread has one canvas owner. Closing that canvas rejects pending
tool requests and interrupts the turn, including a close during scheduling.
Concurrent requests for that same thread are rejected. This is run ownership,
separate from the canvas bridge's cross-window document execution lease.

The native host starts the installed `codex app-server --stdio`, translates
framing and transports artifacts. It opens a project-specific directory under
the platform-native Galta data root's `workspaces/<project-hash>` directory.
On macOS the root is `~/Library/Application Support/Galta`; on Windows it is
`%LOCALAPPDATA%\\Galta`; on Linux it follows `XDG_DATA_HOME`. Image reads are restricted to that directory
or canonical paths observed in the current thread's generation notifications.
It accepts PNG/JPEG/WebP, limits output to 32 MB, and chunks large JSON messages
below Chrome's 1 MiB native-to-extension message limit. Output fragments are
serialized; interrupted or out-of-order sequences fail explicitly. Either
stdio peer closing terminates the relay's child process.

Playwright remains a repository test dependency. Source-page tools operate
through the installed extension and existing page; no browser runtime is
installed or launched. Current turn instructions cover new, resumed and forked
threads and describe the source-page contract. Galta's full-access execution policy does not
require sandbox escalation. This is an Agent instruction, not a shell interceptor.
See [browser verification](agents/codex.md#browser-verification).

Codex owns its sign-in; provider keys for generation belong to Galta's media
store and are entered only in Settings. Browser-only subscription OAuth is not implemented;
the native host and an official Codex (the user's own, or the pinned one Galta
downloads when asked) remain prerequisites for built-in chat. Login
opens one centered official authorization popup and matches its completion by
login ID. See [the connection contract](agents/codex.md).

The service worker routes messages and opens the side panel when the host
exposes a usable Side Panel context. Its action handler opens the full canvas
tab as the bounded fallback when that context is absent or rejects an open. It
also clears Chrome's persistent action-to-panel behavior, keeping
unsupported embedded hosts from intercepting the action before that fallback.
It never persists canvas snapshots or manufactures drag gestures. A Chrome Web
Store installation opens one canvas tab on first install; development and test
loads, which carry no update URL, open nothing. The obsolete capture context
menu and its permission, the unused downloads permission and the duplicate
manifest have been removed.

### Aha Labs account

Galta signs in with an Aha Labs account, the one account shared by Aha Labs
apps. It is optional identity and nothing else: it holds no canvas, gates no
feature, and every canvas works signed out and offline.

- The service is its own project, `aha-labs-hq/account`, at
  `https://account.ahalabs.site`; its README is the contract Galta follows.
  Galta is a client listed there by extension id. Only the main checkout's
  unpacked id (`oocbicpnofichiglihkbmpkjegiakhgg`) is listed today; a release
  build's id (from `extensionPublicKey`) must be added to the service's
  `EXTENSIONS` before release, or its Google sign-in and requests are refused.
- `shared/account.ts` holds Galta's copy of that contract: the origin, paths,
  code length and the Google handoff message.
- `background/account.ts` owns this browser's session. It keeps one bearer
  token in `chrome.storage.local`, which `protectAccountStorage` limits to
  trusted contexts so content scripts cannot read it, and calls the service
  without cookies. Pages ask it through `{ type: 'account' }` messages and
  follow storage changes, so every open Galta page shows the same person.

Sign-in is an emailed six-digit code (unknown addresses sign up) or Google.
Google runs in a browser tab: `/google` starts it, and the service's
`/signed-in` page hands the session to this extension through the manifest's
`externally_connectable`. The background accepts a handoff only from that
page and only for the request id it minted, checks the token, then closes the
tab. Requests, their returned state, handoffs and tab-close events share one
queue. Signing out cancels any pending Google attempt, including one opened
from another Galta page, so its late handoff cannot sign the person back in.
Deleting the account takes a fresh emailed code: the background signs in
afresh, and only that new session may delete. A session the service refuses
signs the browser out (the corner turns back into a gear and the Account view
says the session ended); an unreachable service keeps it, and so does a page
that cannot reach the background, which keeps its last known state. A failed
background status read shows an explicit reload notice in Settings and the
account view; it never remains labelled as an ongoing check. Only a valid
background response clears that notice.

Settings is one dialog over the canvas (`setup/SettingsDialog.tsx`), opened
from the bottom-left `SettingsCorner` or from an entry that needs a
connection. Its views are the account, Chat in Galta, Work in Codex or Claude Code and
Generation. Built-in account state and the current external canvas lease are
independent; an idle external connection carries no disconnected warning.

## Development and release

bun run build:dev runs Vite in development mode with NODE_ENV=production and
writes apps/extension/dist. bun run dev:watch watches that output. The shell's
`data-build` attribute exposes the build identity, a digest of the sources it was built from, for inspection. Rebuilding
does not replace code already running in Chrome: reload the relevant extension
view after saving work; native undo state does not survive reload.

`bun run build` first runs `tsc -b` to refresh shared workspace packages, then
writes `apps/extension/release`; Vite imports their compiled `dist` exports.
This order prevents a production bundle from silently using older runtime code.
`build:dev` writes `dist`; after changing a shared package, run `bun run typecheck`
before a direct development build or restarting its watcher.
Fonts ship under `/fonts`, served locally by the Vite development plugin and
copied into both build outputs. No remote font CDN, runtime script download,
old canvas SDK or license gate is retained.

### Engine migration and UI boundary

`CanvasScene` is the small Excalidraw imperative API boundary: coordinate
conversion, immutable snapshots, atomic programmatic updates, image preview,
and distinguishing user edits from programmatic restoration. It does not own
a second live element store. Native version fingerprints avoid serializing
embedded images for selection or pointer changes. The API is acquired before
initialization completes; hydration waits for `isLoading === false` so an
empty initial scene cannot overwrite restored content.

`freeDraw.ts` owns the programmatic brush geometry contract: local points start
at `[0, 0]`, the element origin shifts by the old first point, and dimensions
come from the normalized point extents. This is the representation produced by
Excalidraw's native pointer tool. `restoreElements` and `newElementWith` do not
perform this conversion for freedraw. Without it, the live per-element bitmap
cache clips/displaces offset points while direct exports (agent views and
history previews) still show them. The planner normalizes each create/update
before later operations can read it; scene preparation covers other
programmatic inputs. This geometry correction does not change the renderer.

Restoration converts only the applied copy of old brush records. Absolute
points and their bounds-based rotation center stay unchanged, as do pressure,
style, identity and ordering. The existing saved/applied snapshot boundary
retains original history bytes and revisions until an actual edit; it does not
migrate or overwrite old snapshots, add history entries, or replace backups.
New edits persist canonical records in a new version. Native hand drawing and
undo remain owned by Excalidraw. Explicit pressure requires one value per point;
simulated-pressure strokes preserve but do not use the stored pressure array.

Programmatic updates install scene elements before registering image files,
because Excalidraw builds its image cache from the current scene. A pinned Bun
patch for Excalidraw 0.18.1 fixes an upstream async cache race: if history replaces
element objects while an image decodes, completion must invalidate both the
original objects and the current scene's objects. The patch changes this cache
invalidation in development and production builds; it adds no timer, retry or
second cache. The same patch exports three existing native relationship
functions rather than copying their geometry into Galta, and exposes one
brush-cache preparation wrapper for cooperative first painting. See `patches/README.md`
for the regressions, both-bundle verification and removal criteria.

`migrateWorkspace` is a one-way data converter, not an old-editor adapter. It
preserves IDs, history edges and Codex metadata, converts all snapshots, and
fetches remote image bytes once per unique source. The IndexedDB v2 migration
saves the original in `migration-backups` and the new workspace atomically.
The first original backup is never overwritten. Unrecognized, nested, cropped
or multi-page legacy content is rejected before any durable replacement;
users retain the original export. Current legacy types covered are image,
text, simple geometry and encoded freehand strokes. Imported note semantics
are not silently flattened.

React owns Galta's shell. `src/design/tokens.css` owns its neutral color, type,
space, motion and layer system (see `docs/design/tokens.md`). Tailwind and
Excalidraw adapters consume those values; checked-in shadcn components use Radix for focus, keyboard navigation,
portals and dismissal. `DrawingTools` controls Excalidraw's native tools and
styles. `SessionMenu` owns session controls and `RuntimeMenu` owns model/effort
controls, both composed by App. The native
context menu and editing behavior stay with Excalidraw. No duplicate settings
placeholder page is shipped.

The drawing dock always contains six primary tools and a style control.
There is no collapse state; limited vertical space scrolls the dock internally.
Secondary shapes, arrow and eraser share a popover; viewport controls have their
own bottom-left entry. Both Excalidraw desktop and mobile toolbar regions are
suppressed within Galta. Its native context menus and text-editing surfaces are
retained and tested. The composer owns conversation expansion, active-task
progress and Stop; there is no separate conversation launcher above it.

All Galta canvas and browser operations use MCP. New tool schemas are discovered
through MCP independently of a conversation's creation. Persisted legacy dynamic
declarations are left to Codex; Galta does not edit its internal storage.
Conversation history is preserved, including original labels for past dynamic
calls. User-facing replies follow the user's language. Configured
Codex providers that explicitly require no OpenAI account connect without
requesting ChatGPT-only subscription limits.

src/dev/verification.html is a local-only drag fixture using the real content
script and CanvasApp. It is omitted from release entry points. It tests
single-document delivery, not a native browser side-panel boundary.

### History timeline and playback

Time Machine shows every version grouped into moments, with every other
future as a strand; [its contract](design/time-machine.md) owns its
interaction. Versions are ordered by creation time, adjusted so a version
never precedes its parent, then by depth and ID. `historyMoments` groups them
and `multiverseLayout` lays out the moments around the travelled path, both
derived on open in a few milliseconds for hundreds of versions. Change
detection compares each version's object stamps (`version`, `versionNonce`)
with its parent's and confirms candidates by content, so engine-only revisions
are not changes. Pan, zoom and playback never create document versions.

The stage is a second, read-only Excalidraw laid over the live editor's box
with the live camera, so the first frame matches the live canvas. It shares
the live scene's image URLs, so each image decodes once. Each saved object
becomes one stage copy, shared by every version that holds the same object,
so the engine's shape and canvas caches carry from moment to moment and a step
repaints only what changed; on a 411-version canvas a scrub holds 60 fps. A
past video is its poster. Playback advances one moment per
`--motion-history-step`; seeking, comparing, naming, closing and hiding the
page stop it. A video export composes the stage's frames, transitions
included, into a `MediaRecorder` stream.

`normalizeWorkspace` is the one boundary for the retired history curation:
`savedDirections` become `namedVersions`, and `historyClips` and `historyTrash`
are dropped on read, so hidden versions show again. Stored records change only
on their next write; no commit, snapshot or asset is removed.

### Performance verification

`build:dev` selects the unpacked extension directory but uses the same optimized
runtime as the release build. The Vite development server retains React's
checks for debugging. This distinction matters: local extension performance
must be measured in the installed browser, not inferred from a localhost run.

Opening Time Machine drains queued saves and flushes pending document or camera
work; unchanged artwork is not cloned simply to open it. The preview scheduler
uses selected-frame priority, independent of whether a consumer needs a bitmap
(catalog thumbnails need decoded pixels even at background priority).

Preview delivery and persistence are separate completion boundaries. An acquire
request's `promise` delivers consumer-owned pixels; its `persisted` promise
reports cache encoding and the revision-fenced database write. A cache write failure is diagnosed with
project, commit and phase, and cannot replace an already rendered preview with
an error. Source-document transactions remain independent and authoritative.

The shared preview service owns a render queue and one asynchronous cache writer.
Queued writes borrow the byte-bounded decoded cache rather than pinning another
queue of full-size images. Eviction cancels a queued derived write. The active
writer can retain one extra canvas until completion; it never depends on a
canvas being resized by an eviction. Completed cache entries release their job
and snapshot references. This bounds the additional bitmap backlog, not total
application memory or retained historical data. No document is evicted by this
policy. See the pipeline and architecture audit
for fault injection, comparative measurements and the remaining boundaries.

See history performance evidence
for the workload, cold/persisted-frame results, installed Dia verification and
limits. The benchmark records PerformanceObserver long tasks, rAF intervals,
IndexedDB accesses and retained heap. CPU profiles are taken through CDP. Long
work is measured; Workers are used for the demonstrated brush-outline workload.
WASM has not been added without a measured remaining numeric bottleneck.
