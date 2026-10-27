# Galta product blueprint

## Product promise

Galta lets a person move from finding something on the web to forming a visual direction without leaving the flow of browsing.

The core loop is:

```text
browse anywhere → drag directly into the canvas → arrange visually → speak or draw → see the canvas change → revisit or branch
```

Galta is not a Pinterest client, a generic whiteboard, or a chat window attached to a canvas. It is a local creative workspace whose inputs happen to come from any web page.

## Product contract

### The browser is the source surface

The current web page remains visible on the left. Galta opens beside it as a browser workspace. The user may collapse Galta to restore the page to full width, or collapse the page to give Galta the full working surface.

The primary import action is dragging an image from the source page directly
onto the canvas. There is no intermediate capture inbox, context-menu capture
step or separate placement action. The Image tool also accepts local files.

There is no background crawling, source-specific API dependency, credential collection, or cookie transfer.

### The canvas is the primary surface

One canvas is one independent project. Its artwork, history, conversations
and drafts stay together. The named picker beside Galta opens recent
canvases and creates a new one directly. Returning restores the saved camera and
conversation; each remounted editor starts a fresh native undo stack while its
durable history remains. Import adds an independent canvas; archive is reversible.
The [multi-canvas contract](design/multi-canvas.md) owns the detailed boundaries.

The canvas stays quiet when idle. It contains visual references, freehand marks, text, shapes, connections, and generated directions. Chrome is kept at the edge of the experience:

The v1 canvas is implemented with **Excalidraw**. Galta uses Excalidraw for the proven
spatial interaction model, selection behavior, camera, pointer input, and
freehand tooling. Galta owns the product state around it: capture provenance,
Agent transactions, history commits, branches, and local persistence.

- the tool dock is compact and expandable;
- object actions appear next to the selection;
- source provenance is represented by a small glyph and revealed on demand;
- the Agent is a command surface and a temporary collaborator, not a permanent chat sidebar.

### Language and hand are equal inputs

Every important operation can begin with direct manipulation or language.

Examples:

- draw a circle around three references, then ask Galta about the selection;
- say “把圈出来的参考变成三个方向” and let the result materialize on the canvas;
- use Pen, Marker, Lasso, Eraser, Text, Shape, Connector, or Image directly;
- select a group and ask for a layout, grouping, comparison, or refinement.

The command bar is always available in a quiet form. It becomes active only while the user is speaking, typing, or waiting for a run.

### Time Machine supports creative decisions

The working canvas has one Time Machine entry. It shows the canvas as it was,
under the user's own camera, with read-only canvas gestures. The user
recognizes their work visually.

- browsing never replaces the working editor or changes its camera, selection or undo;
- the ruler shows moments the user recognizes (a burst of edits, one Galta request
  in the user's words, one import), and every version stays reachable inside them;
- the universe being travelled is one line; every other future grows from where it
  branched, and the user can travel to it;
- the user can name any moment; names are the only bookmarks;
- comparison shows current work in place of the selected canvas while held;
- Restore makes a past canvas current and keeps everything after it;
- what a past canvas had and the current one lost, or any object pointed at, can be
  brought back;
- a range can be exported as a video or cut from history, undoably until the visit ends;
- every Agent mutation is reversible and attached to a history commit.

The user should be able to move through creative time without learning terms such as snapshot, commit, or branch.

### Runtime controls remain available

The bottom-attached composer keeps the active values in its footer:

```text
Conversation status trigger     Model / Thinking     Send / Stop
```

The conversation name opens the reading surface when closed. Its header owns
switching, creation and the down-chevron collapse action; a new conversation
closes the surface and focuses the input. Model opens direct model choices,
segmented Thinking and connection controls above the input's right edge. Escape
returns focus to the trigger. A running turn keeps one icon action target: it shows Stop
without a draft and submits a follow-up when one exists; the accessible name
identifies Steer, so follow-ups do not discard the current draft. Follow-ups entered during
turn boundary instead of being rejected. Independent sessions
can be switched or created while another task continues. Workspace import/export
and backup access belong to the canvas picker. Settings never submit a pending
draft.

While an Agent run is active, the command bar shows the user request, a restrained progress signal, and a stop action. It must always be clear what is running and which selection or page context it was given.

## Primary states

### Resting canvas

Canvas dominant, no selection, the drawing tools always available, a quiet bottom-attached composer with integrated agent controls, one quiet Time Machine entry.

### Direct import

The user drags an image or link from the current browser tab into the adjacent Galta canvas. The drop is translated into a Excalidraw asset at the pointer position and its provenance is retained in the local workspace for agent context. There is no capture inbox in the primary flow.

### Direct manipulation

The user selects, moves, resizes, draws, lassos, erases, annotates, groups, or connects items. Contextual actions appear beside the current selection. No global toolbar is opened for a local action.

### Agent run

The user starts a run from the command bar or a selection affordance. The run has explicit context, status, progress, stop, error, and completion states. Each successful tool mutation produces a reversible canvas transaction. Running status occupies the composer's footer without increasing its height. The conversation expands upward as a light reading surface above the charcoal input; commentary and tool activity remain in chronological order.

### Time Machine

The user opens Time Machine and browses actual saved canvases. Closing returns to the
untouched editor, or to the restored canvas under the camera the user chose. Restore is an explicit decision; it preserves the replaced
canvas and everything after it and carries the current draft into a new
creative session. With a completed checkpoint in the selected session's
ancestry, Codex forks from that turn when the next request runs. A name is a
bookmark, not an automatically created branch.

### Runtime menu

The user switches or creates a conversation from the expanded conversation header,
or changes model and Thinking in the footer's settings popover. Existing drafts
remain with their conversations. The canvas remains unchanged.
The next Agent run records the selected runtime in its commit metadata. Sending
opens the conversation immediately; completed results received after a manual
collapse get an unread dot, and questions requiring an answer open it as well.

## Scope for v1

### Included

- Chromium MV3 extension;
- current-page side panel with the shared canvas surface and full extension canvas page;
- direct image drag from ordinary image sites, without a capture inbox;
- local canvas with image, text, shape, connector, and freehand objects;
- lasso selection and contextual Agent entry point;
- Time Machine: local visual history, named versions and explicit continuation;
- `.galta` export/import;
- explicit runtime provider contract with visible conversation and model, and a Thinking control within model settings;
- thin Creative Harness that connects the full Codex app-server kernel to
  live Excalidraw reads, validated mutations and generated image presentation;
- image, video and speech generation with the user's own BytePlus, OpenRouter, fal or Higgsfield account, connected once in Settings and billed by the provider;
- Codex subscription connection through a one-time native bridge, with no API key or browser-cookie reuse. On macOS Dia uses `~/Library/Application Support/Google/Chrome/NativeMessagingHosts`; see the bridge instructions for current installation and platform limits;
- optional sign-in with the shared Aha Labs account (an emailed code or Google); it is identity only and never gates the canvas;
- static Cloudflare Pages site for install, privacy, help, and release notes.

### Deliberately excluded

- Pinterest, Behance, Cosmos, or other source APIs;
- background scraping or bulk extraction;
- server-side project storage or cross-device sync;
- multiplayer collaboration;
- hidden reuse of ChatGPT or another site's browser session, subscription, or cookies;
- silent Agent fallback between models or sessions;
- permanent large Agent chat panels;
- publishing or writing back to source platforms.

## Product invariants

1. A user action has one authoritative owner and one visible result.
2. A source is captured only after explicit user intent.
3. A canvas mutation is either committed as one reversible transaction or not applied.
4. Browsing history preserves the working editor, including selection, undo and camera.
5. Continuing from history is explicit and preserves every prior future.
6. The request decides the agent's scope. Selection is a loose pointer into the whole canvas and the bound page is context; neither is a boundary.
7. Runtime identity is visible before a run starts and recorded after it finishes.
8. Export/import can move a complete local workspace without a server.
9. Codex controls its native agent loop. Only validated canvas tool calls can
   mutate Excalidraw; ordinary conversational tokens never mutate the document.

## Acceptance gates

### Direct import

- From a generic image site, a user can drag an image directly onto the adjacent canvas and see it at the release position with its original aspect ratio.
- No cookies, passwords, or unrelated page data are persisted.
- One successful drop creates one image and one history commit, retaining the source link.
- Loading and failure are visible; a failed image never becomes an unrelated bookmark or a blank version.

### Canvas

- A user can pan, zoom, select, lasso, draw, erase, annotate, group, connect, and delete without leaving the canvas.
- The resting canvas has no permanently open settings or chat panel.
- All tool icons have keyboard access and hover/focus descriptions.

### Agent

- A run shows its request, context scope, active runtime, progress, stop action, completion, and error state.
- Each successful Agent mutation is one history transaction and can be undone
  or revisited. A run may contain several completed mutations; stopping it
  preserves those durable versions and rejects unfinished changes.
- A stopped or failed run cannot leave a partial, untracked mutation.

### Time Machine

- Read-only review never restores into the working editor or changes its undo stack.
- Restore preserves every saved canvas and explicitly starts a new future.
- Naming, renaming or unnaming a moment changes metadata only.
- Bringing back adds only what the canvas lost, or returns only the objects pointed at, leaving other objects intact, with one-step undo.
- Cutting removes only the chosen versions, never the current canvas, and only when the visit ends.
- A changed head in another window rejects a stale restore, bring back or cut.
- Closing review returns focus to the Time Machine entry without changing the draft or camera.

### Local-first

- Closing and reopening the extension preserves the workspace.
- Export followed by import reproduces the canvas, assets, history, branches, and runtime metadata.
- The product remains usable when the network and any Agent provider are unavailable; the local canvas and capture flow do not depend on either.
