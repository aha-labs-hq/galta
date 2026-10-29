# Distribution and lifecycle

Galta opens directly into a working canvas. AI is an optional capability of that
canvas, not an onboarding gate. This document owns the browser/Mac/plugin release
contract. Canvas storage, leases and agent tools remain owned by their existing
modules in [architecture.md](architecture.md) and [agent-architecture.md](agent-architecture.md).

## Ownership

| Module | Owns | Does not own |
| --- | --- | --- |
| Browser extension | Canvas, history, conversation, contextual AI connection UI; Chrome Web Store updates | Installing native executables or a second account store |
| Galta Mac app | Verified local runtime, browser registration, repair, Sparkle updates, MCP configuration | Canvas database or the user's global Codex configuration |
| Local runtime | Canvas bridge, Codex relay, MCP (canvas, webpage and generation), provider keys and generation jobs, bounded installation diagnostics, finding the user's Codex and downloading the pinned one when the user asks | A resident daemon or updater; changing a Codex the user installed |
| MCP plugin | A small connection manifest pointing to the installed runtime | Bundled engines, lifecycle scripts or its own runtime copy |
| Release tooling | One reviewed source revision, dependency checksums, target OS, identities, signing, notarization, signed update feed | Publishing automatically or substituting development identities |

There is one compiled Bun executable. Separate process roles preserve the current
transport and ownership model. A tiny native file-lock helper uses the OS's
`flock`; it does not require executable-memory FFI. All executables are signed and
all package files participate in the immutable release checksum manifest. Users
need no Bun, shell commands or PATH editing.

Codex is not part of the app. Chat in Galta runs on the user's own Codex, or on the
official package pinned in `distribution/dependencies.json`, which the runtime
downloads only when the user asks; see [Codex for Chat in Galta](#codex-for-chat-in-galta).
The canvas and external agents never need Codex.

The initial supported companion target is **macOS 15+, Apple silicon**. Existing
Linux developer installation remains available. Windows distribution and a
third-party plugin marketplace are not implemented or implied by this design.
Here, “plugin” means the existing Galta MCP connector and the browser extension.

## User journey

1. Add the extension. A Chrome Web Store installation opens a canvas at once, and
   the extensions menu opens Galta beside any page. Draw, collect images and save
   immediately.
2. A compact **Connect an agent** entry opens agent connection in Settings. Until AI
   is connected, the input, conversation selector and model controls stay hidden.
   Existing drafts are retained and reappear after connection.
3. The dialog checks the Mac installation. If absent, its next action is **Get
   Galta for Mac**, which opens the website's download page with the canvas step
   already done (`downloadUrl` in `distribution/stable.json`, `?from=extension`).
   The user opens the DMG, drags Galta to Applications and chooses
   **Connect browser**. There is no extension-ID input or terminal command.
4. Returning checks the connection again. Copy one set of connection instructions
   into any compatible local agent; there is no provider-selection step. The prompt
   uses the installed launcher and this browser tab’s stable target ID. Connection
   details also exposes standard MCP configuration. **Chat in Galta** is a
   separate choice in Settings; only that explicit action starts the existing
   ChatGPT account flow.
5. Closing the dialog returns focus to the AI entry, or the draft after connection. Nothing is submitted
   automatically. Chat in Galta remembers its opt-in for later
   visits; external connections follow their actual canvas lease. Failures never block drawing.
6. **Generation** in Settings leads to the user's own provider accounts.
   Each key is pasted once into the row it belongs to and checked with the
   provider before it is stored; Escape folds the field before it closes the
   dialog.

**Settings** is one dialog inside the canvas, opened from the canvas's
bottom-left corner or from whichever entry needs a connection; there is no
separate options page. It lists the optional Aha Labs account, agent connection
with the companion's typed status, built-in chat, and Generation, where
provider accounts are connected. The browser workspace owns account
connection state across canvas navigation.

Native registration, a working executable, an authenticated account and an actual
canvas operation are separate evidence. The Mac app says **Ready on this Mac**;
Connection Details calls the registration **Registered on this Mac**. Neither
claims to have checked a browser profile or completed account sign-in.

### Mac companion window

The Mac app is a small connection utility. The canvas remains the place to create
and manage accounts. A healthy home window offers the installed Chrome and Dia;
each opens the Galta canvas page in that browser (user decision, 2026-10-16).
Both the home and the menu offer **Get the browser extension**, the prerequisite,
linking to the website's download page.
The website owns current store availability and installation instructions. This
route remains available when a browser profile has no extension and refuses the
canvas URL; successful browser launch does not prove that the extension is installed.
macOS launches the browser when it is not running, and the browser shows the page
in a new window when it has none, otherwise in a new tab of its front window, in
its last used profile. The canvas page is named by the extension ID in the app's
bundled release, the same one the runtime serves. The Mac app reads no tabs or
browsing data and moves no canvas. It cannot open the side panel: Chrome opens an
extension's side panel only in response to a user action inside the browser. The
canvas page's **Back to page** is that action: one click puts Galta beside the page
last used in the window, in Chrome and in Dia (verified 2026-10-16). A browser
without extension side panels keeps the canvas a full page. The browser owns the final
extension and account check. Closing the Mac window does not stop browser-owned
work.

**Connection Details** is a separate native window (also Command-comma): runtime
availability, registration, standard MCP configuration, the version with its build
number, updates, and selectable failure diagnostics. Repair appears on the home window only for a diagnosed
installation problem. Clipboard success is reported only after a successful write
and resets after two seconds. No agent account or key is read by this window.

`installation.ts` inspects the bundled payload and the actual selected release.
`registration.ts` owns registration validation shared with the native host. The
app's `InstallationModel` owns one operation at a time and derives its presentation
from that typed result: first connection, current, update, repair, incompatible
installation, unavailable runtime, or failed inspection. A failed inspection
invalidates prior readiness and MCP configuration. Views never infer installation
from a saved preference. The saved preference records only the user's prior
connection authorization.

Startup and foreground checks are read-only. At startup, a newer payload may
activate once if the user previously authorized connection and the app is in
Applications. Reopening or focusing a healthy app never rewrites registrations;
a repair requires an explicit action. Installing from a different extension or
downgrading a distributed release stays blocked. No timer polls in the background.
Repair never writes into an immutable release. A selected release that is
missing or unreadable, or an installed runtime that no longer starts, needs
repair: activation sets a damaged copy of the same build aside and installs a
fresh one, and a different healthy payload replaces it as an update. When the
selected release cannot be read, the registrations' extension origin decides
identity; with no build to compare, that repair is not refused as a downgrade.
Only a `current` that is not a symbolic link is reported as unavailable, with
diagnostic details.

The SwiftUI utility uses macOS semantic surfaces, native controls and system type;
`Support/CompanionStyle.swift` owns its small layout vocabulary. It follows light
and dark appearance, without animating installation-state layout changes. Native
surfaces follow system contrast/transparency rather than copying web color values.
The home is one compact, 400-point-wide frosted window: the existing app icon,
Galta name and current Mac status share a leading identity row, and the next step
follows. Ready, that is the native browser buttons, which name the browser they
open, and **Get the browser extension**; other states add one sentence only where
the title and the action leave something unsaid. The window uses the system thick
material and a hidden title bar, retaining the traffic-light controls and a
draggable identity row, and fits its content. Connection Details opens from the
menu bar, the app menu and Command-comma, and from the home only where it is the
next step: an incompatible or unavailable installation, and beside **Check again**
after a failed check. Window-closing guidance lives in Connection Details.
During the initial check, the browser buttons stay in place; only the status
beside the icon shows progress. Opening a browser does not need
a ready agent runtime: the canvas remains available independently. Connection,
update and repair keep their action in place but disable it while working, with
progress reported once in the identity row. A healthy foreground check keeps
the ready state visible. No delay or cached readiness hides an inspection result.

The menu bar keeps the approved Galta outline as a monochrome system template.
Its native menu shows the same Mac status as the home, then the installed browser
shortcuts during the initial check and when ready. Both surfaces keep a healthy
foreground inspection quiet and show an inspection failure when it returns.
A second group opens the Galta home or Connection Details
and offers an explicit Check Connection; app updates appear only in configured
release builds, with Quit Galta last. Setup, update and repair states rename the
home entry to the relevant next step. Opening that entry never repairs or installs
anything; the home owns the explicit connection action. The app remains in the
Dock, presents its single home at launch, and retains the menu when windows close.
There is no background polling or browser-profile claim in the menu.

`InstallationModel` remains the single connection owner; shared status and browser-action presentation lives
in `Support/InstallationPresentation.swift`. `BrowserModel` owns browser-launch
progress and failure for both surfaces. A failed menu launch opens the home with
the same actionable error; it never retries or opens a different browser. The
menu uses standard macOS selection, separators, shortcuts and appearance, without
a custom popover, glass layer or additional runtime process.

Run `bun run companion:verify` for the native state lifecycle tests and
`bun run companion:preview` to build `output/companion-preview/Galta Preview.app`.
The preview compiles the shipping views with a test-only process adapter. Its
Preview menu exposes first connection, update, repair, failure and appearance
states, held checking/connecting/updating/repairing states, and high-contrast
appearances without changing system settings,
activating a runtime or touching canvas data. Browser buttons use the real
launcher with the extension ID passed to `companion:preview` (a placeholder ID by
default, which opens no real canvas). Menu Bar Preview renders the same menu content through an
application menu for accessibility and interaction acceptance, and Browser open
failure substitutes a failing launcher without contacting a browser.
Preview screenshots prove layout and interaction, not installed
browser connectivity. `package:mac` remains the one complete shipping build path.

## Runtime activation and recovery

The app contains one runtime application in
`Contents/Helpers/GaltaRuntime.app`, a lock executable in `Contents/MacOS`,
and launchers, the release manifest and licenses in resources.
The runtime's bundle metadata and code signature are part of every activated
release; activation must never extract just its executable. On connection it:

1. Validates the entire payload, including executable permissions, before any
   registration changes. Codex is not part of it: a Mac without Codex installs and
   connects its browsers like any other.
2. Acquires an exclusive kernel lock. Process death releases it automatically.
3. Recovers any interrupted activation journal, then checks every registration
   target before mutation. Conflicting extension identities and release downgrades
   are rejected rather than silently replacing another installation.
4. Stages an immutable, content-identified release under
   `~/Library/Application Support/Galta/releases/`. APFS clone copies are requested.
5. Journals the old registrations and release pointer, writes exact allowed
   extension origins, and atomically switches `current` to the complete release.
   A failed activation restores the prior state; a process interruption leaves a
   journal that the next connection repairs. Diagnostics refuse to report ready
   while that journal exists.
6. Still under the lock, removes every other release, and any temporary an
   interrupted activation left, that no running process uses: no executable path
   or command line names it. A release is renamed before it is deleted, so no
   launch can race the deletion. Cleanup never undoes a completed switch; the
   result lists `removedReleases`, or `cleanupError` when processes could not be
   listed and nothing was removed. Before that, a Codex the previous release
   bundled is kept for Chat when the user has none
   ([Codex for Chat in Galta](#codex-for-chat-in-galta)).

Registrations point at `current/Resources/galta-*`. A launcher resolves the real
release path once, before running. The Codex relay and the MCP server Codex
starts from it use that same immutable directory. An app update or a later activation cannot mix files
inside an already-running session. Canvas/history/account data are outside the
release directories and are never replaced by activation.

Standalone developer bridge installers refuse to overwrite a Mac app installation.
A selected release (including a broken pointer), pending activation journal or
companion registration reserves installation ownership for the Mac app. Update a
complete app and use **Connect browser** to repair all registrations together;
replacing only Canvas or Codex with `bin/` executables fails the companion check.

The Codex connection closes when its last UI client leaves and work has finished.
An explicit reconnect also refuses to interrupt an active task or login. The
canvas bridge retains its existing surface/lease lifecycle.

A release stays while anything runs from it, so live sessions never lose their
files. The replaced release usually still serves the browsers' running hosts and
is removed by the next activation once they have exited; only the selected release
and releases in use remain. The journal covers process interruption and ordinary
I/O failures, not a claimed power-loss durability guarantee.

## Codex for Chat in Galta

Chat in Galta runs on Codex; nothing else in Galta does. The runtime
(`native/companion/codex.ts`) reports the Codex Chat would use as `codex` in the
companion status and in the Mac app's inspection, beside the runtime's own health
and never part of it. The relay starts the first of:

1. `GALTA_CODEX_BIN`, when a developer sets it, whatever its version.
2. The user's newest Codex at or above the pinned version, from ChatGPT for Mac
   (`Contents/Resources/codex-cli`), Codex for Mac, `~/.local/bin`, Homebrew,
   `/usr/local/bin`, npm's usual prefixes (`~/.npm-global`, nvm, Volta, Bun,
   pnpm) and the host's PATH. Browsers start native hosts with a minimal PATH, so
   these places are checked directly, and a Codex runs with the directory it was
   found in first on PATH: an npm install is a `#!/usr/bin/env node` script whose
   interpreter sits beside it. A candidate must report `codex-cli <version>`
   within 5 s; an installation reached through several links counts once, as
   first listed, and runs as itself. `GALTA_CODEX_CANDIDATES` (colon-separated)
   replaces the list, so verification on a Mac with its own Codex can model one
   without.
3. Otherwise Galta's newest copy in `<data root>/codex/<version>`.

With none, **Chat in Galta** in Settings says Codex is missing, or that the
newest one found (the user's own, or Galta's copy after a newer Galta raised the
pin) is older than Galta supports, and offers **Download Codex** with its size. Nothing downloads without that click, and no account is checked before
Codex is there. The companion's `codex/download` starts a detached
`codex-download` worker that outlives the browser request. It:

- holds a kernel lock (`codex/.download-lock`), so one download runs at a time; a
  second request leaves the running one's state alone;
- fetches nothing when a supported Codex has appeared since the user asked;
- streams the pinned URL, hashing as it goes; more bytes than pinned, or another
  digest, is refused, and a minute without progress ends it so the user can
  try again;
- unpacks into a temporary directory and clears its quarantine: a browser
  starts Galta, so macOS quarantines what Galta writes as the browser's
  download, and Gatekeeper would stop Codex's first start to ask; the digest
  has already proved these are the pinned bytes;
- checks the official layout and that `bin/codex --version` reports the pinned
  version, then renames it into place;
- reports progress in `codex/.download.json`, which the browser follows once a
  second (status answers from it alone while a download runs), and leaves a
  failure there, with the step that helps, until the next attempt. A state nobody
  has rewritten for two minutes belongs to a worker that died, whatever process
  now has its ID;
- removes older copies that nothing runs from.

Galta only reads a Codex the user installed: it never updates, replaces or
configures it. The pinned version is both the oldest Codex Galta accepts and the
package it downloads. Newer versions are accepted; the no-cost protocol checks in
verification passed with Codex 0.165.0-alpha.1.2 on 2026-10-28.
A Codex that breaks Galta's app-server use surfaces as a Chat connection error;
raise the pin or adapt the client when that happens.

Mac apps up to 0.1.4 bundled Codex. When one updates and the user has no supported
Codex, activation keeps the bundled package, verified against the previous
release's digests, as Galta's copy before that release is removed
(`adoptedCodex` in its result), so Chat keeps working without a download. An
extension from 0.1.4 or earlier that meets a runtime without Codex receives the
relay's answer to every request: “Galta couldn’t find Codex on this Mac. Open
Settings › Chat in Galta to set it up.” The Mac app's Connection Details shows
which Codex Chat uses.

## Local file access and macOS identity

The runtime application owns local agent execution and its descendants. Its
bundle ID is `com.galta.runtime` for beta/stable and
`com.galta.runtime.development` for local builds. The executable stays inside
this bundle at the pinned release location, with the bundle metadata and sealed
resources intact. Certificate signing ties its designated requirement to that
identifier and signing team, rather than to a build's code hash. The package
receipt records this public identity and verification checks it after activation.
The display name and folder access explanations identify Galta to the user.
Codex, whether the user's own or Galta's copy, starts as the relay's child; that
macOS attributes its access to this application, as it did for the bundled
package, is checked with the clean-account procedure below.

Ordinary canvas and image work starts with the submitted artwork, the rest of the
canvas, the current page and the managed creative workspace. The shared agent contract discourages
unrelated home-folder scans; explicit local file tasks can still use bash and
expand their search when needed. This is task-scoping guidance, not a filesystem
sandbox or a guarantee that every model will follow it. Existing file import and
drag-and-drop flows remain available; no blanket disk permission is requested
during installation or connection.

macOS owns consent for Desktop, Documents, Downloads and other protected data.
Bundling, signing and notarization do not bypass that consent. A migration from
the old path-based, ad-hoc runtime may require a fresh grant for the new bundle;
Galta does not copy or modify the TCC database. Users can revoke grants at any
time. Before claiming persistence, validate a signed N-to-N+1 update in a clean
macOS account: consent under N, run the same access under N+1, and inspect the
TCC responsible identity and prompt log. Equal code requirements are a packaging
check, not by themselves proof that a real user's grant was retained.

HTML previews and their interactions run inside the browser's isolated sandbox;
they do not invoke the native runtime or read other applications' data. A
macOS **Data Access Blocked** notification naming GaltaRuntime can instead come
from an agent-invoked host tool, such as opening a browser preview. Diagnose it
by the notification's creation time, the matching tool call and the protected
application in the TCC log. Its consent belongs to macOS; repairing HTML preview
navigation does not change a host tool's permissions or require broader access
to other applications' data.

## Compatibility

The extension requires **Chrome 141+** for its canvas view-navigation APIs.
Chromium hosts that do not expose extension side panels open the canvas in a
full tab through the same toolbar action. The background owns that capability
decision and clears persisted browser-owned action routing on startup; canvas
storage and collection identity remain shared across both surfaces.

`packages/runtime/src/lifecycle.ts` defines protocol 1 and required capabilities
`canvas/1`, `codex/1`, `mcp/1`. The companion returns its release identity, channel,
capabilities and actual executable health, and since 0.1.5 the optional `codex`
availability. The extension validates the reply; unknown protocol versions,
missing capabilities and missing runtimes do not become a green connection. A
reply without `codex` comes from an app that bundled it. A `codex` the extension
cannot read (a newer Mac app's) concerns Chat only: it reads as `unrecognized`,
Chat asks for an extension update, and the canvas and external agents connect. It also verifies every native registration still
points to the selected release and the exact extension origin.

The companion host answers every request. A problem it finds comes back as a
typed `{ error }` reply (`{ ok: false, error }` for `media/settings`) whose text
names the cause and the step that fixes it: a registration or interrupted
installation needs **Repair connection** in the Mac app; a release replaced by an
activation during the request asks the user to try again. The background
translates Chrome's own native-host errors the same way: no registration means
**Connect browser**; a registration for another extension ID names a different
installation; a host that exits or times out without answering sends the user
to the Mac app's check. Settings shows that sentence as its instruction, and
Generation shows it in place of providers. Runtime commands report a failure as
one line on stderr, never the compiled bundle's source excerpt and stack; the
Mac app shows it under **What happened** and names a timeout, a killed runtime,
an exit without a reason and an unreadable reply itself.

Tool compatibility is checked separately from lifecycle protocol 1. The shared
canvas package derives a fingerprint from tool names, input/output schemas and
execution policy. Canvas registration validates it in both directions; embedded
turn startup and MCP bridge execution validate it before opening a task or
dispatching a tool. Missing or different fingerprints report an update error.
After changing this contract, update the complete app, activate its runtime and
reload the extension and open canvases. Reload source webpages as well if their
old content scripts were invalidated. Old tool names are not aliases for new ones.

App and extension releases are coordinated initially by a shared product version.
The wire protocol is independent of product version so compatible patch releases
can arrive in either order. A breaking protocol requires a compatibility window:
ship an app that supports both versions, update the extension, then retire the
old protocol after the supported upgrade window. Do not simply increment the
constant and assume mixed installations work. The current implementation
supports protocol 1 only.

## Distribution and updates

Chrome Web Store owns extension installation and updates. Galta uses Sparkle 2
for the Mac app rather than introducing a custom downloader/installer. Sparkle
is pinned by checksum. Distributed builds embed a specific HTTPS appcast and
Ed25519 public key, require signed feeds and verify archives before extraction.
Update checking uses Sparkle's standard UI; background installation is off by
default. Updating the app does not delete active immutable runtime releases.
When the updated app opens, the app compares its payload with the selected release.
Only a different, healthy payload with prior connection authorization is activated;
ordinary launches and focus changes are read-only.

`distribution/release.example.json` is the configuration schema example. Copy it
to an ignored `*.local.json` and supply real values. Store public key and extension
ID must match. The build number must increase. Production requires a clean source
tree, Developer ID, notarization and a matching Sparkle private key in the
keychain. No private key is written into source, command-line arguments or a
package receipt.

```sh
# Local engineering candidate. The ID is for your development extension only.
GALTA_DEVELOPMENT_SIGNING_IDENTITY='<certificate SHA-1 or unique identity>' \
bun run package:mac <development-extension-id> output/development
bun run package:verify output/development
# Also verify a model required by this release is in the pinned Codex's catalog.
bun run package:verify output/development gpt-6-astra
# Before releasing an update, compare two signed builds with increasing build numbers.
bun run package:verify-upgrade output/previous output/development

# Real release configuration, after source review and release prerequisites.
# The release extension id must be listed in the Aha Labs account service's
# EXTENSIONS (aha-labs-hq/account) first, or sign-in from that build is refused.
GALTA_DEVELOPER_ID_APPLICATION='Developer ID Application: …' \
GALTA_NOTARY_PROFILE='galta-notary' \
GALTA_NOTARY_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db" \
bun run package:mac distribution/beta.local.json output/beta
bun run package:verify output/beta
```

Every distributed version has release notes in
`distribution/release-notes/<version>.html`, an HTML fragment without a document
or body element; production packaging refuses to start without them. They are
embedded in the signed feed, so Sparkle's update window shows them.

The output includes the extension ZIP, Mac ZIP, drag-to-Applications DMG and
checksum receipt. The extension ZIP is reproducible: its files carry the source
commit's time in a sorted order, so one commit always zips to the same bytes.
Production also produces a signed Sparkle appcast with the
official generator; the signing key is checked against the public key embedded
in the app. Building publishes nothing.

The disk image opens on Galta's install window, a view onto the canvas in
galta.art's hand: Galta asks in the site's handwriting to be dragged in, an
arrow says where and a loop chooses Applications. Around them, in the faint
tone so the instruction stays the only dark thing, four small doodles show
Galta's moves at the window's edges: words that become a moon, a word with an
agent, a picture with the capture mark at its corner, a paper plane. They live
in the margin, most run past the edge, and none enters the instruction's field;
the drawing's generator refuses a layout that breaks these rules.
`distribution/install-window.svg` is that drawing, made with galta.art's pen,
and says where Finder puts the two icons.
`scripts/render-dmg-background.swift` lays it on the product's paper at 1x and
2x, with the `--paper-grain` token over it as on the site; Finder's SVG
renderer has no filters, so the grain is computed as SVG's `feTurbulence`
defines it, from the token's own numbers.
`dmgbuild` (pinned with its two libraries in `dependencies.json`) writes the
Finder layout without driving Finder and compresses the image with LZMA
(`ULMO`). It needs Python 3.10 or later (`GALTA_PYTHON`). Packaging mounts the
finished image and verifies the app's signature there. The app is about 64 MB,
nearly all of it Galta's runtime; the disk image is about 20 MB and the update
ZIP about 27 MB. Codex is not in them: Galta's copy, when the user asks for one,
is the official package as published (about 132 MB to download, 322 MB on disk).

`bun run release <output>` publishes a stable package. Its receipt is the
release's identity:

```sh
bun run release output/stable           # where the release stands; changes nothing
bun run release output/stable submit    # upload the extension; Google reviews it
bun run release output/stable publish   # after approval: make it public
bun run release output/stable withdraw  # before publication: take it back from review
```

`submit` uploads the extension ZIP through the Chrome Web Store API and asks for
review with staged publishing, so approval makes nothing public. The store reviews
one version at a time: `withdraw` takes a version still in review or staged back,
so a newer one can be submitted; its Mac files were never placed, and a live
version is followed by the next release instead. `publish`
uploads the DMG and update ZIP to galta.art and reads them back by hash. It then
publishes the staged extension and replaces the signed feed last; the feed it
replaced stays in the output as `replaced-appcast.xml`, and uploading it back is
the rollback. Last, once the store listing answers, it writes `site/release.json`
(keeping the `stage` the site calls the release by, which is set by hand),
deploys the site and checks the download page. It does this from a clean checkout
of `origin/main`, so no other site change is undone; commit that `release.json`
change afterwards. Then it exports the release's source commit to the public
repository, [`aha-labs-hq/galta`](https://github.com/aha-labs-hq/galta), as one
commit named after the release (`scripts/distribution/public-source.ts`); a
commit from before the public source has nothing to publish. Every step reads what is live first: a stopped command is run
again, and a published file is never replaced. The command schedules nothing;
run it without an action to see where a release stands. Listing text,
screenshots and visibility stay dashboard edits (`CHROMEWEBSTORE.md`).

Always specify the keychain containing the notary profile. Set `GALTA_NOTARY_KEYCHAIN` to that keychain. The shared profile is
`aha-labs-notary`; signing and update keys remain in Keychain.
Each submission records Apple's ID and result under the output's
`notarization/<attempt>/` directory, kept separately for every packaging attempt.
Waiting is bounded to 30 minutes. A timeout or
rejection preserves the candidate staging path and does not submit again.
Use `notarytool info` or `log` with that ID and the same explicit keychain to
resolve it before rebuilding. A failed candidate is never a published release.
Both the app and DMG must pass stapler validation and Gatekeeper before the
receipt is written.

Local candidates are explicitly named `local-candidate`; their updater is off.
The native executables still use hardened runtime and minimal JIT entitlements.
Local packaging requires an explicit development signing identity and never
silently falls back after a signing failure. For disposable tests only, setting
`GALTA_DEVELOPMENT_SIGNING_IDENTITY=-` explicitly requests ad-hoc signing; these
builds cannot validate authorization persistence. Their UI app omits hardening
because ad-hoc identities have no Team ID for framework library validation.
Certificate-signed UI builds use hardened runtime. Distributed builds always
require Developer ID and notarization; an Apple Development certificate is only
for local testing and is not substituted for those release prerequisites.

## Updating a development install

A Mac the app manages runs exactly one Galta: the extension and the runtime
come from the same commit, and only the current runtime release is kept. To
move it to `main`:

1. Recheck `origin/main` and the installed `current` release, since other
   sessions may merge or deploy meanwhile. In the main checkout, fast-forward
   to `origin/main`, then run `bun run setup` and
   `bun run typecheck`.
2. Package from a configuration file, not the bare extension ID, which builds
   number 1 and leaves the installed app stale:
   `{"channel": "development", "build": <installed CFBundleVersion + 1>, "extensionId": "<id>"}`.
   Run `GALTA_DEVELOPMENT_SIGNING_IDENTITY=- bun run package:mac <config> <out>`
   and `bun run package:verify <out>`.
3. Unpack the Mac ZIP with `ditto -x -k`, quit Galta.app, replace
   `/Applications/Galta.app`, run
   `/Applications/Galta.app/Contents/Helpers/GaltaRuntime.app/Contents/MacOS/galta-runtime install /Applications/Galta.app/Contents`,
   and reopen the app.
4. When no Galta task is running, run `bun run build:dev`, then at once open
   each browser's extension manager and explicitly **Reload** Galta. Check
   with `canvas_list` through the installed `galta-mcp`: a busy canvas is held
   by an agent turn or another MCP client. Building under a running Galta
   breaks its open pages until it reloads (`AGENTS.md`). A browser restart alone
   is insufficient: cached extension metadata or its service worker can remain
   paired with newly built page assets. Reload the source page, reopen the
   panel, confirm `.galta-shell[data-build]`, and check both the account status
   and the native connection in the installed page. If a browser restart is
   also needed, save its tab URLs and check they return afterward.
5. Start `current/Resources/galta-codex-bridge` with the argument
   `chrome-extension://<id>/` and check that `galta/config/read` returns the
   source's `galtaToolContract()`.

Then delete the package. After the browsers have reloaded Galta, run the same
`galta-runtime install` command once more: nothing runs from the replaced release
any more, so that activation removes it and lists it under `removedReleases`.
Confirm that one version remains: one `/Applications/Galta.app`, one entry in
`~/Library/Application Support/Galta/releases`, no `Galta/bin`, the
`com.galta.*` native messaging manifests in Chrome's directory (Dia reads them
too) pointing at `current`, the extension registered only from the main
checkout's `dist`, and no native binaries or `release` left in the main
checkout.

## MCP plugin

`plugins/galta/.mcp.json` resolves the stable installed MCP path. It no longer
requires shell PATH configuration. The Mac app can copy an absolute MCP
configuration for other clients. The plugin manifest remains independently
versioned, small and declarative; plugin installation never rewrites a user's
other MCP entries, credentials or global Codex configuration. Existing developer
installations retain a fallback to their managed `bin/galta-mcp` path.

## Release acceptance

`bun run test` typechecks extension, native lifecycle and release tooling and
runs transport/ownership/storage plus activation failure/recovery/concurrency
checks. Browser tests cover the optional composer flow, draft retention, Escape,
focus restoration, narrow layouts and drawing without AI.

`package:verify` checks the actual archives, deployment targets, code signatures,
UI framework loading, that the app bundles no Codex, isolated-home installation on
a Mac modelled without Codex, source-independent execution, the real native
messaging handshake, the relay's answer without Codex, **Download Codex** through
the companion (served the cached pinned archive; the digest still decides),
downloaded Codex initialization/configuration and MCP tool discovery. It checks the
complete runtime app signature and designated identity again after copying it to
the managed release and removing the source app. A local Responses fixture drives
the downloaded Codex through its code-mode host into bash and file search, then
checks their output.
The check runs after deleting the extracted app, so it also verifies that the
activated runtime includes every dependency. It does not sign in, use paid inference or certify a live
Chrome/Dia native connection. Store installation, notarized Gatekeeper launch,
a signed N-to-N+1 Sparkle update and a real browser/canvas agent task are required
separate release gates on clean machines.

`package:verify-upgrade` installs two real certificate-signed packages in a
disposable home. It checks that the new code satisfies the previous designated
requirement, the previous connection remains pinned and usable, a new connection
uses the new release, workspace data survives, and both installed bundles remain
valid after removing their source apps. On a Mac modelled without Codex it checks
that an app which bundled Codex hands it over (`bundledCodexKept`); a release
without Codex downloads the pinned package from the cache before it connects. It rejects ad-hoc signatures, changed
identities/channels and non-increasing builds. It does not exercise TCC or Sparkle;
its output explicitly records that macOS consent was not verified.

Optional model IDs after the output directory must appear in the downloaded
Codex's visible model catalog. The pinned Codex `0.162.0-alpha.17.2` includes GPT-6.1 Sol; verify it
with `bun run package:verify <output-directory> gpt-6.1-sol`. This checks catalog
support, not account entitlement. A user's own newer Codex has its own catalog.
When changing the pinned Codex, compare
its model list with the previous connection under the same account/provider, and
verify the required models in the installed browser menu before declaring success.

Before public release: verify the store identity and permissions/privacy listing,
provision signing/notarization/update hosting, exercise interrupted upgrade and
rollback with real signed versions, and validate supported browser profiles.
Public availability is recorded in `site/release.json` only after installation
and download are verified. Registration, an uploaded draft and a signed local
candidate are distinct from publication. The initial public-release progress
and remaining gates are recorded in
the release evidence.

References: [Chrome distribution](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions),
[native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging),
[Sparkle integration](https://sparkle-project.org/documentation/),
[Sparkle publishing](https://sparkle-project.org/documentation/publishing/),
[Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

### Agent invitation

The first empty canvas carries one visible **Connect an agent** label, on the charcoal attached dock. A cartoon wireframe of Galta beside a web page, with four short notes for the loop (drag anything in, say it or sketch it, watch it take shape, go back to any moment), forms the native illustration above; clicking the illustration opens the same setup. A native dashed thread leads toward the dock. Controls reuse the common interface tokens; small accents within the illustration come from the existing drawing palette. Codex and Claude Code marks indicate compatibility and are not setup choices. Both entries open the Settings root, where **Chat in Galta** and **Work in Codex or Claude Code** are visible as separate optional choices. The invitation consists of native filled shapes, pressure strokes and editable text in the live Excalidraw scene. Its marks can be erased, moved and styled with the editor; native hit testing dispatches the connection action. Unpainted DOM targets provide keyboard and screen-reader access. CanvasScene owns the system-element identities and excludes them from artwork persistence, agent observations and exports. Native copies receive new identities and become artwork. Starting a drawing, importing, or connecting an agent dismisses the guide for this browser profile; undo and reload cannot reinstate a retired guide.

Opening Settings does not start Codex or request an account. **Work in Codex or Claude Code** checks the companion and offers one copy action with an agent-readable setup prompt containing standard MCP JSON and the current tab’s stable target ID; the agent uses its own supported configuration format. Healthy runtime status is secondary, under Connection details; missing or incompatible runtime status stays visible with the next step. The UI waits for an actual external canvas lease before showing success, and an idle external connection carries no warning in Settings. **Chat in Galta** has its own explicit entry and account flow. The registered companion status host provides the stable installed `mcpCommand` launcher path. Older companion replies without that optional field retain the Mac app’s **Other AI apps & updates** configuration flow. Copying configuration does not mark an agent connected. An active external lease displays its client name and a stop action, without an embedded composer.
