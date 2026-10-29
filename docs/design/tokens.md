# Quiet Atelier

Galta is a quiet, precise place to make things. The canvas carries the work;
controls respond to an action; an agent carries the intention forward.

Closing popovers stop receiving pointer input immediately, while their visual
exit animation finishes. Their fading surface cannot intercept the next action.

The visual tone is **clear, spacious, composed and alive to the user's intent**.
The current foundation uses white, neutral gray and ink. Proportion, readable
type and responsive interaction give the workspace its ease; warmth is not a
requirement. Source images and marks made by the user retain their own colors.

The user rejected dark green as the overall brand direction, not green in
every context. A success indicator may use green when it communicates well;
that choice does not make green the brand color. Do not turn a contextual
color preference into a universal prohibition.

Tokens give related components a coherent vocabulary. Their values are the
current implementation, open to refinement through the rendered experience.
Preserve the intent—artwork takes precedence, actions are easy to find, and
the agent feels present when needed—while exercising judgment about color,
density and form in each context. Restraint should leave room for character.

## The experience these tokens describe

At rest, the artwork is the strongest thing on screen. A compact tool dock,
a bottom-attached composer with agent controls and one Time Machine entry stay in stable
positions. They look like instruments around a work surface, not cards in a
dashboard. The source website remains beside the canvas in the native browser
panel layout.

When someone acts, the relevant control becomes legible. A light icon on a raised
graphite target identifies the selected tool in the left dock; light gathering
around the dock identifies a running agent. Time Machine's ruler uses an ink tick within a symmetric
fan of neutral ticks, following the user's ruler reference. Ordinary hover
stays gray. Motion explains a transition and then ends.
A running agent is the one state painted in colour, and keeps a reachable Stop
button. Expanding
its conversation continues the reading path directly above the composer.

After an action, the interface settles. Reducing visible chrome must never
remove drawing tools, model/session/effort settings, conversation access or
history navigation. A small visual mark still needs a usable interaction area.

## Paper grain

The canvas paper is printed: `--paper-grain` lays a still, fine grain of ink
on the canvas field, at `--paper-grain-size`. It lies under the artwork. The
engine draws the artwork on a transparent scene (`viewBackgroundColor:
'transparent'` in `ExcalidrawCanvas.tsx` and `HistoryStage.tsx`), and the
paper and its grain are the engine adapter's background beneath it
(`excalidraw.css`), so no export, agent preview or Time Machine recording
carries the grain; each paints its own `--background`. Time Machine's
dissolving frame wears the same paper (`history.css`).
galta.art and the disk image's install window print it over their whole page
instead (`scripts/render-dmg-background.swift`).

It is one tile of noise whose alpha carries its strength, with no blending
mode and no motion: it is painted with the canvas field, not on every frame,
and adds no layer of its own. On an Apple M4 Pro Mac (Chrome on the GPU,
device scale 2), panning boards of 300 and 1000 images through the
media-capacity harness keeps the same frame times with the grain and without
it: median 16.7 ms, 95th percentile at most 17.6 ms. `prefers-contrast: more`,
`prefers-reduced-transparency` and forced colours set it to `none`.
galta.art wears the same token over its whole page.

## Glass material

**Glass** is a semantic material in the design system. It simulates the soft,
rounded edge of glass: the light perimeter and inner highlight suggest a curved
rim, the directional white wash suggests thickness, and the soft shadow gives
the surface depth. A neutral base and softened backdrop keep the content legible;
compact controls use a denser base than the larger conversation reading plane.
These properties change together through `glass-*` tokens. Radius, spacing and
placement describe a component's shape and remain separate from its material.

`glass-surface` in `tokens.css` is the one floating-surface recipe. `PopoverContent`,
`DropdownMenuContent`, `SelectContent` and `DialogContent` use it by default.
Consumers own layout, content and interaction; they do not opt into Glass one
menu at a time or repeat its background, edge, filter and shadow.

The selected-element capsule uses the existing `glass-surface` face, border,
filter and elevation from main; its Style and More popovers also use Glass.
The `selection-edge` and `selection-shadow` roles in `tokens.css` soften those popovers' boundary and
elevation while retaining the shared Glass face and filter. This scope does not
change global tools, the composer or other menus. Contrast, reduced transparency
and forced colors retain an explicit edge and no floating shadow.
Export changes the contents of this same capsule. The measured width follows
`motion-disclosure` / `ease-sheet`; the row enters with `ease-out` and a
`space-2` horizontal offset. Reduced motion disables both size and row motion.

| Surface role | Applications | Treatment |
| --- | --- | --- |
| Floating Glass | Canvas/model/action menus, drawing palettes, zoom, conversations, request navigation, select options, connection and confirmation dialogs, selection capsule and its popovers, notices and import feedback | `glass-surface`; engine context menus and toasts map to the same recipe |
| Reading Glass | Expanded conversation | Shared wash, edge, filter and elevation; `glass-base` permits more of the artwork to remain apparent across the larger reading plane |
| Persistent surfaces and fields | Attached composer, drawing rail, header backings, collection column, full-screen Time Machine, editable fields and controls inside a surface | Graphite instruments, chrome and neutral field roles; no repeated floating elevation or backdrop filter |

Each floating surface owns one filter. Its buttons, rows and fields use only
ink or interaction tints. High contrast and reduced transparency switch the
shared tokens to an opaque surface, a visible boundary, no wash, no blur and no
shadow; forced colors use system surface and text colors. Every consumer inherits
this treatment.

## Graphite material

**Graphite** is the dense, low-reflection material for dark interface surfaces.
Its charcoal base receives a faint light-to-shade wash; an inner highlight fades
through the rounded edge. Glass and Graphite share a restrained sense of depth,
while Graphite keeps an opaque base for readable controls over any artwork.

`graphite-*` in `tokens.css` owns the base, wash, edge, foreground and interaction
palette. `graphite-surface` is the CSS face recipe for the drawing rail,
compact help and video playback controls. Solid
primary buttons receive the same face through the `primary-*` roles. Inside
`data-theme="graphite"`, primary actions
invert to light controls; ordinary hover, selected and focus surfaces retain
the same wash. Keyboard focus uses foreground ink on the lighter face. Material
state selectors use the Button variant, which survives Radix trigger wrapping.
Text and icon opacity does not carry the material effect.

The attached composer and connection entry paint these same tokens through SVG
on the existing silhouette. A clipped stroke holds the highlight inside the
exact shoulder and crown curves. The wash uses sRGB and one constant
`graphite-wash-strength` in both renderers: constant alpha makes CSS's
premultiplied interpolation and SVG's straight interpolation agree. The drawing
rail adds `graphite-shadow` for close floating depth;
the attached composer has no exterior shadow. Radius, spacing, geometry and the
agent's working light remain separately owned.

Contrast and reduced-transparency preferences remove the wash and floating
shadow and strengthen the boundary. Forced colors use system surfaces, text and
explicit outlines; gradients and shadows never carry the only focus or state
cue. Marks, artwork, slider indicators and the agent light retain their own roles.

## Color roles

| Token | Value | Meaning and use |
| --- | --- | --- |
| `background` | `#F7F7F7` | Neutral canvas field and image-preview background |
| `surface` | `#FFFFFF` | Menus and floating controls |
| `graphite-base` | `#242424` | Attached input and footer; expanded conversation uses the light surface |
| `graphite-foreground` / `graphite-muted` | `#F5F5F5` / `#B5B5B5` | Text on the attached surface |
| `graphite-hover` / `graphite-border` | `#383838` / `#484848` | Local interaction and separation |
| `graphite-wash-strength` | 6% | One light and shade opacity, shared by both renderers |
| `graphite-light` / `graphite-shade` | White / black at the wash strength | Shared faint wash in CSS and SVG |
| `graphite-edge-light` / `graphite-edge-shade` | 14% white / 24% black | Inner rounded rim, fading from light to shade |
| `graphite-shadow` | Inner edge plus close neutral elevation | Floating dark instruments; the attached composer uses only its inner rim |
| `surface-glass` | 94% surface | Overlays through which content is only faintly apparent |
| `glass-*` | Shared directional white wash, neutral base, edge, blur and elevation | Glass material for reading surfaces and floating controls; density follows the surface role |
| `glass-hover` | 40% white | Glass hover tint; keyboard focus uses `surface-focus` with `foreground` ink |
| `chrome-surface` | 72% `#F7F7F7` | Small header backings that blend into blank canvas paper |
| `chrome-foreground` / `chrome-muted` | `#3B3B3B` / `#535353` | Header labels and supporting disclosure glyphs over the translucent backing |
| `chrome-blur` | 14 px | Softens underlying artwork within each header backing |
| `field` | `#F2F2F2` | Borderless editable fields and selection triggers |
| `surface-hover` | `#EEEEEE` | Pointer hover and secondary surfaces |
| `surface-pressed` | `#E5E5E5` | Depressed neutral states |
| `menu-selected` / `menu-hover` | 26% / 32% hover surface | Quiet current and hover tints; a small check carries the selection cue |
| `stroke-surface` | 1 px | Shared surface boundary |
| `foreground` | `#252525` | Primary text and icons |
| `primary` / `primary-foreground` | Graphite base / foreground | Solid action roles; invert inside the Graphite scope |
| `muted-foreground` | `#6B6B6B` | Supporting text, placeholders and history marks |
| `border` | `#E7E7E7` | Quiet separators and surface edges; not the sole signifier of an action |
| `border-strong` | `#A3A3A3` | Stronger boundaries and supporting ruler ticks |
| `accent` | `#EAEAEA` | Selected-control background only |
| `accent-foreground` | `#252525` | Readable selected-control ink and keyboard focus; distinct from errors |
| `accent-indicator` | `#929292` | Neutral agent activity cue (the working dot); never used for errors |
| `agent-light-line` / `-wash` | `oklch(.96 .018 258)` / `oklch(.56 .06 258)` | The agent's light: one cool, nearly neutral hue in two strengths, never a spectrum. It is the dock's edge lit from within while the agent works, and the mark around a change it made. From the edge inward it is a darker step, a 1 px pale line `agent-light-inset` (1 px) from the edge, and a darker step, `agent-light-band` (3 px) in all, so the line is brighter than either side of it on any surface; it is never painted on the canvas behind the dock. `agent-light-reach` (150 px) is how far along the edge it fades to nothing. The arrow to a change is drawn in surrounding ink, not in this light |
| `destructive` | `#B63832` | Errors and destructive actions, always accompanied by text or an icon |
| `field-invalid` / `destructive-wash` | 10% `destructive` over `field` / `surface` | A field holding an error; a destructive row or menu item under the pointer |
| `mark-ink` / `mark-paper` | `#000000` / `#FFFFFF` | The mark's own two tones. Artwork colours: no theme block may reassign them, and no surface colour substitutes for them |

`popover`, `ring` and the shadcn names are aliases, not independent palettes.
Separate the neutral foundation, the brand accent and semantic status colors
when judging a change. They serve different purposes and need not share a hue.

Connection controls reuse `primary`, `primary-foreground` and the attached
composer roles, including their shared hover and focus treatments. The native
invitation may include small artwork accents from the same `drawingPalette`
used by Drawing style; these swatches do not redefine control or brand colors.

The model popover places the account provider's mark beside its plan.
Connected status remains available through the trigger's title and explicit
assistive text. Connection actions and failures use visible text when attention
is required; the account mark does not pretend to be a status light.

Small text must meet a 4.5:1 contrast target on its actual surface. Meaningful non-text activity
marks target 3:1 against the canvas. Borders are deliberately quieter because
labels, icons, shape and position carry the control's identity. Do not turn
supporting copy pale simply to make the interface appear minimal.

The canvas picker follows the conversation menus' reading hierarchy. Search is a
compact field with a slightly stronger surface and darker icon on focus; its
input does not add another fill or ring. Canvas rows use medium-weight names,
small rectangular artwork previews and one unfilled check. Creation stays in
the header; archive and local-storage information share one footer, with
infrequent utilities inside its action menu. See [multi-canvas](multi-canvas.md)
for navigation, overflow and keyboard behavior.

## Typography

- **Display:** Georgia, 28 px, regular, only for the title of each Settings
  dialog view. Every other surface, including dialog body, rows and controls,
  uses the interface face.
- **Compact canvas identity:** The formal SVG mark with Galta in the native
  UI face, 14 px semibold with -.02em tracking. The product name stays visible
  at every panel width; its compact treatment fits the working header.
- **Interface:** Native system UI, Segoe UI, sans-serif. Model rows are 13 px;
  labels, session controls and composer footer 12 px; conversation and input text 16 px.
- **Technical detail:** SFMono-Regular, Consolas, monospace. It only appears
  inside expanded execution detail, code, and a page's file name in its browser
  bar.
- **Scale:** `--text-caption` 11, `--text-label` 12 (labels and compact actions),
  `--text-ui` 13 (rows and descriptions), `--text-body` 14, `--text-input` 16 and
  `--text-brand` 28 (display). Use these steps only, never framework sizes in
  between; a secondary line under a name uses the caption step.
- Conversation line-height is 1.55; other reading surfaces use 1.65 and compact controls use 1.4. Display
  tracking is zero. Long model and session labels truncate in the
  composer footer but remain available through tooltips, labeled controls and the menu.
- Fonts resolve locally. This system does not require a font CDN.

Canvas text is **content typography**, independent of the interface font.
New text defaults to bundled Liberation Sans, shared by the text tool and agent
creation. Font choices preview their actual faces. Existing artwork and explicit
font choices retain their fonts and measurements.

## Space, form and elevation

The spacing vocabulary is 4, 8, 12, 16, 20, 24 and 32 px. Floating surfaces use
12–24 px internal and external spacing according to their role. The canvas does
not acquire a permanent grid or decorative texture.

| Role | Definition |
| --- | --- |
| Ordinary control | 8 px radius |
| Menu | 12 px radius, derived from an 8 px control plus its 4 px inset |
| Floating panel | 16 px radius; notices |
| Small mark | `--radius-mark`, 2 px; tooltip arrow, color swatch |
| Attached surface | `--radius-dock`, 8 px; the bottom composer and the expanded conversation sheet it joins |
| Drawing dock | Floating Graphite surface, 12 px corners (`--radius-menu`), 8 px from the editor left edge; 4 px padding around compact controls and 16 px icons; 40 px wide on desktop, 52 px on touch; `--graphite-shadow` elevation |
| Selection capsule | Floating Glass with `radius-round`, the shared 1 px edge, 4 px inset around 32 px controls, 13 px primary label and 16 px utility icons; a 16 px inset rule separates their roles. 42 px high on desktop; touch utility targets grow to 48 px. Export uses the same shell. |
| Collection image | Masonry at native aspect ratio with 12 px gutters; square image and keyboard target; description appears over the lower edge on hover/focus |
| Composer | One filled SVG outline, mirrored continuous upper/lower turns of `--radius-dock`, 30° cubic / 30° arc / 30° cubic; G2 joins, flush bottom; up to 560 px wide |
| Expanded conversation | Light reading surface, 8 px top corners, joined to the input |
| Icon action button | Square target with 8 px corners, using the ordinary shadcn Button radius; includes toolbar, Send/Stop and color choices |
| Main action target | 40 px; 44 px for coarse pointers |
| Compact control target | 32 px for desktop drawing dock, footer, menu and selection-toolbar controls; 44 px for coarse pointers |
| Canvas picker preview | 56 by 40 px, 2 px corners (`--radius-preview`); touch increases its height to 44 px |
| Main icon / secondary icon / disclosure | 20 / 16 / 12 px, 1.5 px stroke |
| Agent mark | 14 px, inherited text color; selected model in the graphite trigger, account provider in the Glass footer |
| Model popover | 288 px wide, 12 px inset, shared conversation Glass material; only the model list scrolls |
| Model popover grid | `--runtime-menu-text-inset`, 30 px inside the menu inset; 14 px leading mark plus two 8 px intervals; compact-target-wide trailing action column |
| Account quota | `--runtime-usage-width`, 64 px; `--runtime-usage-stroke`, 2 px; read-only remaining value and neutral gauge |
| Time Machine ruler | 52 px tall (`--history-ruler-height`), plus three `--history-lane` (6 px) lanes when the canvas has other timelines; one `--stroke-surface` (1 px) tick per moment every `--history-tick-gap` (8 px, 10 px for coarse pointers) and `--history-session-gap` (16 px) more between sessions; ticks rise from `--history-tick-rest` (6 px) to `--history-tick-peak` (26 px) in a fan `--history-fan` (30 px) wide; trim brackets use `--history-handle-stroke` (2 px) and `--history-handle-cap` (4 px); overlapping compact hit areas choose the nearest endpoint |
| Time Machine timeline menu | `--history-menu-width` (280 px), capped by the viewport and inset by `--space-3`; shared Glass menu, local change title above caption-sized date |
| Page bar and object words | Every page's browser bar, in page pixels scaled with the page: `--object-label-bar-height` (40 px) on `surface` with a `border` edge, three `--object-label-dot` (5 px) `border` dots, the file name at the input step in the code face and a small window icon, both `border-strong`. Words at reading size: title row at the label step with a 14 px kind icon in `border-strong` and a caption-step tabular spec; caption at the UI step, two lines at most; both `muted-foreground`; shown from `--object-label-min-width` (160 px) of on-screen object width |

The icon stroke is one value, `--stroke-icon`, applied once in `styles.css`
to every icon inside a control. Lucide writes a `stroke-width` presentation
attribute of 2; a CSS declaration outranks it, so no call site passes a stroke
and no rule restates one. The dock silhouette uses the same property for its own
outline.

`styles.css` maps every control-scale radius name to `--radius-control`, so an
unadorned shadcn primitive is already correct: `rounded-lg` is 8 px, not a
panel radius. Surface roles opt out by name: `rounded-xl` for the attached
dock, `rounded-2xl` for the 16 px panel, and `rounded-popover` for a menu. A new component that has to
remember which radius name is safe has already lost the argument.

The header, including Time Machine, uses compact controls with at least 40 px icon
widths (44 px height and width for coarse pointers). Read-only review is the
canvas field with one camera-framed preview and the ruler; its ticks do not
encode edit count, time or change magnitude. See the
[Time Machine contract](time-machine.md). This is not a rule for shrinking other
buttons. Color choices use 20 px square swatches inside the 32 px compact target
(44 px on touch), named labels and a check for the selected color. The Drawing
style panel uses the menu radius and compact aligned rows with numeric
width and opacity readouts. Its selectors use the shared Radix Select, including
keyboard navigation, typeahead and nested Escape handling. Fields have a neutral
fill with no permanent frame; selected swatches use a check without another ring.
The Shapes palette is 240 px wide (`drawing-palette-width`), with two columns
of inline 16 px icons (`icon-small`), 12 px names and 11 px trailing shortcuts.
Choices use the 40 px standard target, growing to 44 px for coarse pointers.
A current tool's shortcut gives way to a check without changing the layout.
The Drawing style panel is 288 px (`drawing-style-width`), with 72 px label
columns (`drawing-label-width`). Both inherit Glass from `PopoverContent`,
with 8 px outer padding and
8 px beyond the rail shell (12 px from its trigger). The Shapes palette has no
visible heading. Style headings pair a 13 px name and 11 px scope on one line;
properties group through space rather than rules.
Numeric and hex readouts use `font-code`. Font-size presets occupy a full row
to retain 32 px desktop targets, and coarse pointers retain 44 px targets.
`DrawingChoices` owns the pointer-only moving selection, including mixed state
and keyboard focus, for both style and box-selection modes. Groups rest directly
on the Glass surface. One flat, neutral `field` selection uses
`choice-selected-surface` / `choice-selected-ink`, including number presets,
without another surrounding fill or inner shadow. Forced colors maps this pair
to Highlight / HighlightText. Swatch geometry and edges
come from `drawing-swatch`, `drawing-swatch-border` and the shared stroke tokens;
the actual artwork colors remain in `drawingPalette`.
The drawing dock uses four task groups, 4 px gaps within groups and 8 px gaps
between groups. When the complete grouped height cannot clear the measured
composer, group gaps collapse to the row cadence and quiet `graphite-border`
rules retain the boundaries. On short canvases the dock reserves complete rows and scrolls with snapping
to retain full-size, unclipped targets. The attachment curves retain their pixel
dimensions as the dock changes height; neither surface uses an alpha fade or a
stretched content mask.
The dock uses the composer's graphite interaction palette: `surface-hover`
for hover, `surface-pressed` for a selected tool or open trigger, and
`surface-focus` for keyboard focus. Its 4 px inset matches the difference
between the 12 px shell corners and 8 px control corners.

Floating Glass uses its shared edge highlight and soft neutral elevation. The canvas chrome
itself has no permanent elevation or enclosing frame. The library has one
continuous vertical boundary from application identity to the bottom edge.
One canvas-coloured frosted
backing per group protects contrast, while hover, open and focus provide a
temporary stronger surface. Document identity and Time Machine share one backing;
Zoom and Expand have separate small ones. The anchored Galta identity and
collection toggle use quiet backings while collapsed, blending into the pane
while open; the selected entry uses the shared pressed surface and a filled bookmark.
The bookmark and `Collection` label remain visible in both states at every width.
`CollectionPanel` owns one interpolated `--collection-inset` for
both the library column and document-header position. Its compact application
region has a 200 px minimum to accommodate the labeled entry; the canvas title
remains beyond that region or the expanded library edge. `CanvasChrome` owns
these shared Tailwind treatments on shadcn primitives. The necessary custom-property registration lives in
`canvas.css`; layout and appearance stay in Tailwind.
`graphite-shadow` gives the drawing rail its close elevation; `shadow-control`
serves other compact framed instruments; `shadow-floating` maps the engine's generic island scale;
`glass-shadow` owns Glass elevation for floating controls and conversation reading.
`glass-elevation` is its outer shadow alone, for the attached reading sheet: the
sheet draws its own edge on its top and sides, and its lower edge, the seam with
the composer, carries no line.
The bottom-attached input has no elevation shadow. Neither artwork
nor the canvas field receives a decorative UI shadow.

## State, motion and layers

- The ink pen uses `motion-ink-pace` (600 screen px/s), `motion-ink-lift`
  (60 ms) and `motion-ink-catchup` (6 s). Reduced motion sets the catch-up
  budget to zero. `layer-canvas-decoration` places decoration over the
  artwork, such as the agent's mark, above the editor's static canvas and
  below its pointer and selection feedback.
- Hover: neutral fill, 140 ms. Selected: graphite ink on a neutral field.
- Segmented choices share one sliding selection surface, with a 140 ms transform
  transition for pointer input. Keyboard input and reduced motion switch immediately.
  Font-size presets use a dark selection; the separate editable value has a light
  field and a `px` unit. Mixed or custom sizes leave every preset unselected.
- Focus: a neutral surface change, owned by `controls.css` and `surface-focus`.
  No underline, ring, shadow or layout shift. Compound fields and hidden-radio
  labels own the surface instead of painting both parent and child. Light and
  dark themes each define the focused fill; solid actions adjust their own fill.
  Slider handles enlarge. Forced-colors mode retains a system-colour outline.
  The canvas text editor and composer retain their insertion caret.
- Secondary actions use a neutral fill; there is no outlined-button variant.
  Menu depth comes from one shared shadow, without a second framed border.
- Popover transitions: opacity only, 200 ms with `cubic-bezier(.2,.8,.2,1)`.
  Select menus and tooltips open without a scaling or sliding entrance. Tooltips
  wait 450 ms initially and skip the wait when moving between nearby controls.
- Agent pulse: 1,800 ms on the working dot, only during an actual running
  state. The agent light travels the dock's edge at 150 px per second
  (`--motion-orbit-pace`), around the composer and the open sheet alike,
  with no blur. It fades over 480 ms when work ends and pauses while hidden.
  Reduced motion keeps the hairline still; forced colors draw it in
  `CanvasText`. Status text and Stop remain available without motion.
- Surfaces: the reading sheet slides out of the composer in 420 ms on
  `--ease-sheet` and settles back in 280 ms on `--ease-settle`. Disclosures open
  in 260 ms and close in 200 ms. Both use `Unfold`, which moves height from the
  height on screen so motion reverses midway; each use sets `--unfold-enter`,
  `--unfold-exit` and their eases from these tokens. Contents wait for the first
  `--motion-contents-lead` of an entrance and are gone by
  `--motion-contents-exit` of an exit. Following new output glides for 220 ms.
  Content that arrives while a region is still opening is followed over
  `--motion-follow`, at least, on `--ease-settle`.
- Showing a change: a flight lasts `--motion-flight-unit` per unit of its zoom
  path, between `--motion-flight-min` (420 ms) and `--motion-flight-max`
  (1,100 ms), and keeps `--locate-margin` (56 px) clear around the change. The
  mark around it draws in `--motion-mark-draw` (560 ms) and lives
  `--motion-mark` (1,800 ms).
- Settings: `--ease-spring` (a small overshoot) lands the signed-in avatar in
  the canvas corner over `--motion-sheet`; a code cell's caret blinks every
  `--motion-caret` (1,060 ms) and holds still with reduced motion.
  A refused code moves once over `--motion-feedback` (320 ms). Departing
  views fade over `--motion-view-exit` (40% of the disclosure duration),
  before the next view becomes readable. Both respect reduced motion.
- Time Machine: the ruler settles on a moment in `--motion-history-snap` (240 ms),
  a flung ruler slows with the `--motion-history-glide` (325 ms) time constant,
  playback steps every `--motion-history-step` (160 ms), a settled moment
  dissolves in over `--motion-history-dissolve` (140 ms), the camera reaches a
  change out of view in `--motion-history-follow` (420 ms), and travelling to
  another timeline rearranges the ruler in `--motion-history-travel` (360 ms).
  The controls arrive on `--motion-sheet` / `--ease-sheet` and leave on
  `--motion-sheet-exit` / `--ease-settle`. Reduced motion settles at once.
- Layer order: history → tools → context actions → conversation → notices →
  header → portalled menus. Excalidraw retains ownership of the scene and input.
- One menu surface: menu rows are 32 px with a 12 px inline inset, a 12 px
  radius, the menu elevation and a quiet destructive state in which the label
  and the shortcut both take `destructive` on a 10% wash. The selection
  overflow menu, the runtime menus and the engine's right-click menu follow it.
  A portal owns `--layer-popup`; a numeric `z-index` in a component is a defect.
- Nothing outside `tokens.css` states a radius, shadow, icon stroke or layer as a
  literal. A value that exists only at its use site cannot be reviewed, compared
  or changed once; `--radius-mark` exists because the tooltip arrow and the color
  swatch are the same small mark, not because 2 px is a
  number worth naming.

  Two values in `marks/` are stated outside the file, and both are decisions
  rather than magnitudes. The in-page mark's layer is pinned at the largest value
  `z-index` accepts (`PAGE_LAYER` in `marks/surface.ts`), because it has to beat
  arbitrary stacking in a document that does not contain Galta's own layer scale,
  where naming a `--layer-*` would imply an order that does not exist. The
  confirmation glyph's cut is a length in the glyph's own box
  (`GLYPH_STROKE` in `marks/glyph.ts`), because a screen-space edge would eat the
  silhouette at icon size; it is deliberately not `--stroke-icon`, which is a
  width for line icons. Every other mark token — ink, paper, ring and size —
  lives in `tokens.css` like any other control's.

Widths of 900 and 620 px are layout breakpoints, not a second token theme.
At narrow widths the composer uses the viewport minus 40 px. Menus are bounded
to that width and the available height above the input. Text and targets remain
readable. The input's `data-theme="graphite"` maps surface, text and border roles
to charcoal, off-white and neutral gray in `tokens.css`; the conversation,
canvas and portalled menus retain the light theme.

## Reserved space

Persistent chrome declares the space it occupies; nothing downstream inspects
the controls themselves. `useCanvasInsets` writes the measured composer and
header heights to the shell as `--composer-height` and `--header-height`, and
the dock, notices and fitting frame position themselves from those values.
The header lays out document and viewport groups itself. This is the same
contract as a display safe-area inset: one
number per edge, the shape of the reason swallowed. A component that measures a
sibling control to place itself has taken on an arrangement it does not own.

Two consequences:

- Before the first measurement, the dock derives header height from the compact
  target plus the 16 px top inset, matching both pointer modes. Once measured,
  `--header-height` owns the actual value. A first-paint estimate that matches
  neither the header nor its current targets is a second, wrong source of truth.
- `themeLength` reads a length token for geometry the DOM cannot measure
  directly, and fails explicitly when it is absent, exactly as `themeColor` does
  for colors. Breath between the clear editing area and the chrome is expressed
  in the spacing scale, so an inset can be looked up rather than rediscovered in
  a layout file.

The compact header measures 48 px with a fine pointer and 60 px with a coarse
pointer, including its 16 px top inset. Composer height follows its content;
consumers use the measured values rather than treating either surface as a
fixed-height toolbar.

## Implementation ownership

The single source is
[`tokens.css`](../../apps/extension/src/design/tokens.css). It owns colors,
typography, spacing, radii, shadows, common targets, motion and interface layers.

[`styles.css`](../../apps/extension/src/styles.css) maps those values to
Tailwind and shadcn. Dedicated canvas geometry and engine adapters consume them directly.
`controls.css` owns focus and common interaction treatments. Primitives do not
add their own ring utilities; the engine adapter removes native focus shadows
before applying that same treatment.
Tailwind's base spacing unit maps to `--space-1`, so spacing utilities and
imperative component geometry use the same scale. Its explicit source root is
the stylesheet's `src` directory; alternate build entry points must still scan
shared shadcn components, rather than generating partially unstyled controls.
[`excalidraw.css`](../../apps/extension/src/design/excalidraw.css) is the
engine UI adapter: it maps native control roles to the same palette, including
neutral success states, fields, focus and right-click menus. It does not modify engine code.
Every variable the engine's right-click menu reads is mapped there, including
`--popup-secondary-bg-color`, `--select-highlight-color`, `--color-danger` and
`--embeddable-radius`. The last one is never defined by the engine, so the
engine's own `border-radius` declaration on an HTML embed was dropped until the
adapter supplied a value. An engine surface that still shows a stock colour or
corner is an unmapped variable, not a styling preference.
[`theme.ts`](../../apps/extension/src/design/theme.ts) reads the background
for exported agent previews and recordings, which paint the paper's colour
themselves; the live engine draws on a transparent scene over the paper (see
Paper grain), so the UI and image context do not drift. Missing required values fail explicitly.

## Frontend foundation contract

Excalidraw + React + Tailwind CSS v4 + shadcn/ui, built with Bun, is the agreed
foundation. React owns composed UI; Excalidraw owns scene editing. Shared
shadcn components in `src/components/ui` own common control behavior, including
keyboard, focus and accessible naming. `components.json` points their theme
at this application's stylesheet. Tailwind utilities consume these semantic
tokens for component layout, responsive behavior and appearance. This follows
the [shadcn theme convention](https://ui.shadcn.com/docs/theming) and
[Tailwind theme mapping](https://tailwindcss.com/docs/theme).

New or substantially revised interface components, including review surfaces,
must compose these primitives and Tailwind utilities. Do not introduce an
independent HTML/CSS theme or duplicate generic buttons, popovers and sliders.
Specific scene geometry, artwork colors and the Excalidraw adapter remain valid
CSS/inline-style boundaries; they are not reasons to create another design
system. Composer, conversation, runtime controls and workspace
menus use Tailwind utilities on shadcn primitives. Button owns compact and icon-compact
sizes; Collapsible owns accessible activity expansion. `conversation.css` contains
the custom silhouette, outline flow and draggable handle. Component names used by
measurement and browser checks are hooks, not a parallel stylesheet. Remaining canvas geometry and engine
adapters are recorded above; they do not justify new control CSS overrides.

`src/components/ui` holds only primitives the product actually composes. An
unreferenced copy is not a foundation: it is a second, unreviewed implementation
of a control that already exists elsewhere, and it drifts silently. Add a
primitive when a surface needs it, not in anticipation.

shadcn supplies the component foundation. Galta's documented spatial relationships,
typography, density and conversation behavior remain the product design. Using
the library does not imply adopting a stock dashboard layout or Excalidraw's
default toolbar composition.

Geometry such as a viewport bound, an artwork's dimensions or a percentage
along a history branch is not a design token. Artwork colors, imported image
bytes and saved marks are not theme configuration. Do not rewrite them during
a theme change.

Two artwork colours are declared in `tokens.css` — `--mark-ink` and
`--mark-paper`, the mark's own black and white — so that the values the mark is
drawn with have one home. They are not part of any theme: no block may reassign
them, and no surface colour may be substituted for them. The mark is two-tone,
and a themed paper would make it a different drawing.

The [current interface contract](README.md) defines spatial relationships and
interactions; historical reference images do not constrain the palette. The user's
objection to a dark-green brand must not be recorded as approval to eliminate
every green status cue.

## Acceptance

Review the rendered app, not just this table. The canvas, drawing dock, runtime
menu, conversation and native context menu should appear to belong to one
system. Verify narrow-panel overflow, target sizes, keyboard focus, reduced
motion, text contrast and image-preview background at their actual boundaries.
Screenshots with fixture conversations establish presentation, not live Codex
inference. Browser-document drag tests do not certify native site-to-panel
transfer. The evidence report must distinguish these cases.
