# Canvas chrome

The artwork is the canvas's primary figure. Its controls use stable locations
and a shared visual language, with separate regions for document context,
view actions, drawing and conversation.

## Placement and ownership

- `CollectionPanel` owns the application/library region: the expressive mark,
  visible product name and one collection toggle. The brand stays anchored;
  the toggle follows the region's trailing edge. The library title and count
  belong inside the expanded pane and disappear with it. A stable bookmark icon
  and always-visible `Collection` label identify the library at every width;
  opening fills the bookmark and applies the shared selected surface. The
  native hover label explains the next open/close action. `CollectionPanel` also
  owns listing, removal, imports and the single open state of the layout.
- `App` supplies document context and view-control slots. The current canvas
  picker and direct Time Machine entry occupy the editing region's header, beyond
  the library boundary. `WorkspaceMenu` owns switching, search and canvas
  actions; `HistoryBrowser` owns review, branching and recovery. Product
  identity is independent of the current document menu.
- `CanvasViewControls` and `CanvasFocus` occupy the right. The percentage opens
  Zoom out, Fit canvas and Zoom in. An 8 px gap on narrow panels and 12 px on
  wider canvases separates viewport adjustment
  from expanding into a full canvas tab or returning to the source page.
  The visible labels are Expand and Return; accessible names remain
  `Expand canvas` and `Back to page`.
- `DrawingTools` owns an independent floating toolbar, inset 8 px from the
  editor's left edge. Its rounded [Graphite surface](tokens.md#graphite-material) stays separate from both
  the browser frame and the Collection's paper edge. Anchoring near the renderer
  surface's origin avoids the stale right-edge clipping reproduced during native
  sidebar resize. Absolute positioning belongs to the editor column.
  The eight primary targets stay in a stable order, grouped by navigation,
  drawing/writing, media import and appearance. Shapes and style open to the
  right, into the editor. Excalidraw owns their state and behavior. Toolbar
  placement and overflow belong to `useCanvasInsets`, which publishes the
  header/composer reservations and then measures overflow in one synchronous
  pre-paint update. It observes the workspace, header and outer conversation
  container, rather than the toolbar it resizes. The inner toolbar viewport and
  SVG receive their deeper notifications in the same delivery cycle; selection
  placement observes that viewport rather than the resized peer dock. Initial
  layout measures before first paint, including when the scene mounts.
  The Shapes palette presents six compact icon-and-name choices in two columns,
  with trailing shortcuts replaced by a small check on the current tool. It has
  no redundant title or instructional footer. The rail reflects that tool's
  glyph. Reopening focuses the current shape; Tab follows the visual reading
  order, and the advertised keys choose tools while focus is inside the palette.
  The box-selection preference uses the same segmented control as Drawing style,
  with each mode explained in its hover title and accessible description.
  Both palettes use a 12 px trigger offset, leaving 8 px beyond the rail shell,
  and the conversation menu's Glass material. Drawing style groups
  properties through spacing, pairs the contextual title and scope on one line, and
  gives font-size presets a full row rather than shrinking their targets.
- `SettingsCorner` owns the bottom-left corner: one quiet 40 × 32 px control on
  the header's chrome backing, showing the signed-in person's 24 px round
  picture or initial on the corner's chrome backing, which keeps it legible on
  artwork without a shadow of its own, or a gear when signed out. It opens Settings, which grows
  out of it; closing Settings returns focus to it. When someone signs in, their
  picture lands here on `--ease-spring`. It shares the drawing dock's left edge
  and centres on the composer's footer line. Where the centred composer would
  reach it, it rests 8 px above the composer instead. `composerReachesCorner`
  in `useCanvasInsets` is the one rule, judged from widths at the composer's
  centre, so sliding never moves the corner and the composer's slide limit
  agrees with it in any order. `useCanvasInsets` publishes the corner's bottom
  offset as `--settings-bottom` and its right edge plus the composer's gap as
  `--corner-edge`, which the composer reads instead of inspecting the corner; `--chrome-floor` on the shell is the line the
  drawing dock and canvas notices stay above (16 px clear of the composer or
  the corner), and the composer's slide stops 12 px beyond the corner when the
  two share a line.
- `ConversationDock` owns the bottom-attached composer, conversation reading
  surface, runtime settings and the adaptive Send/Stop action. Follow-ups use
  the same Send message surface; steering remains an internal transport detail.

Drawing and conversation share graphite material and control corners. The
toolbar floats with 12 px outer corners, a 4 px inset and control elevation; only the
bottom composer uses the attached outline supplied by `DockSurface`. Each
retains its own region and interaction purpose. Choosing a tool does not move or submit a
draft, and sliding the composer does not move the tools.

## Material and hierarchy

The expressive mark and the always-visible Galta name establish product identity.
The mark has no extra centred slot or tile; its own SVG viewBox owns its optical
breathing room. The canvas name and Time Machine remain a related document context,
with lighter Time Machine typography at the same baseline. The product name is
retained at narrow widths rather than depending on recognition of an unfamiliar mark.
The header has no enclosing white card, elevation or horizontal dividing rule.
Collection is a sidebar page that participates in layout. Its 320 px column
extends from the top application region to the bottom edge, with a quiet paper
surface and one continuous dividing edge. The canvas editor occupies the remaining
column; its drawing dock and composer belong to that editor's bounds rather
than the whole browser window. There is no floating card, panel shadow or dialog
overlay. Brand/library and document controls share a baseline while retaining
their own spatial ownership. The document header moves with the editor, and
drag-to-place crosses a real boundary between library and editor. The panel
is a small reference library rather than a second history view: search is ready
on open, results are newest-first, an unobtrusive sort choice covers older
work, and only the first 60 cards render until the user scrolls or asks for
more. The durable index holds up to 1,000 URL references without turning the
canvas into a management dashboard. Clicking places a reference; dragging
chooses its position. References form a two-column masonry gallery with
complete, uncropped images. The wider library page uses three columns. Each
image fills its column at its native aspect ratio and keeps square corners,
without a card frame or permanent caption row. A provisional 4:5 ratio reserves
loading space. `CollectionGallery` measures image heights and puts the next
reference in the shortest column, retaining DOM and keyboard order. Appending
a batch does not rebalance previously measured references; container queries
own column count and ResizeObserver responds to loaded images and width changes.
Observer notifications coalesce into one animation-frame layout update. The
gallery's measured height is written outside observer delivery, with pending
work cancelled on unmount, so loading images and reopening a sidebar cannot
resize an observed ancestor during the same delivery cycle.
The library's `References` title row owns the sole visible total and ordering; search
has a thin focus-sensitive rule, with a matching count only while searching.
A description and one ellipsis appear over the lower image edge on hover,
keyboard focus or while its menu is open, against a restrained dark gradient.
The image and its target remain square. Coarse pointers retain the action
target; descriptions still follow hover/focus. Source and removal live in a
shadcn/Radix menu. Menu Escape returns focus to the target without closing the
library; successful removal returns focus to search. Source domains remain
available in tooltips and search rather than repeating beneath every image.

One registered length, `--collection-inset`, opens and collapses over the shared
200 ms panel duration and ease-out curve. The library column and header read
that same interpolated value; the document header cannot drift from the moving
boundary. The left drawing dock belongs to the editor column and follows its
edge with the same 16 px clearance during opening, closing and reversal,
without a separate transition or remount. The library edge remains straight;
the toolbar never joins it with a notch. The application region keeps a compact 224 px minimum when closed,
giving the Galta identity and labeled collection entry their own space.
Its fixed-width library contents fade and shift by 8 px, so cards do not
reflow on every animation frame. The engine measures its actual resized
container, preserving the working viewport across an open/close cycle.
Search receives focus on open. Escape inside the library or its application
control closes it and returns focus to the same control. A collapsed library
is inert and absent from the accessibility tree; reduced-motion preference
disables the transitions. Search, ordering and scroll position survive closing.

`CanvasChrome` composes shadcn Button and Tailwind utilities. Each semantic
group has one neutral backing: 72% canvas-paper colour with 14 px backdrop blur.
It blends into the blank canvas and softens busy artwork underneath. The document
backing hugs its contents; Zoom and Expand have separate small backings rather
than a common large plate. Menus retain their solid readable surface and menu
elevation. Hover, open and focus use the existing interaction tokens; keyboard
focus remains owned by `controls.css`, including its forced-colors outline.
The brand and collection toggle each use a small quiet backing while collapsed;
opening blends those backings into the continuous library paper, with a small
selected surface on the collection entry. The brand
does not move. The toggle stays 12 px inside the application region's trailing
edge, moving with the pane once it exceeds the compact minimum.

## Responsive behavior

The left dock uses 32 px targets on desktop and 44 px targets with coarse
pointers. Tailwind controls its vertical layout and spacing; CSS calculates
the attached geometry and available height from the measured header and
composer. Four task groups use 4 px within-group and 8 px between-group gaps.
The compact inset gives the rail a 40 px desktop width and 52 px touch width.
Hover, selected/open and keyboard focus use the graphite hover, pressed and
focus surfaces respectively, keeping the active tool distinct from a hovered one.
When the grouped dock cannot clear the composer, the inter-group gaps collapse
to the row cadence and quiet rules preserve the task boundaries. Short windows
scroll vertically in complete rows, retaining full-size targets.
At every width the dock reserves the composer's measured height, including
when the composer slides to the left with a multiline draft. One vertical
rule applies at every width: center where there is room, move upward enough
to clear the composer, and keep the header's clearance. Width alone never
switches the toolbar to another vertical anchor.

At browser content widths below 720 px, the two working columns cannot
both be useful. The library takes the content area as a page, moving the
editor out of view while retaining its width, scene and draft. The shared
header and collapse action stay reachable. Successful click-to-place returns
to the canvas; failed placement keeps the library available with its error.
While the editor is hidden, its document context and entire canvas view group
are unmounted, including open portals. Brand and the same collection toggle
remain available. Returning to the editor restores its controls.
The same visibility state is published through `CanvasVisibility`. Drawing
tools retain their geometry while hidden, but their palettes, style panel and
tooltips close so no editor portal floats over the library page. Search receives
focus on entry, including when a width change crosses the page breakpoint.
Unmounting an open Time Machine releases its document-navigation boundary as
well as preview resources, so returning from the library page cannot leave
canvas switching blocked by an invisible review.
The container query owns this page mode; the header follows its measured result.
These are narrow desktop browser side-panel states, not mobile layouts.

Header controls use compact 32 px heights and at least 40 px icon widths on
desktop; coarse pointers use 44 px targets. Names truncate before displacing
Time Machine, Zoom or Expand. Time Machine and Expand labels collapse to icons below
640 px, retaining accessible names and tooltips. The Zoom disclosure also
recedes at that width to reserve space for product and document names.
The mark's box stays at 20 px from the application edge. The canvas header has
16 px inner insets, with a 4 px leading inset below 640 px to retain all targets
in narrow browser panels. The collection entry retains its bookmark and visible
label in both open and closed states. Canvas context reserves both full-size
targets before truncating its name. If a large zoom percentage and coarse-pointer targets
cannot share one row, view controls wrap together to a right-aligned second row;
measured header height reserves their space. Layout, material, targets and motion states are owned
by Tailwind. `canvas.css` only registers the interpolated layout length; it
does not provide parallel header appearance rules.

`canvasBounds` reads the actual `.galta-workspace` editing column.
`canvasFrame` reserves the area from the editor's left edge through the dock's
right edge within those bounds when fitting
artwork or restoring a viewport. Selection actions observe the editing column
and dock so their buttons remain outside the library and tools. The composer
uses its parent column when calculating movement limits. Zoom belongs to the
top-right view group.

## Mark sizing

`GaltaMark` displays the expressive `galta-logo.svg` in a 20 × 20 px box in the
application header. Its tightly cropped `viewBox="80.22 96.18 252.88 228.74"`
and `object-fit: contain` preserve the silhouette's proportions, with no nested
tile. In dark forced-colors mode the black/white artwork is inverted so the
body remains visible. The canonical geometry and expressive/outline use cases
belong to [the mark contract](mark.md).

## Acceptance

The browser UI suite checks document/view grouping, long-name hit targets at
360, 480, 620 and 1440 px, mouse and touch reachability, open/hover/focus states,
and transparent-surface contrast over dark and patterned canvas images. The
contrast calculation composes alpha over black before measuring the conservative
text contrast bound. Forced-colors focus remains visible.

Independent dock checks cover 980, 620, 480 and 360 px, plus every tool at
360 × 540 with mouse and touch targets. Composer checks cover multiline drafts,
large selections, runtime menus and independent sliding. Time Machine, canvas
switching and viewport handoff checks exercise their existing behavior.

Collection acceptance is recorded separately in
`tests/browser/collection-panel.spec.ts`, which covers durable count,
click and drag import, removal, search and progressive rendering, actual
reserved editor width, animated intermediate frames, camera/draft continuity,
focus return, reduced motion and the narrow browser library page.
Frame samples verify that the document header follows the actual library edge
throughout the transition. Open and closed geometry checks keep the brand
anchored and the toggle inside its owning region. Portal teardown is exercised
with an open Time Machine followed by a successful canvas switch.

The application/library relationship was captured on 2026-10-14 in
`docs/evidence/collection-entry/collection-layout-1440.png`.
These use the local production
bundle with simulated extension services; they do not attest to an installed
Dia extension reload.
