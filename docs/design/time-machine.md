# Time Machine

The canvas keeps every state it has been in. Time Machine lets the user slide
back through them, see the canvas as it was, and take back what they want: the
whole canvas, the objects it lost, or one object as it was. Time Machine is the
name the interface uses; code, tokens and storage call the saved versions it
shows history.

## The model

- **Moments.** A saved version is one gesture (a pause of 650 ms), so the ruler
  shows moments instead: a burst of the user's edits until a pause of
  `EDIT_PAUSE` (10 s; longer while the next edit continues on the same
  objects, never past `EDIT_BREAK`, 2 min), one Galta request, one run of
  imports. A fork, a name and the current canvas always end a moment; a
  restore starts one that the next work in the same session joins; a moment
  that ends where it began joins the one before it in the same session.
  Every version belongs to exactly one moment, and Option-arrow steps through
  the versions inside one.
- **Multiverse.** The universe being travelled is a straight line: the path
  from the first moment to its last. Every other future grows from the moment
  it branched at as a strand above the line, following its most recent work;
  its own branches are strands above it. Strands take lanes left to right so
  they never overlap; a future someone chose (a restore, or more than one
  moment) takes a lane before a single stray moment, which shows as a bud at
  its fork when no lane is free. Travelling to another universe makes it the
  straight line.
- **Sessions and days.** A pause of 30 minutes (`SESSION_GAP`) starts a
  session, a wider gap. The first session of each day is labelled Today,
  Yesterday or its date. Ticks never encode time, change size or count.
- **Captions.** A Galta moment is captioned with what the user asked, from the
  conversation turn that was running when it was saved. A user moment is
  summarized locally from its changes (Moved 3 images, Drew 4 strokes, Edited
  text), with bound text following its container and arrows following their
  targets. Nothing is sent anywhere to describe a moment.
- **Names.** Any moment can be named from its caption. A name is metadata on
  the workspace (`namedVersions`) and never creates an artwork version; an
  empty name forgets it. Naming a version inside a moment makes it a moment of
  its own. Named moments carry a dot above their tick.

## Interaction

- Opening commits pending edits, then shows the current canvas under the live
  editor's camera, pixel for pixel. The live editor stays mounted underneath
  with its camera, selection, draft and undo stack; nothing here edits it.
  Keydown and keyup stay inside the dialog, including while naming. The stage
  declines engine shortcuts; Time Machine owns its keyboard navigation.
- The stage is the canvas: drag, the wheel and pinch pan and zoom it as on the
  live canvas. A click points at an object as it is drawn (a line or stroke
  along its path) and takes its outermost group, bound text and frame
  members; Shift adds to the choice. A past document takes no pointer, links
  in the past never open, and right-click does nothing.
- The ruler slides under a fixed playhead. Drag follows the pointer and a
  release glides on with its speed; a click seeks; the wheel and trackpad over
  the controls scrub. A scrub cuts from moment to moment; where it settles,
  the moment dissolves in, the camera makes the smallest move that shows its
  change if that is out of view, and a light traces the change once: Galta's
  light for Galta's work, ink for the user's.
- Keys: ←/→ one moment, Shift+←/→ one session, Option+←/→ one version, ↑ into
  another future that branches from the current moment, cycling through all of
  them in recency order; where nothing branches from the moment ↑ just entered,
  pressing it again goes on to the next future of the fork it left (else the
  nearest other timeline),
  ↓ back to where the user came from, Home/End, Space plays or pauses, ⌘Z
  undoes a cut, Escape leaves naming, trim, the choice, then Time Machine.
- **Compare** shows the current canvas while held, under the same camera.
- The caption's **timeline menu** lists every path's latest moment, including
  futures folded into buds, by its name, request or local change summary and
  date. Current canvas comes first; the remaining paths are newest first.
  Choosing one shows its tip. The caption says Current canvas, Current timeline
  or Other timeline; **Back** returns to the exact timeline and moment left.
  The menu owns its arrow keys and Escape, returning focus to its trigger.
- **Bring back N objects** takes back the objects the selected version has and the
  canvas no longer shows, or, with objects chosen, those objects, as one
  undoable change. Each returns as it was and as itself: one the canvas
  deleted is revived in its old place in the stacking order, one it still
  shows returns to its old state. Relationships are made whole: a label
  returns into its box unless the box has another, a caption into its group,
  an arrow to a target that stayed, a member into a frame it still fits; a
  relation to anything absent is dropped. A returning container keeps the
  labels and arrows still pointing at it. A returning connection removes its
  old reciprocal binding, and a box's existing label takes precedence over
  a returning label even when the box returns too. Arrows and labels the
  canvas still binds to a returning object follow it to its old place. N
  counts only objects that would change, so a difference in relations alone,
  which the canvas makes whole by itself, is none; if nothing chosen would
  change, a hint says so. With objects chosen, Bring back is the primary action
  and **Clear selection** returns to whole-canvas actions; Restore canvas is
  offered only with no objects chosen.
- **Restore canvas** makes the selected version the current canvas as a new version;
  the canvas it replaces stays as another timeline. A completed checkpoint in
  its ancestry seeds the next Codex thread fork, and the draft is copied to the
  new session. Restore and Bring back hand the stage's camera to the editor, so
  closing changes no pixel, unless what came back is out of view, which the
  camera then shows. After either action, focus returns to the working canvas;
  Bring back can be undone immediately with the canvas's native undo shortcut,
  without an extra click. Closing a review without adopting it focuses the
  Time Machine entry instead.
- **Trim**, beside the ruler, brackets a range of the travelled path with two handles: the
  session around the playhead, or, on another timeline, that timeline's own
  moments. Dragging a handle shows its moment. Each endpoint has a compact
  target; where they overlap, the closer endpoint owns the hit. Tab reaches Trim start and Trim
  end after the ruler; each is a native range control with arrow and Home/End
  navigation, bounded by the other endpoint. Focusing an endpoint brings its
  moment into view and outlines its handle. Done or Escape returns focus to the
  ruler. **Export video** records the
  range as the stage shows it, at an even step with its transitions, as MP4
  where the browser can encode it (else WebM); a live HTML document shows as
  its frame. Closing or removing the stage stops the recording and releases
  its tracks; an encoder failure is reported without downloading a video.
  **Cut** removes the range's versions for good when Time Machine
  closes, or if it is torn down; until then **Undo cut** (or ⌘Z) returns history
  and the playhead to where they were. The footer states this undo boundary
  before cutting and keeps the pending count and deadline visible afterwards.
  Cut and Undo cut return keyboard focus to the ruler. A range that holds the
  current canvas cannot be cut, with the reason visible beside the controls.
  A window still standing on a cut version saves from where
  its work continues. A teardown shares any in-flight cut write; if it fails,
  the canvas retains an error notice. The migration backup, a separate
  export, is not cut.
- **Play** walks the path, or the trimmed range, one moment per
  `--motion-history-step`. A seek, Compare, naming, hiding the page or closing
  pauses it.
- Pending imports or a running agent disable Time Machine. A newer head from
  another window rejects Restore and Bring back inside the database
  transaction; a cut does not need the head, which it never removes. A failed
  write leaves Time Machine open with the error. An
  unreadable version shows a notice; the rest of history stays reachable.

## Visual

The stage is a read-only Excalidraw laid exactly over the live editor's box.
The caption (title, then who, when, and timeline) and the controls float over
its edges on the chrome backing. The timeline picker and Back stay together
when the caption wraps. The picker uses the shared Glass menu and keeps an
inset from the viewport edge. Restore canvas, Bring back for a selection, and
Done are the contextual primary actions; Cut, the one destructive action, takes `--destructive`
and `--destructive-wash` under the pointer; the rest are quiet text buttons.

The ruler (`HistoryRuler`) keeps the user's reference: ticks only, rising and
darkening in a symmetric fan around the playhead. Other timelines are
`--stroke-surface` strands `--history-lane` apart above the line, rising from their fork with a
small round corner, each moment a short tick; like the fan, a strand is
clearer near the playhead and fades with distance, and the one under the
pointer is drawn in full. A travel glides every moment from its old place to
its new one in `--motion-history-travel`. The trim band is the hover surface
between two ink brackets (`--history-handle-stroke`, with short
`--history-handle-cap` ends). Keyboard focus draws a
muted baseline under the ticks instead of a focus surface. Reduced motion
settles at once.

## Data

Moments, the multiverse and captions are derived on open from commits,
snapshots and conversation turns (`historyMoments`, `multiverseLayout`,
`documentChanges`); nothing about them is stored. Cutting is `trimHistory`:
only the chosen versions go, less any another window has already cut; what continued from them continues from the
nearest version that stays, or from the earliest version the current canvas
keeps when the start is cut, so history stays one tree. Their names and
checkpoints go with them, each cut version leaves where its work continues
(`trimmedVersions`), and the storage write releases every snapshot and asset
no remaining version uses. `normalizeWorkspace` still turns retired
saved directions into names and drops retired clips and hidden marks on read.

## Verification

`tests/time-machine.test.mjs` covers change summaries, moment grouping
(including joins never crossing a session), the multiverse layout (including
thousands of moments), trim (including versions already cut), hit testing of
rotated strokes, and saving from a cut version;
`tests/history-timeline.test.mjs` covers ordering, naming, restore and taking
back with relationships, where a difference in relations alone counts as none. `tests/browser/history-browser.spec.ts`
covers, against the production build: pixel-identical opening and read-only
review with Compare and a selected live arrow; moments and Galta captions; reachable controls at 1440,
480 and 360 px; ruler drag, click and wheel; folded-strand hit targets and
keyboard access to every future at one fork, and to a lone future branching
from the current moment; the timeline menu's folded futures, keyboard isolation
and exact Back destination; travelling between timelines;
naming across reload; restore and the conversation fork; bringing back lost
and chosen objects with undo, and a moved box with the arrow bound to it;
cutting a timeline and a dragged range, with Undo cut; keyboard trim endpoints,
bounded range selection, the right handle of a single-moment range, and focus
return; video export, encoder failures and
teardown; failed and concurrent
writes, including a cut after the dialog is removed; an unreadable version;
hundreds of moments; playback; and legacy records.
