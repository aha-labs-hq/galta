# Canvas and browsing sidebar

The header contains the Galta wordmark, named canvas picker and one view action. The redundant
Canvas label and divider have been removed. In the sidebar, expand opens a full
canvas tab. In that tab, the sidebar icon returns to browsing with Galta alongside
and closes the temporary full canvas tab after the sidebar has received the state.
Both paths carry the current project ID. The browsing window remembers its
chosen canvas across source tabs; full canvas tabs keep independent identities.
See [multi-canvas](multi-canvas.md) for project switching, which is distinct from
changing the view of the same project. The acceptance below predates that feature.

Switching saves the document and draft, transfers selection, and preserves the
center and shorter-edge world span of the clear editing area. The receiving view
measures its header, tool dock and composer. It adjusts the camera for available
space and for Chrome's opening resize, then consumes the one-time URL viewport.
Refreshing subsequently uses the saved camera. This replaces the old behavior
that reused a wide canvas's left edge and showed an apparently empty sidebar.

The same clear-area camera survives an account reconnect that replaces the
compact connection surface with the composer. Ordinary draft growth keeps the
artwork stationary. Expand also saves the source document's reading position;
Return restores both scroll axes after the reopened sidebar has finished layout.
A replaced document or changed URL owns its new position. This short-lived page
view belongs to the window's existing canvas-tab address and is retired with
that tab. Pages without extension integration still support canvas navigation.

The global browsing panel must be closed by window when expanding: disabling
the destination tab alone leaves the panel visible in current installed Chrome.
Independently closing the sidebar through browser controls is a host operation;
it can clamp a page's horizontal overflow as the source becomes wider.

If the browsing tab no longer exists, return reports that fact while keeping the
workbench usable. A failed panel open leaves the canvas available for another
explicit attempt. The browsing panel is global to its window and always uses
the manifest's stable `sidepanel/index.html` entry; scene, draft, selection and
viewport handoff travel through session storage and a channel, so changing or
closing tabs does not create a second panel document.

The extension action has a host-capability boundary. Hosts that expose a usable
Side Panel context open the stable browsing panel from the action icon. Embedded
browsers without that context open `canvas/index.html` in a focused full-width
tab instead. If a native panel open rejects at runtime, the same action falls
back to that full-width tab. The worker explicitly disables Chrome's persistent
`openPanelOnActionClick` routing so unsupported embedded hosts cannot intercept
the action before the fallback runs.

## Acceptance, 2026-09-16

| Criterion | Evidence |
| --- | --- |
| Header is concise and the view control remains reachable | Production UI test at 980, 620, 480 and 360 px; actual Chrome screenshots. |
| Original browsing tab remains usable after return | Actual installed Chrome expanded from the new browsing tab and returned to the same tab, twice. |
| Closed source does not trap the canvas | Original source ID was absent. The installed control created a new browsing tab, opened the native sidebar and closed the canvas. |
| Side panel failure does not lose the canvas or create repeated tabs | Mock Chrome boundary test rejects panel open, preserves the draft/artwork and verifies one created destination across two attempts. |
| Unexpected host errors stay visible | Mock tab-service error produces no tab creation or removal. |
| Same working content and draft in both views | Actual Chrome transferred five selected objects and a draft; a draft edited in the full canvas reappeared in the sidebar. Test draft was removed afterward. |
| Camera has no cumulative drift | Actual 360 × 834 sidebar → 1630 × 860 canvas → sidebar: clear-area center `(953.454286, 435.617245)` and span `1256` matched across all three. Browser regression also covers 386 → 360 px resizing and reload. |
| Artwork, history and runtime survive | All 92 snapshot hashes matched before/after; runtime defaults matched. |
| Real installed files are updated | Both views report build `2026-09-16T07:56:28.626Z`, built into `apps/extension/dist`. |

Checks: `bun run typecheck`; eight focused tests in
`tests/browser/reference-arrangement.spec.ts`, plus the responsive drawing-control
test in `tests/browser/ui.spec.ts`. The viewport regression was rerun after its
return fixture was corrected to carry the same selection, as the product does.

Installed evidence: full canvas,
sidebar,
round-trip receipt, and
closed-source receipt.
Chrome CDP supplied actual clicks, DOM state and rendered screenshots; visual
review also inspected the whole browser window through native accessibility.
Panel-open rejection is simulated; no claim is made of inducing a Chrome fault.
This pass does not rerun image generation or the full Pinterest import suite.
