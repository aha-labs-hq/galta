# Galta interface contract

This document owns the current interface rules, with focused contracts linked
below for design tokens, canvas switching, the composer and Time Machine. Verify
these rules against the rendered product and its browser tests. Historical
images are evidence of their recorded revision, not current design requirements.

The source website and canvas remain available beside each other. Full-canvas
focus is an explicit view change with a return path to browsing.

## Design language

[Quiet Atelier and the design tokens](tokens.md) describe the design intent
and current implementation: palette, material, typography, spacing, controls, motion and
ownership. The user rejected a dark-green brand direction, not every use of
green; status colors remain a contextual design decision.

Glass is the shared material for reading surfaces and floating controls. Its
edge light and directional wash suggest a rounded glass rim and thickness. Menus,
palettes, select options, the Settings dialog and contextual feedback inherit its
directional wash, edge highlight and elevation from the design tokens. The
shadcn primitives use the same recipe by default; content and layout do not own
separate material variants. Each surface applies blur once, with opaque
treatments for contrast and transparency preferences. See the
[Glass material contract](tokens.md#glass-material) for surface roles and ownership.

[Graphite](tokens.md#graphite-material) owns dark instruments, solid primary
actions, compact help and video controls. One opaque base, faint wash and inner
rim connect them. The attached composer paints that rim on its existing curves;
the floating rail adds close elevation. Geometry and the agent's working light
keep their own owners. Contrast preferences preserve explicit boundaries and
readable foregrounds.

[The Galta mark](mark.md) owns the logo's shared silhouette and its two forms:
the expressive character used inside the app and for web collection, and the
refined transparent outline used for extension/plugin icons and browser tabs.
It also owns the trimmed artwork box, the face
frame, the expressive mark's two tones and its protective ring. Web collection is implemented as a shared
storage contract and a canvas side panel; the mark document records its source,
provenance, confirmation and placement rules. Production components and the
shared SVG own the implementation; collector checks reuse the canonical images
in `tests/fixtures`, with no design-draft dependency.

The [canvas chrome](corner-controls.md) owns the canvas identity rail, global
action group, view status and mark-sizing rules. Placement follows the user's
mental model rather than treating the four corners as four equal modules.

## Implemented interface rules

- The canvas is the dominant surface. Each canvas is an independent project.
  The header keeps the formal Galta mark, always-visible Galta name and collection
  toggle in application space. The canvas picker and Time Machine belong above the
  actual editing region and move with its boundary. The collection toggle
  follows the library's trailing edge and always shows a bookmark and `Collection`,
  identifying its purpose before hover. Its selected state fills the same bookmark.
  The `References` title and count live inside the pane and disappear on collapse.
  Collection opens the web-reference
  library as a docked sidebar page that reserves its own layout column;
  the editor, its right tools and bottom composer occupy the remaining space.
  In a narrow desktop browser panel the library takes the content area and
  returns to the canvas after a successful import. Its open/collapse motion
  preserves the working scene, draft and library browsing position. Images
  form a masonry gallery at native aspect ratios with square corners.
  Descriptions and a source/removal menu appear only on hover or keyboard
  focus; coarse pointers retain the menu target. The library title row owns
  the sole visible total. Separate
  Zoom and Expand/Return controls occupy
  the right; proximity and spacing express their relationships. Expand
  opens the sidebar's canvas in a full tab; Return restores the browsing sidebar.
  Its return icon depicts a sidebar rather than fullscreen. The view group and
  its portals, together with document context, unmount while the narrow library
  page hides the editor. Brand and the collection toggle stay available.
  The background is neutral light gray.
- Every page sits in a browser bar, the header of the webpage card in the
  user's Tide editing study (2026-10-27): a white strip on its top edge with
  three dots, the page's file name (or else its own `<title>`) in the code face
  and a window icon. The bar is part of the page: it is drawn in page pixels and
  scales with it, so it zooms with the page and never reaches what sits above,
  and the page's top corners square to meet it. A page, image or video can also
  carry its own words: a titled object has a quiet header above it (kind icon,
  title and spec, a page's layout width or a video's length), and a caption is
  one or two muted lines below. The words use the interface's sans face at
  reading size at every zoom and rotate with the object; below a 160 px
  on-screen width they are left out, and a narrow object drops the spec before
  the title. `ObjectLabels` draws the bar and the words inside the engine's own
  stack, above drawn artwork and under pages, videos and the selection, in the
  live canvas and in Time Machine. They take no input and never enter exports or
  captures. The agent names a deliverable this way instead of drawing label
  text.
- Drawing tools float 8 px inside the editor's left edge, keeping a clear gap
  from Collection in every open or closed state.
  Its eight targets are 32 px (44 px for coarse pointers), with 16 px icons and
  the standard 8 px control corners. Shapes and arrows share a right-opening
  palette with two columns of labeled glyphs and visible shortcuts. Its rail
  entry reflects the active shape; opening focuses that choice and the shortcuts
  work inside the palette. A fixed brush icon opens Drawing style. Both palettes
  use the conversation menu's Glass material and an 8 px rail gap (12 px from
  the inset trigger). Box selection
  and style choices share one segmented-control implementation; property groups
  use spacing, with single-line contextual headings and aligned numeric readouts.
  The Shapes palette uses compact inline icon/name/shortcut choices. Style and
  box-selection choices rest on Glass with one flat neutral selected surface,
  without nested cards or permanent tracks.
  Navigation, drawing/writing,
  media and appearance form four groups, separated by 8 px gaps. A 4 px outer
  inset keeps the rail 40 px wide on desktop and 52 px on touch. When space
  is insufficient, quiet rules retain those boundaries at the normal row
  cadence. Short windows scroll the dock vertically without shrinking targets.
  The dock shares the composer's Graphite material, with independent 12 px
  corners and close floating elevation instead of attached shoulders. Hover uses the
  graphite hover surface; selected tools and open triggers use the stronger
  pressed surface. Drawing state is owned
  by Excalidraw.
- Small neutral frosted backings protect header readability over artwork and
  blend into blank paper. The header has no enclosing frame or shadow; the
  library's quiet vertical boundary continues through the application region.
  Zoom and Fit open from the percentage; Time Machine stays with the current canvas.
  See the [canvas chrome contract](corner-controls.md) for material and targets.
- The composer's footer groups the conversation status trigger, model with Effort,
  and one action target. The trigger opens the reading surface; its header owns the
  direct session picker, New conversation icon and down-chevron collapse action.
  A running turn shows Stop without a draft; a follow-up draft keeps the same
  Send message action while the transport accepts it internally. Model owns a radio list, Effort choices and connection
  state in one popover above the input. It shares the conversation's Glass material;
  model choices sit directly on that surface. The provider mark appears once
  before Codex and its plan in the account row. A leading check and slightly stronger ink
  identify the current model. Effort is a quiet row with its
  current value; clicking it opens the supported levels in an ordinary menu.
  Text shares one reading column, with selection and account marks
  in its leading gutter. Effort stays close to the model list; a larger
  interval separates the single account row, with a small remaining-quota gauge
  at its end. Account data updates automatically.
  The model list
  yields height inside the popover while Effort and the footer remain fixed.
  Escape returns focus to its trigger. The
  canvas picker owns creation, search, switching, rename, duplication,
  archive/restore, permanent deletion of archived canvases, workspace
  import/export and backup access.
  Its container and action menu share the model popover's Glass wash,
  edge highlight and elevation through `PopoverContent`'s Glass surface.
  See the [multi-canvas contract](multi-canvas.md) for isolation and lifecycle rules.
  The [conversation reading contract](conversation-reading.md) owns turn
  hierarchy, request navigation, streaming, scroll intent and rendering boundaries.
  Long labels truncate and remain available in tooltips and the panel.
  The [names and context contract](conversation-context.md) owns naming,
  Codex project publication, draft previews and submitted context. Each
  message carries one viewport preview, or names the earlier preview when the
  document and view are unchanged; further visual reads use explicit agent tools.
- One charcoal composer attaches to the bottom edge, with curved shoulders.
  A small center handle lets the user slide its bottom attachment horizontally.
  The composer owns conversation expansion, current activity, Stop and agent
  settings; drawing tools remain in their independent left dock.
  Conversation expands upward as a light reading surface joined to the dark input.
  Running status shares the footer without adding height. Composer and menu styling
  uses Tailwind on shadcn primitives; a shared SVG draws the attached surfaces.
  Send and Stop share one fixed icon target. Sending opens the reading surface;
  while a run is active, the target shows Stop without a draft and keeps the
  Send message name for a drafted follow-up; unseen results after a manual
  collapse have a dot. New conversation focuses the input.
  The selection shows one count; it is where the user points, not the boundary
  of the request.
  There is no separate Conversation pill. Completed tool actions and ongoing
  activity are distinct; an ongoing action is not repeated below itself.
- Settings is one 400 px Glass dialog over the canvas, opened from the
  bottom-left corner (see the [canvas chrome contract](corner-controls.md)).
  One grammar serves every view (`setup/settings.css`, `SettingsParts.tsx`):
  - The root lists the account, Chat in Galta, Work in Codex or Claude Code,
    then Generation. These three entries share compact label-and-state rows,
    with no subtitles. Chat in Galta identifies its connected account; the
    external-app entry is optional, with no idle warning. Its detail view
    explains “Chat there. See changes on your canvas.” Root labels wrap fully
    on narrow screens. The external entry shows Connected only while an agent
    holds this canvas's lease. Generic **Connect an agent**
    entries open this root so both choices are visible. Healthy Mac runtime
    status belongs in Connection details; a missing or incompatible runtime
    stays beside the action needed to resolve it.
    Quiet Help and Privacy links below the root rows open galta.art's canonical
    support pages in a new tab. The connection detail explains that requests
    and canvas context go to the chosen agent, which can inspect the whole
    canvas and a shared webpage. Generation explains that prompts and reference
    media go to the connected provider before the user connects it.
  - Header: a 32 px bar holds Back (named after where it goes) and Close on
    one line; the display-serif title always starts below it, named after the
    row that opened the view, with one short description under it.
  - Rows: at least 44 px, growing to fit a description; a 20 px leading column of 16 px marks, the label and the
    state at the 13 px row step (a secondary line under a name at the 11 px
    caption step), the state on the trailing edge with a chevron when the row
    opens a view. Rows hover with `menu-hover`; a destructive row takes
    `destructive-wash`. Hairlines start at the label. The person leads the root list as
    its own group: a 40 px round avatar with name and email, or Sign in.
    In narrow panels, root rows put status below the label so destination
    names stay whole. Long profile names use at most two heading lines; the
    full name remains available to assistive technology, in its tooltip and
    in the name editor. Connected generation providers put their state below
    their name, leaving one Disconnect action at the trailing edge.
  - Actions: one 40 px full-width geometry with centred labels; graphite for
    the next step, field for the alternative, destructive only for the final
    delete. A destructive action that is not ready looks like any disabled one.
  - Fields are Galta's neutral, frameless `field`; focus changes the surface
    to `surface-focus` and an error to `field-invalid`, never the edge. A
    sign-in code is six such cells over one input (paste and one-time-code fill
    work, including codes copied with spaces); the active cell follows the
    input's selection, including arrow keys. Forced colors retains cell edges
    and a visible focus outline. The sixth digit submits a sign-in, a refused code marks the cells
    and shakes the row once, and deleting always takes a click.
  - Inline edits (the name, a provider key) unfold inside their row with
    Cancel and Save; Escape folds them before it closes Settings.
    Navigating focuses the new heading (or its input); returning to Settings
    restores focus to the row that opened the view.
  - Motion: the dialog grows out of the control that opened it
    (`--motion-sheet`, `--ease-sheet`) and sinks back into it. Views move as a
    stack: the last one clears in the first 40% of `--motion-disclosure` while
    the next slides 24 px and appears from 35% to 75%, so text never overlaps,
    and the dialog's height follows its content throughout.
  The Account view signs in to the shared Aha Labs account with Google or an
  emailed code, names the person, signs out and deletes the account after a
  fresh code. Signing in or out in one Galta page updates every open one.
- One Time Machine entry opens [Time Machine](time-machine.md): the canvas as it
  was under the user's camera, a ruler of moments with every other future
  branching from where it began. Browsing preserves the working editor;
  Compare, Bring back, Restore canvas and Trim are explicit, and moments can be named.
- Canvas chrome uses one quiet surface language. The top-left rail shows the
  supplied Galta mark and owns canvas switching; it uses a light neutral backing
  for document identity. Zoom, history and focus form a light action group in
  the topbar. The right tools and bottom composer share the graphite material.
  See the [canvas chrome contract](corner-controls.md).
- Responsive Excalidraw toolbars must never appear behind Galta's controls.
  Native context menus and text editing remain available.
- Selecting artwork raises one Glass capsule in the context-actions layer:
  `radius-round`, 32 px controls (48 px for coarse pointers), and a measured
  width centered 12 px above the selection. It moves below when needed and
  stays clear of the topbar, drawing dock, collection and composer.
  One named primary operation is followed by a short inset rule, a download
  action and an ellipsis. Image: **Crop**; text/shape/mixed selection, including
  groups: **Style**; multiple images, grouped or not: **Tidy**; video:
  **Play**; webpage: **Open**. Ungroup lives in More with Group and Delete.
  Cropping replaces the row with **Done cropping**. Agent requests stay in the
  existing composer; the drawing toolbar and composer keep their own layout.
- The capsule is 42 px high with fine-pointer targets and 4 px padding around
  32 px controls and the shared 1 px Glass edge. It uses 13 px type and the
  existing `glass-surface` face, filter and elevation from main. The named
  primary action uses foreground ink; the two utility actions use 16 px muted icons with full compact targets. The export
  action has an accessible name and tooltip. Style has no extra disclosure
  glyph; its pressed state identifies the open panel. Tidy runs immediately
  without opening another panel. Keyboard
  focus adds a contrasting inset outline. No new material recipe is introduced.
- With one output format, Export downloads PNG directly; preparation and
  download-started feedback stay on that button. Image, video and webpage
  exports offer a real choice, replacing the capsule's contents in place with
  a back arrow, **Original** or **HTML**, and **PNG**. The same Glass shell changes width
  around its center; its height and distance from the artwork stay constant.
  Viewport edges constrain its position. There is no second export surface.
  Natural row widths are measured separately from the moving shell, with
  `motion-disclosure` / `ease-sheet` motion and no motion when reduced.
  Original preserves image or video bytes; PNG shows the artwork together,
  including crops and page/video posters. HTML preserves the saved source.
  Tooltips explain the formats. The chosen format carries preparation and
  download-started feedback, and the choices stay available after delivery.
  Back or Escape restores Export focus; outside pointer or keyboard focus
  dismisses without stealing focus. A pending download retains its captured
  artwork when the selection changes, and its completion belongs only to the
  export step that started it. The Style panel remains anchored to the
  whole capsule with an 8 px gap; More aligns to its trailing edge. Webpage Open
  launches a separate, sandboxed preview of the saved version; its URL is local
  to this browser. Public publishing remains a development study, so production
  delivery is labelled Export. The ellipsis keeps replacement, rotation,
  grouping and deletion, plus alignment and distribution for multiple images.
  Tidy stays a single click on the primary action; it is not duplicated in More.
- The capsule is a named button group, with native Tab order. Existing Radix
  popovers own their opening, dismissal and return focus. Pointer opening
  focuses the revealed group without highlighting its first action; Tab enters
  the controls. Keyboard export entry focuses the first format directly;
  Shift+Tab reaches Back. A changed selection closes
  its old menu, and scrollable panels keep keyboard focus visible. Grouping,
  ungrouping, styling and deletion use native editor actions, preserving
  nested groups, bound text and undo. Popovers and the engine's right-click
  menu share Glass, menu radius, row height, inset and danger treatment. The
  capsule's own popovers share its closer elevation; other menus keep theirs.
  The model popover retains the conversation Glass material.
  An HTML preview draws inside a bordered 8 px surface, squared at the top
  under its browser bar, so a document on the canvas never reads as another
  artwork object: the engine draws no outline around pages and videos. Their
  internal renderer markers show no link badge and do not open the engine's
  hyperlink editor; using a page is a click on it, and Open lives in these
  selection actions.

## Visual acceptance

The [canvas and browsing switch contract](canvas-switching.md) records native
return behavior, viewport continuity and the installed Chrome acceptance.

The [bottom-attached composer contract](composer-notch.md) records its layout,
interaction criteria, native Chrome checks and regression results.

`tests/browser/ui.spec.ts` exercises the production controls at 980, 620, 480
and 360 px widths. It verifies tool reachability, no control overflow or composer
overlap, native toolbar suppression, context menus, field focus and return focus.
One case reads the computed radius, row height, elevation and layer of the
selection toolbar, its menu and the native context menu, so a stray Tailwind
radius name, an engine default corner or a hand-written `z-index` fails the
suite instead of reaching the canvas. The separate conversation component test
uses **fixture task states**, not live Codex generation; it verifies
expand/collapse and the Stop callback.

Inspect screenshots with finite UI animations completed. A visible transitional
frame or a record-count assertion alone is not evidence of a good final layout.
The source fixture tests coexistence in a browser document; it does not certify
native Pinterest-to-side-panel drag delivery.

The neutral-token verification record lists
this implementation's test boundaries and production stylesheet hashes. The
Dia check used the local production preview, not an installed-extension reload.
