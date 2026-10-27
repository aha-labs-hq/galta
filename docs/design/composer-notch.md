# Bottom-attached composer

Updated and visually reviewed on 2026-09-29. This contract supersedes the earlier
composer layout notes; older screenshots remain historical evidence.

## Hierarchy

The charcoal input attaches to the bottom edge. Its radius is `--radius-dock`,
the same 8 px the expanded conversation reading surface above it uses, so one
surface never shows two corner sizes. The turn still keeps a flat, notch-like
body while the side transitions remain continuous. At rest it is 88 px
tall on desktop, 92 px with coarse-pointer targets, and at most 560 px wide.
Multiline drafts grow upward. Expanded conversation is a light
reading surface joined above the input. While it is closed, the footer's
status line speaks the agent's own words; see Agent presence in
[conversation-reading.md](conversation-reading.md).

The footer has three groups in a stable order:

1. Current conversation and its compact status trigger.
2. Model and Thinking, opening one settings popover.
3. One action target; it sends while idle, stops an active run with no draft, and
   sends a follow-up when an active run has a draft. The target keeps its
   icon-only face and the user-facing action remains `Send message`; steering is
   an internal transport detail. A separate compact Stop action stays available
   while a draft is present during an active run.

The expanded reading header contains Conversations, a direct session picker,
Requests and a down-chevron collapse control. The footer keeps the conversation
status as its compact access point when the reading surface is closed.
Workspace import/export and backups belong to the named canvas picker beside Galta.
The eight drawing controls remain in an independent left dock, without an
expand/collapse state. Their 32 px targets (44 px for coarse pointers) are square with 8 px corners,
as are the color choices and Send/Stop face. Selection and hover follow the
same shape; they do not introduce circular backgrounds.
The textarea is transparent and inherits the composer surface; it does not use
the default dark input fill, so the prompt reads as one continuous field.
One filled SVG outline includes the body and shoulders. The composer uses
continuous corners: a cubic curvature ramp turns 30°, a true circular arc turns
30°, and a reversed cubic turns the final 30°. Each ramp has zero curvature at
the straight edge and matches the core circle's curvature at the arc.
This is geometric G2 continuity. The turn is one fixed proportion of
`--radius-dock`, so the token alone sets the corner and the geometry cannot
restate it. Upper corners and lower concave shoulders are mirrored instances of
this same construction. It follows the continuous-corner principle, not a claim
to copy Apple's private shape parameters. Corner dimensions stay fixed as content grows.
There are no overlapping shoulder pieces, stretched masks or opacity fades.
The left toolbar is a separate floating surface with 12 px outer corners and
16 px of canvas clearance; it has no attached shoulders. Toolbar and Send/Stop targets inherit shadcn Button's 8 px corners;
color choices use the same square target with a smaller swatch inside. The
toolbar reserves 8 px around its controls and a fixed brush icon opens a compact
Drawing style panel. Small status dots and radio indicators
retain their distinct circular meaning.
During an active run, one light travels the edge of the whole dock: the
composer alone when the conversation is closed, the reading sheet and composer
together when it is open. It rises past the left foot, travels up the left
side, across the crown and down the right side at one pace in pixels per
second, whatever the dock's size, and sets past the right foot before it rises
again. Its strokes take their paint from a radial gradient centred on the
light, so it falls off smoothly along the edge with no ends, no blur and no
flares. Its progress is a fraction of the lap, so when the sheet opens or
closes the light moves with the dock instead of jumping.

The light is the dock's own edge lit from within, and it is never painted on
the canvas behind. The canvas is usually white paper, but anything can sit
under the dock, and a light centred on the outline borrowed its contrast from
whatever that was: measured across the edge on white paper, its pale core was
darker than the paper beside it, so it read as a hairline outline rather than
light, while over a black element it stood out. A light set apart inside the
dock fixed that but no longer followed the edge, so it read as a second, loose
border. Now every stroke is centred on the outline itself and clipped to the
dock, so it keeps only its inner half and follows the edge exactly, corners
and shoulders included. From the edge inward it is a darker step, a 1 px pale
line and a darker step, 3 px in all, so the line is the brightest thing on
either side of it on graphite and on glass, over any canvas. It is one cool,
nearly neutral hue. A faint trace of the same edge holds in any still frame.
It has no layout impact, fades when work ends, and holds still under reduced
motion, where the trace, stronger, remains as the cue.

`DockSurface` renders after the composer, at the dock level, and owns the
geometry of the composer fill, beneath the dock's surfaces, and of the light,
above them. It measures the dock and the composer: the composer occupies the
bottom of the dock, and the sheet is the rest. The composer's upper corners
square as the sheet's height grows past two turn reaches, so each frame of the
sheet's motion meets the composer without a notch.

Where the sheet meets the composer there is no line. The composer's body is
drawn from the composer's own top edge, the layout line the sheet ends on, so
both round to the same device pixel. Drawn from the dock's top instead, the
body followed the dock's sub-pixel position as the sheet moved, and a row of
the canvas showed between glass and graphite: a flickering white line on
paper. The sheet's glass draws its edge on its top and sides only, and the
Graphite rim's crown fades as the sheet arrives over it, so neither material
draws an edge along the seam. It draws in a layout effect
and updates every path synchronously during `ResizeObserver` delivery, before
paint. Resizing the input must not schedule geometry through React state:
that lets the newly sized surface paint with the previous outline for a frame.
These path writes change paint only;
they do not resize any observed element. `useCanvasInsets` owns toolbar
placement, overflow and header/composer reservations as one pre-paint layout
update; it observes the outer conversation container so the deeper scroll
viewport receives its notification in the same delivery cycle.

The September 17 follow-up made `--radius-dock` the single value for the
composer turn and the expanded reading surface above it. The corner was
previously a 20 px turn under a 22 px token while the sheet above it was 8 px,
so one surface showed two corner sizes. The silhouette now derives its footprint
from the token and the two agree by construction.
The updated build was visually checked at `http://127.0.0.1:5174` in 1000 × 800
and the narrow sidebar widths, including an expanded conversation and multiline
draft. Controls remained reachable, the reading surface met the input without a
seam, and no page errors occurred. The cubic endpoints still match their
adjoining straight/arc curvature, and the running light shares the exact fill
contour. The full browser suite passed. See the
updated contour and
verification record.

The next refinement applied that construction to both ends of the left toolbar
and removed the separate circular outline. It also removed the toolbar and
Send/Stop radius overrides, leaving shadcn's ordinary control radius as their
source. The updated production preview was visually inspected at 918 × 877 and
360 × 540, including selection, hover, square color choices and short-window
scrolling. Both outlines passed the rendered 32-endpoint curvature check;
all seven toolbar controls remained reachable. Five relevant browser tests
passed. See the toolbar verification.

Keeping session management inside the reading surface adds one step when the
conversation is closed. It keeps the resting footer focused on conversation
context, execution settings and submission.

## Interaction

- Individual tool failures remain in collapsed execution details with neutral
  disclosure icons and their original diagnostics. They do not create an alert
  in the response. The turn's reported outcome owns request-level failure.
- Conversation failures use a small alert icon, a readable summary and optional
  provider/HTTP context. Structured or lengthy diagnostics stay in collapsed,
  keyboard-accessible Error details with bounded scrolling. Plain, short errors
  remain readable directly. Raw errors are preserved in history; formatting is
  presentation-only and shared by live, restored and standalone failures. Only
  the summary is announced, never the full diagnostic payload. A provider error
  identifies the failing boundary without claiming its root cause.
- Sending opens the conversation and reveals the new request immediately. A request
  requiring an answer also opens the conversation. An unseen result received while
  closed adds an unread dot; opening it clears the dot. A failed task has an
  alert icon, and a disconnected send opens the model connection controls.
- The footer status trigger opens the reading surface. Its header owns the single
  down-chevron collapse action, so reading hierarchy stays visible while the footer
  remains focused on the current turn. At narrow widths it omits the redundant
  message icon.
- The session picker directly lists conversations with their selected state.
  Creating a conversation completes persistence, closes the reading surface,
  and focuses the empty input. Each conversation retains its own draft.
  Switching preserves artwork and canvas history.
- The request index is an ordered, keyboard-reachable list. Each row pairs its
  prompt with a status icon and text for working, complete, stopped or failed;
  status is never communicated through color alone. Running and failed session
  rows reserve the same right-side status slot as the selected-state indicator,
  so switching among concurrent conversations does not move the title or preview.
- Model choices use a direct radio list with a local LobeHub-sourced mark for each
  recognized model family. The 14px monochrome marks inherit text color in both
  the light menu and dark composer. Current model and effort appear in the footer
  trigger and selected options, without an additional summary in the popover.
  The footer shows the full model name and effort at normal widths; model names
  wrap in the menu when needed.
  Thinking shows its current value in one row and opens a menu of supported
  levels on request; adjusting either keeps the model popover open. Switching
  model retains supported effort, or selects the first value advertised by the new model.
  The selected value is immediately visible in the footer and Thinking row.
- During a run, session creation and switching remain available so independent
  conversations can progress together. Model/Thinking changes stay disabled for
  the selected run. Settings remain inspectable. At narrow widths the model trigger
  keeps only the selected model's mark, leaving room for progress and elapsed time.
- Only the active turn's ongoing operations animate. Stopped operations stay
  stopped when another run begins.
- Send and Stop share the stable footer. While a run is active, an empty draft
  makes the main action Stop; a draft keeps the main action labeled Send message
  and sends a follow-up once the provider reports its turn boundary. Before that
  boundary the action is disabled with a short readiness hint, while a separate
  Stop remains available. The follow-up is task-ID fenced internally and never
  becomes a second user-facing mode. The icon stays in place, uses native CSS
  feedback and respects reduced motion.
- A refused follow-up keeps its draft and shows its reason. A turn that ends
  before the follow-up reaches it, or that rejects the follow-up itself, refuses
  the command with that reason; the request keeps its own status, because a
  refused follow-up is not a failed request.
- Escape closes settings and returns focus to their trigger. Clicking another
  control dismisses settings without pulling focus away from that control.
- The small center handle uses a quiet horizontal bar for pointer discovery.
  It remains at a very low contrast at rest, becomes clearer only when the
  pointer is over the handle, and after a short hover a pointer-only tooltip
  says `Drag to move composer`.
  Keyboard focus is a separate, quiet focus boundary; it does not reveal the
  grip or tooltip. Its hit area sits on the top edge above the input row, so
  dragging never steals clicks from the draft.
  It moves the composer horizontally along the bottom. It
  clamps to a 20 px viewport margin, or stops 12 px clear of the settings
  corner when the corner shares its line, and supports pointer dragging plus Arrow,
  Shift+Arrow, Home and End keys. It changes presentation only; canvas and
  conversation data remain untouched.

## Style And Ownership

Tailwind CSS and shadcn/ui are the implementation foundation. Layout, typography,
spacing, colors, responsive variants and interaction states live in component
Tailwind classes. Button owns 32 px compact desktop targets, 40 px Send, and
44 px coarse-pointer targets. Textarea, Popover, RadioGroup, DropdownMenu, Tooltip
and Collapsible own common interaction. Menus do not contain nested Selects.

The conversation dock is an inline-size container so its responsive rules follow
the panel that owns it. Reading and menu scroll regions reserve a stable gutter;
transient menus use progressive `@starting-style` entry/exit states with the
existing data-state animation as a fallback, and all motion collapses under
`prefers-reduced-motion`.

The composer theme is an authoritative token scope. Dedicated
`DockSurface.tsx` owns the composer outline, measured in CSS pixels.
`dock-surface.css` owns its fill and animated contour stroke; `conversation.css`
owns the draggable handle and Send/Stop feedback. The SVG does not mask controls or add scrollable width.
Drawing-dock and engine layout CSS remain outside this component migration.

Visual review captures the full painted outline, including the SVG shoulders
outside the form's layout box and the grip above it. Use a page screenshot with
clearance around the composer; an element screenshot crops those features.
The normal reference is the 560 px composer at DPR 2 with an empty input.
Drafted Send and the 360 px compact layout are separate states: a draft enables
the filled Send face, while the narrow layout keeps the model mark and hides its text.

`ConversationDock` owns reading, expansion, progress and submission presentation.
App composes `SessionMenu` into its header and `RuntimeMenu` into its footer,
retaining runtime state and persistence ownership. One `runtimeMenuOpen` state
allows either the session picker or model settings. The model popover has one
explicit anchor at the input's top edge; it stays above the input and scrolls
within available height. A competing trigger anchor must not be registered.

User messages use explicit speaker labels and quiet right-aligned chat bubbles;
agent reading text stays in the unfilled reading column at the application's body
size and 1.55 line-height. The reading viewport caps at 360 px or 44 vh and
shrinks in short windows. Model rows are 14 px; secondary labels are 12 px.
Conversation titles use the remaining footer space and may truncate. Model and
effort labels use their natural width; the narrow trigger keeps only its model
mark, with the full values in its accessible name, title hint and menu.
Textarea sizing responds to width and
draft changes. The selection appears as one count. All non-submit controls
specify `type="button"`.

## Acceptance

| Standard | Boundary and result |
| --- | --- |
| Unambiguous expansion | The footer status target opens the reading surface; its header has the single down-chevron collapse control. Passed. |
| Safe session management | New conversation focuses the empty input; switching restores draft text without changing the canvas. Passed. |
| Visible execution settings | Keyboard changes Thinking; switching to a model with fewer efforts updates selection; outbound `turn/start` carries the displayed model and effort. Passed. |
| Stable action target | The target keeps one rectangle through idle, stop and follow-up states; a follow-up draft changes only its action and icon. Passed. |
| Honest follow-up | Before the turn boundary a drafted follow-up remains editable but Send message is disabled with a readiness hint; after it, the same Send message action delivers the follow-up internally. A refusal keeps the draft and reports its reason without marking the request failed. |
| Accurate progress | The selected run keeps model/thinking changes disabled while session creation and switching remain available; previous stopped turns have no working animation. Passed. |
| Result awareness | Sending opens the conversation immediately; the unread indicator still covers replies received after manual collapse and clears on reading. Passed. |
| Short-window reachability | 360 by 540 mouse and touch fixtures, long labels, a twelve-object selection, multiline draft, menu scrolling and hit tests. Passed; touch targets are 44 px. |
| Attached geometry | Fresh Chrome screenshots at DPR 2, 1440 × 900 and 360 × 540; inspected full frames and attachment crops. No midpoint waist, shoulder seam or distorted corners. |
| Toolbar overflow | Whole rows in a short window with a multiline draft; scroll to each of seven controls and open Drawing style. Passed. |
| Current regression | Conversation reading and microinteraction browser checks pass after the hierarchy refinement. |
| Current build | Type checking, extension type checking, native/unit tests and the development build pass. |

The September 16 geometry review first used isolated Chrome state. The installed
extension was subsequently rebuilt with `bun run build:dev` and its idle canvas
refreshed. CDP verified build `2026-09-16T06:13:17.218Z`, a 64 px toolbar and two
SVG surfaces; the actual installed screenshot was visually inspected. See the
delivery verification. Earlier native data-hash checks
and the full 54-test regression belong to the September 15 review.

Sending and stopping use a deterministic native-message fixture with the
production UI. No new live model generation was started for this UI refinement.
The visual review's working state is a deterministic development fixture. These checks establish
functional and visual behavior, not measured first-time-user learnability.

## Evidence

Current geometry review: visual audit, with fresh
full-frame screenshots, enlarged attachment crops and motion samples.
The following screenshots are from the earlier interaction review:

- Native canvas
- Native model and Thinking
- Native conversation
- Native session picker
- 360 px running state
- 360 px expanded task
- 360 px settings
- 360 px long conversation with touch targets

Reproduce with `bun run build`, `bunx playwright test`,
`bun test tests/*.test.mjs`, and `bun run build:dev`.
The full interaction regression is
`tests/browser/composer-interaction.spec.ts`.
