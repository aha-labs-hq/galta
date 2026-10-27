# Conversation reading and responsiveness

The reading unit is a dialogue within a turn: the user's original request,
agent progress messages, accepted follow-ups, and the agent's response. User
messages share a quiet right-aligned bubble, with normal-weight text; agent
messages occupy the reading column. Commentary remains readable in softer,
slightly smaller type inside the process segment at its original position; when
that segment is opened it is direct prose, not a nested disclosure. It is not
flattened into the final answer or hidden among tool receipts.
Submission context belongs to the composer, where the user can review selected
objects and references before sending. The transcript does not repeat selection
counts, canvas titles or webpage links beneath each request. Submitted context
is still captured and persisted for execution; the composer's existing webpage
availability notice remains in place.
Final output retains the application's body typography, without a repeated
Galta author label. A response directly after a process segment uses an 8px
gap. The process disclosure chevron aligns with the reading column's start,
with no extra button inset, in both open and closed states. Unclassified output
stays in the process treatment without being promoted to a final answer. The
white gradient reading surface owns one backdrop filter. It slides out of the
composer and back into it with its contents, and its glass keeps full strength
at every height: a fading backdrop filter would let the sharp artwork show
through the text. The stationary dock/composer has no glass of its own. Bubbles and the header do not stack blur layers. The header groups
controls through spacing and a quiet surface tint, with one faint bottom edge;
there are no hard vertical dividers or stacked horizontal borders.
The session title keeps native UI letter spacing so
short and long names retain the same readable rhythm.
High contrast uses an opaque surface and explicit boundaries.
The model popover, Effort menu, conversation picker and request navigation inherit
Glass from their shared primitives. The [material contract](tokens.md#glass-material)
owns the `glass-*` tokens and the floating-surface recipe. Model rows and Effort choices use spacing rather than nested gray
plates. The account's provider mark appears once before Codex and its plan in the
footer; the small Model heading has no mark. A leading check and 14px medium-weight ink identify
the selected model; other names use 13px supporting ink without a persistent
selection plate. Effort occupies one quiet row:
its label on the left, its current value and a disclosure on the right. The
supported levels appear in a standard menu only when requested. Choosing one
returns focus to that row; Escape dismisses the level menu before the model
popover. Arrow keys browse the levels and Enter selects. The level menu scrolls
within its available height when needed. The row and menu items keep compact
targets, with 44px targets for coarse pointers. A denser `glass-control-base`
protects the compact supporting text over dark artwork while retaining the
reading surface's directional wash and edge.
The header, model names, Effort and account text share one reading column;
the model check and account mark occupy its leading gutter.
The Effort disclosure sits at the trailing action column.
Ordinary one-line rows use the compact
target height without an additional interval; longer model names can grow.
The heading and account text use 11px supporting type. The list reserves 8px at
both ends and masks those short edges, so a constrained list softens away rather
than cutting through a label. Content padding and scroll padding keep complete
end names clear of the fade. Contrast and reduced-transparency preferences remove
the mask. Effort follows the final model row after this 8px interval.
The account readout and remaining quota occupy one row after a stronger
16px break, with no divider. Quota shows “80% left” above a neutral 64px-wide,
2px-high gauge. The focusable read-only meter exposes the numeric value; its
hover/focus tooltip qualifies the current usage window. Missing usage hides the
meter instead of inventing a balance. The account observer owns automatic updates;
there is no refresh action in the menu. Settings live in the canvas's
bottom-left corner, not in this menu. Connection failures still show their explicit status,
sign-in/connect action and error text. The popover is 288px wide, constrained to
the viewport; its model list yields height and scrolls
while Effort and the footer remain reachable. Keyboard focus keeps the shared
control surface treatment, and Escape returns to the model trigger. Increased
contrast and reduced transparency use opaque surfaces without blur; forced colors
retain explicit focus and selection cues.
The composer uses [Graphite](tokens.md#graphite-material): a stable action
surface beneath the light reading area. Its opaque base, faint wash and inner
edge follow the existing attached silhouette, including its shoulders. The
Graphite scope owns foreground, hover and focus colors; the material retains
their readability. While the transcript is open, the footer shows the conversation name;
activity text and elapsed time move to the collapsed footer so the open surface
does not repeat the same changing status in two places. The movement grip keeps
a quiet glyph inside a 48×24px keyboard-accessible target.

Naming and Codex name-sync failures belong to the background metadata lifecycle.
Local names and drafts remain usable without a status icon, technical disclosure
or manual retry action. The metadata hook owns one bounded background retry and
recovery on reconnect. Diagnostic console records retain stable identifiers,
the failed RPC method and its reason in a single serialized argument so the
browser's extension error page can also display the details.

The transcript is one output-item timeline. The first appearance of an item owns
its position; later deltas, results and completion events update that item in
place. Contiguous process items form a collapsed process segment at their
original position. The segment contains reasoning, tool receipts, and
interleaved agent prose, and expands in that same order. Process prose is
rendered directly inside the segment without its own disclosure control. Only
an `agentMessage` with `phase: final_answer` is promoted to a top-level reply;
unclassified or `commentary` prose remains process history, even when it is
readable. A request error and pending user interaction remain independently
visible. A failed turn still shows an error even when it has no explicit error
item.

A step opens only onto something to read: a command, a public reasoning
summary, output, an error or a canvas effect. A step with none of these, such
as reasoning the model gave no public summary for, is a plain line in the same
column as the disclosures around it, never a disclosure that opens onto
nothing; a segment of one such step is that line. When Codex condenses the
conversation to keep working within the model's context (`contextCompaction`),
the transcript shows a boundary at that point instead of a step: a quiet line,
"Condensing earlier context" while it happens and "Earlier context condensed"
once it has, with a hairline in the sheet's rule carrying on to the column's
end. It divides the process around it and is not counted among its steps.

Each process segment names its latest meaningful item after completion, so a
finished tool segment reads as the action it performed instead of a generic
"Work details" label. Elapsed time uses `<1s` for sub-second work rather than
presenting a misleading `0s`. The step count and elapsed time follow the current
status text with a small gap on the same baseline. Current text alone owns its
intrinsic width; the retiring status does not leave empty space before metadata.
Long status text can shrink and ellipsize while counts remain readable.
When a reader is away from the bottom, Back to latest appears as a small,
absolutely positioned down-arrow above the composer. It does not reserve a row
or move the reading position. A 140ms opacity/transform transition owns its entry
and exit. Following the latest removes it from pointer, keyboard and accessibility
interaction immediately; clicking it returns focus to the scroll surface. The
accessible name and hover title retain the action's meaning, including pending
user input. Reduced motion removes the transition.

While a process segment is running, its disclosure trigger has fixed geometry.
Only the status viewport changes: the previous state and latest state share one
line box, so the old wording softens away while the new wording resolves in
place. The status, step count and elapsed time share one text baseline inside
that trigger, while the trigger's icon remains centered independently. The
440ms handoff uses opacity, a small blur and a restrained vertical settle; the
surrounding transcript stays still and no highlight band travels across the
ink. The latest state remains available to assistive technology through a
polite live region; expanded details are mounted only when requested.
Only the process segment that contains an in-progress provider item owns the
working dot and live shimmer. Earlier completed segments stay visually still,
including while a later final answer is streaming, so motion identifies the
current provider state instead of the whole turn.

Live status text receives one 440ms text shimmer on appearance and each
replacement, including activity labels and the collapsed composer's status.
Static history does not shimmer. The effect is the readable text itself moving
from softened to clear, with no duplicate decorative copy, gradient or
background clip. No JavaScript frame loop, timer or per-token animation runs it.
Reduced motion, increased contrast and forced colors remove the motion while
leaving the latest text visible.

The input keeps the same Ask Galta placeholder and Send message action during
execution. With an empty draft, its main action is Stop; while writing, a separate
Stop remains available beside Send. Sending waits for the provider's confirmed
turn boundary. A pending submission prevents duplicate gestures, keeps typing
available, and clears only the submitted draft after acceptance. A refusal keeps
the draft and shows its reason; it is not displayed as an accepted message.
The editor also stays writable while the background task host is opening after
connection or sign-in. The send action remains unavailable until that transport
is ready, with a short "Getting ready..." hint; `runAgent` keeps the final
readiness guard at the task boundary.

## Agent presence

Two questions recur while an agent works: what is it doing, and where on the
canvas did it act. The conversation answers both without moving the camera on
its own.

- **What.** While the conversation is closed, the footer's status line speaks
  for the agent in its own words, commentary or answer, one sentence at a time
  like a subtitle: while it works, the sentence it is on, revealed at a reading
  pace; once the turn has finished, the opening of its answer, beside the
  unread dot, until the reader opens the conversation. Each new sentence
  arrives with the status handoff; growth within a sentence does not replay it.
  A tool's name stands in only before the agent has said anything. The line
  replaces the status in place, so the composer never changes height, and the
  model control folds to its mark while the agent works to give the words
  room. The full sentence is the line's tooltip.
- **Where.** A canvas step that changed the canvas records where the change
  landed. `canvasChanges.region` holds at most 64 created or updated element
  ids and the union of all their bounds, taken at the runtime boundary from
  the confirmed `canvas_edit` or `canvas_place` receipt. A receipt without
  geometry records no region. The bounds outlive the elements, so a later
  deletion still has a place to show.
- **Going there.** `Locate` is an arrow in the surrounding ink that points the
  way a change lies and turns, the short way round, as the camera moves.
  - In the closed footer it follows the agent's words, only while the latest
    change is out of view.
  - On each canvas step in the transcript it appears on hover or focus.
    Locating from the transcript closes the conversation first, because
    showing a change means going to the canvas.
  - A change already in view is lit in place. One out of view is reached by a
    flight along the van Wijk–Nuij smooth zoom path (zoom out, travel, zoom
    in), framed in the clear frame above the composer. The flight changes the
    camera as little as it can: travel only if the change fits at the current
    zoom, zoom out only to fit it, and zoom in only up to actual size when it
    is too small to read. Its duration grows with the path, between
    `--motion-flight-min` and `--motion-flight-max`.
  - Any pointer or wheel gesture on the canvas takes the camera back
    mid-flight. Reduced motion arrives at once.
- **Lighting.** On arrival, and whenever a change lands in view while the
  agent works, the agent's light traces the change's outline, holds and fades
  (`--motion-mark`). The mark follows the camera, takes no input, is never
  document state, and is gone when its motion ends. Reduced motion draws it
  whole; forced colors use `Highlight`.

`CanvasLocator` owns these camera decisions for one canvas view, `AgentMark`
draws the light, `narration` chooses the sentence, and `Locate` is the
conversation's only entry point to the camera.

## Reading and navigation

- Requests opens a searchable outline of the original instructions. Each entry
  reaches its request; a separate response action exists only when the provider
  identified a response. No extra model call generates navigation summaries.
- The reading surface can grow to 72dvh / 720px, constrained by the available
  shell space. CSS intrinsic sizing owns the open surface's height, so streamed
  replies can grow and shorter conversations can shrink without leaving a gap
  above the composer. Radix's opening measurement must not become a fixed live
  height. The composer remains reachable in a short sidebar.
- Following the bottom and reading history are distinct user intentions.
  Growing content follows only while pinned. Upward scrolling and navigation
  stop following; Back to latest restores it. Resize observation handles actual
  rendered growth, including deferred Markdown. While pinned, growth glides to
  the new bottom over 220ms (`--motion-follow`); output arriving during a glide
  joins it instead of restarting it. Only an intent to read earlier output takes
  a following glide over: scrolling or paging up, grabbing the scrollbar, or any
  scroll that runs up against the glide, such as a touch drag. Output growing
  below a pinned reader never counts as leaving the latest. Back to latest
  appears only when the reader is not following and newer output lies below.
- Toggling a process or tool disclosure keeps what the reader pressed in place.
  An opening disclosure scrolls just enough to show its contents as they
  unfold, never so far that its trigger leaves the top edge, and keeps doing so
  if its contents grow until the reader scrolls. While it does, the transcript
  does not follow new output; scrolling back to the bottom resumes following.
  `useReadingPosition` owns this policy with following, glides, interruption
  and navigation; the transcript only renders.
  Explicitly returning to latest uses one 360ms cubic ease-out transition.
  JavaScript clock reads CSS time units explicitly: both `360ms` and a build's
  minified `.36s` represent 360 milliseconds. Built-canvas acceptance samples
  intermediate scroll frames from a pointer click, in addition to source fixtures.
  Its destination includes arriving output without restarting the animation, and
  ResizeObserver yields scroll ownership until it finishes. Wheel, pointer and
  scrolling keys interrupt it immediately; navigation, session changes and
  unmounting cancel its frame. Reduced motion makes following and the explicit
  return immediate. A frame loop exists only while a glide runs, with one
  geometry read batch and one scroll write per frame, and no React update per
  frame.
- Closing and reopening in the same session retains scroll position and manual
  process/tool disclosures. Changing sessions resets that local reading state.
  The collapse control returns keyboard focus to the composer's conversation
  entry after the reading surface unmounts.
  Task completion never automatically collapses an opened process.
- Outline navigation moves keyboard focus to the requested content. It does not
  steal the composer focus on incoming text. IME composition does not submit.
- Motion is confined to the reading surface sliding out of the composer
  (420ms, `--ease-sheet`) and back into it (280ms, `--ease-settle`), process
  and tool disclosures opening (260ms) and closing (200ms), the floating latest
  control (140ms), following and returning to latest (220ms and 360ms), paced
  text reveal, and a single 440ms text shimmer for status entry/replacement.
  `Unfold` owns presence and motion for the surface and both disclosures. Every
  change of direction moves the frame's height from the height on screen to
  its destination, so closing and reopening midway continues instead of
  restarting. While the frame moves, its contents hold their height and the
  frame clips them: the transcript is not relaid out and its scroll position
  does not clamp mid-motion. Entering, the height they hold is their own, kept
  live, not the height they had when the sheet began to open: Send opens the
  sheet before the request's first message exists, and that message, then the
  first line of work, arrive while the frame is still leading. They are laid out
  at once, so the transcript does not scroll inside a sheet that is too short
  for it, and the destination follows them from the height on screen. The end
  of the motion moves, and a second motion releases the difference over what
  remains of the first or `--motion-follow`, whichever is longer, on
  `--ease-settle`, so neither the height nor the scroll position jumps when the
  motion ends. A parent that holds the contents shorter than they ask, such as
  a short window limiting the dock, already sets the destination, and they hold
  that height. Content arriving after the entrance has settled is ordinary
  growth. Contents fade in after the frame leads and fade out
  before it settles; a region shown from its first render appears without
  motion. The composer's upper corners square as the sheet rises over them,
  driven by the sheet's measured height rather than a timer. Disclosures keep
  Radix's open state and semantics through `forceMount`. Exiting content is
  inert, while the composer remains usable. Unmounting follows the exit's own
  finish; there is no unmount timer.
  Opening mounts the transcript, and a long history costs more than a frame to
  mount: its Markdown is parsed and its rows laid out before the sheet's first
  frame. So a history that would leave more than a sheet's height behind opens
  with the latest turns that fill the sheet, and brings in the rest once the
  sheet has stopped moving, a turn at a time in idle time. A turn's
  height is guessed from its words, and low on purpose: a window too short for
  the sheet makes the sheet grow after it opens, one too long only costs a
  little. Turns arrive above the reader, so the first turn on screen is the
  anchor: it keeps its place, and the position the reader holds and the one last
  seen move with it. A reader who reaches the top of what is mounted brings in
  more at once; Requests mounts every turn before it jumps; a reader who is not
  following the latest is returning to a place in the whole history and opens
  it whole. A shorter history opens whole, and a sheet that is not yet full
  never grows after it has opened.
  All transitions use the shared motion tokens and reduced-motion setting. Text
  deltas do not replay status animations. No per-token animation is used.

## Protocol and ownership

The [app-server item contract](https://developers.openai.com/codex/app-server/)
supplies optional `agentMessage.phase` (`commentary` / `final_answer`). The runtime
retains it from an empty item start, through deltas, completion, persistence and
history restoration. An absent optional field does not erase a known phase for
the same message. Tool arguments, public result text/structured content and
provider-authored reasoning summaries are retained as bounded activity details;
`summaryTextDelta` and `summaryPartAdded` preserve readable summary sections;
raw reasoning `textDelta` and `content` are ignored even when a provider sends
them, and `plan/delta` updates the same plan item in place. The app-server does
not promise the private complete chain of thought; encrypted reasoning content
is never copied to the transcript.
When no public summary is returned, the reasoning step is a plain line with
nothing to open. Unclassified legacy messages remain readable;
neither their position nor a completed turn is evidence that they are final
answers. Partial output remains visible after Stop. Plan and public reasoning
summaries use a bounded live preview; a very long stream shows an explicit
truncation marker until the authoritative completion receipt replaces it.
Command output uses a larger bounded live preview for the same reason. A
completed receipt replaces that preview with its full output; if the receipt
omits the output or message body, the retained preview stays visible rather
than disappearing.
Declined command and file-change items remain visibly declined rather than being
presented as completed work.

Accepted follow-ups save `afterItemId`, the last observed provider item when
acceptance is confirmed. The view places the message after that item in the
dialogue; tools remain in the separate work disclosure. History reconciliation
maps the anchor when Codex reconstructs an item ID. Older follow-ups without a
usable anchor stay beside the original request; the UI does not infer their
position from wall-clock timestamps.

Execution and persistence stay in the existing task host. It publishes immutable
projections; text and tool-output strings are shared until BroadcastChannel
serializes the latest 50ms display batch. Questions, errors and terminal states
bypass that display delay. Explicit status requests still return a detached
snapshot. The terminal save and cancellation fences are unchanged.

Steering is an ordinary user item in the same timeline. Once accepted, it is
inserted after the provider item recorded by `afterItemId`; it does not create a
separate steering lane or reflow earlier output. Older messages without a usable
anchor remain beside the original request.

`ConversationStore` is the view's projection subscription, not another runtime.
At snapshot admission it retains unchanged item/context identities. Text updates
notify the conversation; the workspace observes only submitted context. History
snapshots reconcile once before entering memoized turn components. The canvas
wrapper is memoized without changing Excalidraw internals.

The message-draft hook owns draft contents and durable writes. Only the composer
subscribes to command text. Sending
reads the current draft, and clears it only if asynchronous submission has not
been followed by another edit. Existing serialized saves and navigation flushes
remain in force. The textarea uses native `field-sizing: content`; typing does
not recreate a ResizeObserver or measure the entire transcript.

## Markdown and tool rendering

Streamdown 2.6 owns ordinary Markdown block segmentation, incomplete syntax and
block memoization. Deferred text rendering yields priority to input. Galta keeps
native text/code/table elements, HTTP(S) links and textual image placeholders;
raw HTML is text. Optional diagram, highlighting and token-animation plugins are
not installed. Completed turns and unchanged blocks do not reparse for typing,
elapsed-time ticks or unrelated streamed items.

Streamed text reaches the view in 50ms transport batches, and models deliver
tokens in bursts. The view reveals appended text at a rate that drains its
backlog within 140ms, never slower than 80 characters a second, so the reading
line advances every frame instead of jumping by a batch. A prefix still being
revealed is parsed as incomplete Markdown even after its item completes. A
replaced or shortened text, reduced motion, and text past the 12,000-character
streaming Markdown limit are shown whole: the plain projection relays out the
whole text on each change, so it keeps the transport's pace. Markdown
components stay stable unless the message has deliveries or managed
references to de-duplicate, so Streamdown re-renders only the changed block.

Reference links need document scope. The standard Marked lexer identifies link
definitions; these messages are passed as one complete block because Streamdown
2.6 otherwise separates references from definitions. This is a deliberate
correctness/performance tradeoff: very long messages containing reference-style
links can still cost more to update. Other block boundaries stay with Streamdown;
Galta does not split Markdown by blank lines or maintain a second parser.

Execution contents mount on expansion. Individual tool details are formatted at
the runtime boundary from input and public output, capped at 16,000 characters;
Show more output adds another 16,000 for command receipts. Live command output
is capped at 64,000 characters before it reaches the task snapshot and channel;
the authoritative completed receipt may replace it with the full output. A
history reload keeps live details when the provider omits the receipt body. The
one-second elapsed timer owns its own component and pauses while the document
is hidden. The animated reading surface owns the only conversation backdrop
filter; nested header surfaces use gradients so no additional blur layer is
introduced. Its motion clips the sheet rather than resizing the transcript.

## Verification

- `tests/conversation-presentation.test.mjs` covers snapshot identity,
  unclassified/interrupted output, failures and phase restoration.
- `tests/codex-kernel.test.mjs` covers empty message starts, phase across live
  notifications and authoritative command-output completion.
- `tests/browser/conversation-reading.spec.ts` covers outline/focus, scroll and
  selection stability, retained disclosures, drafts, narrow layouts, reduced
  motion, large output, IME and streamed Markdown semantics. It inspects actual
  intermediate animation frames, exit presence and interrupted closing.
- `tests/browser/conversation-comfort.spec.ts` covers dialogue order, ordinary
  follow-up bubbles, simultaneous Send/Stop, readable reasoning, high contrast
  and narrow-screen controls, with rendered working/completed/detail screenshots.
  Shimmer samples inspect the real softened-to-clear entry/replacement frames,
  clipped long labels, the latest state after interruption, ordinary text in
  accessibility modes, and the absence of replay on streamed output or static
  history.
- Text shimmer evidence
  includes real CSS intermediate frames and a recorded local-component preview;
  the locked Dia session remains outside that verification.
- `tests/agent-presence.test.mjs` covers flight paths, minimal framing, view
  and bearing geometry, and narration sentences; `tests/canvas-activity.test.mjs`
  covers regions from receipts. `tests/browser/agent-presence.spec.ts` covers
  the footer's words and answer, the arrow and in-place lighting with a
  stand-in locator, transcript locating, and a real flight and mark on the
  built canvas.
- Conversation motion evidence
- Dock opening evidence
  freezes the sheet's motion and one cycle of the agent light, records the
  dock in real time, and compares main-thread time with the previous build.
- Performance pressure evidence
  records the 4x CPU, long-history and long-reply run: no long tasks, with the
  long-reply case reaching 33.3ms at p95 rAF interval and 18.1ms p95 key-to-rAF.
- Existing composer, metadata and task durability suites cover the production
  application and IndexedDB with controlled agent events.

Frame budgets and input latency must be measured with a stated device and
workload. A component pressure test is not a claim about all Dia tabs, arbitrary
transcript lengths, or actual model/network latency.

Run `bun scripts/verify-conversation-performance.ts` for the isolated production
component pressure test. It builds into a temporary directory and runs a private
browser with 4× CPU slowdown, a 50ms stream, concurrent typing and scrolling,
tool-heavy history and a long active reply. `GALTA_PERF_OUTPUT` chooses the JSON
report location. The report distinguishes rAF intervals, key-to-rAF and sampled
Event Timing durations; none is claimed as measured painted-frame latency.
