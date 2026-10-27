# Selection interaction study

An interactive design candidate for the shared selection controls across
images, text, shapes, groups, videos, webpages, and multiple selections.
The initial webpage-only sharing study was superseded after the user's
feedback on fragmentation, the redundant Ask button, and unclear icons.

The global drawing toolbar and composer are outside this study's scope.
They use the original `DrawingTools` and `ConversationDock` components in
their original positions. The unified workbench experiment was withdrawn;
only selected-element actions and their export/share surfaces are candidates
for redesign. The user accepted the capsule direction on 2026-10-17;
`design-qa.md` records that acceptance and the local verification boundaries.

Run from the repository root:

```sh
bun install --frozen-lockfile
bun run --cwd apps/extension dev --host 127.0.0.1 --port 4317 --strictPort
```

Open `http://127.0.0.1:4317/dev/page-sharing.html`. The bottom review bar
switches between seven examples and the full canvas or 420 px side panel.
The `?reference` route renders the production capsule against the same fixture.
The main study retains the simulated Share flow; production uses real Export
and a saved-version webpage preview. Replacement and page-opening callbacks
on the disposable study are fixtures; production acceptance uses the actual
canvas entry and stored workspaces.

## Design candidate

The selection has one compact Glass capsule centered above its edge. A plain
verb names the primary operation; Export occupies the same position across
ordinary elements, with Share for a webpage. A light divider separates the
primary operation from delivery; the ellipsis holds less frequent actions.
The capsule uses the existing round radius and Glass material tokens. Its
measured width follows its contents and is clamped inside the canvas.

Export opens a small format chooser; the options explain original bytes and
canvas appearance without a separate title or introductory paragraph. Share
uses the same Glass material and compact UI typography. Native buttons follow
the ordinary Tab sequence; Escape returns focus through the existing Radix
popover. The group does not claim an ARIA toolbar or menu keyboard contract.
The existing composer remains the one place to make an agent request; no
second Ask button or decorative AI symbol is added.

| Example | Primary action | Delivery |
| --- | --- | --- |
| Image | Crop | Original bytes or canvas PNG |
| Text and shape | Style | Canvas PNG |
| Group | Ungroup | One PNG of the selection |
| Multiple images | Arrange | One PNG of the selection |
| Video | Play | Original video or its canvas cover |
| Webpage | Open | Local HTML or publish simulation |

These controls use the real CanvasScene selection, native cropping, style,
grouping, arrangement, video, and PNG export boundaries. Selection remains
a pointer into the whole canvas, not an agent context filter.

## Prototype boundaries

This directory is a development entry only. The accepted capsule is also
implemented in production `canvas/SelectionActions.tsx`; the publishing
simulation stays here. No installed extension, native service, user canvas,
or account is changed by this study. Existing
Tide assets from `site/footage` are reused; the HTML fixture is derived from
that footage's example page and embeds its existing images.

Downloads are real files. Publication and Aha Labs sign-in are simulated in
this origin's local storage. The visitor URL is local, and reads the last
explicitly published snapshot when loaded. Canvas edits do not silently
update it. Use Try an edit, the two webpage wording revisions in Time
Machine, and Prototype scenarios to inspect update, sign-out, failure, and
unpublish states. The history fixture concerns the example webpage only.
The composer does not call an agent. This is not a public publishing service.

Example switching deliberately replaces the disposable example canvas.
Canvas edits in this study are not durable; only mock publication state is
saved. It is not a place to import work that needs to be kept.

## Evidence

See the repository-root `design-qa.md`. Current screenshots are in
`output/selection-capsule-2026-10-17/`. Earlier screenshots and exported files
remain in `output/page-sharing-prototype-2026-10-17/`: `v2/` records the
rejected unframed row, and `v3/` the withdrawn workbench experiment. These
local, ignored files are evidence rather than installed product changes.
