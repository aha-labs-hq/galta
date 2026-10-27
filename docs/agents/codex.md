# Codex adapter for built-in chat

The [agent connection and Galta runtime](../distribution.md) are shared product
capabilities. This document describes only the optional Codex adapter used by
built-in chat. External agents connect directly through Galta MCP.

## The user experience

1. On first use, opening Galta starts only the independent canvas bridge. Choosing **Chat in Galta** in Settings checks the existing account; opening Settings or **Work in Codex or Claude Code** does not start or authenticate Codex. A previously enabled built-in chat reconnects on opening Galta.
2. The composer shows the connection action when disconnected; its model menu shows the connected account and usage. There is no API-key form.
3. The Galta Mac app installs and registers the runtime; choose **Connect browser** there. Standalone [adapter installation](../../native/adapters/codex/README.md) remains a developer workflow. A missing runtime produces an error.
4. Once installed, the bridge starts the user's local `codex app-server`.
   Packaged development builds currently pin Codex `0.162.0-alpha.17.2`, whose catalog includes GPT-6.1 Sol, GPT-6 Astra, Sol and Luna; the provider and account still decide which models are actually available. Galta reads `model/list` from this bundled runtime, so updating the desktop Codex app alone does not update Galta's model catalog.
5. If the user is already signed in to Codex, Galta loads the account, the complete paginated model catalog and usage metadata. Galta checks again when the runtime menu opens, the app regains focus or resumes, a turn completes, or the reported quota window reaches its next reset. Account and usage notifications update the workspace even when the menu is closed. The menu shows the account's mark and plan, Effort, and a read-only remaining-quota meter with a tooltip identifying the current usage window. It has no refresh button. A still-available selected model is preserved; a new workspace follows the provider's default model.
6. If the account is missing or Codex cannot recover an invalid credential, Galta offers `Sign in with ChatGPT` and removes the previous account and quota from view. Only clicking the sign-in action starts authorization. Recovering the account never submits a draft or replays a failed turn.
7. Sign-in opens the official authorization URL in one centered 480 × 720 browser popup, bounded by the original window's dimensions. Repeated clicks focus the same popup. The source page and canvas remain in the original window.
8. Closing the popup cancels that login attempt. A successful notification must match its login ID before Galta closes the popup and focuses the original window. The flow also handles success arriving before popup creation has finished. Failed or unrelated notifications do not close other windows.
9. The composer footer shows the latest reported input tokens as a share of the model context window once it reaches 60%. The indicator stays neutral at higher usage, with a tooltip such as `69% context used`. Context usage does not trigger a new conversation. The app-server owns automatic compaction, governed by `model_auto_compact_token_limit` and `model_auto_compact_token_limit_scope`, and reports it as a `contextCompaction` thread item with visible progress and completion states. `thread/compact/start` is the manual compaction API; Galta does not call it.

The user never copies a token into Galta. The Codex process owns OAuth storage and refresh. Galta only receives the account plan, available models, rate-limit metadata, and streamed Agent output needed for the current canvas transaction.

A ChatGPT browser session and the local Codex authorization have separate
lifecycles. Being signed in on chatgpt.com does not make a revoked local Codex
credential valid; account recovery follows the app-server's authentication state.

## Account state and recovery

`NativeCodexAdapter` owns the account-check RPC sequence. Normal reads use
`account/read` with `refreshToken: false`. An authentication failure from the
account, model or usage read permits exactly one `account/read` with
`refreshToken: true`, followed by fresh model and usage reads. Codex owns credential
reload, OAuth refresh and persistence; Galta never reads `auth.json` or browser
cookies. Concurrent checks share the same operation and recovery. This follows
the [official app-server auth contract](https://developers.openai.com/codex/app-server/#auth-endpoints).
An account change or a new login invalidates the previous check's right to refresh
credentials; its failure cannot force a refresh for the replacement account.

An unrecoverable authentication failure becomes `requiresAuth`, with a concise
sign-in message broadcast to all connected Galta views. A network failure during
recovery remains a connection error; it is not treated as proof of sign-out.
A non-authentication usage failure keeps a usable account and model catalog but
returns `usageError` with no quota. The named `codex` bucket takes precedence over
the protocol's legacy single-bucket view. Missing or invalid usage is never 0%.
Upstream HTTP bodies are not product copy or diagnostic logs. Recovery diagnostics
record the operation, RPC method/code when available and whether sign-in is needed.

`CodexConnection` owns one typed account snapshot for each workspace view. Canvas
navigation shares this owner instead of copying account fields into each canvas.
Authentication changes and disconnects invalidate pending reads; their late
responses cannot restore a former account. A pushed quota update takes precedence
over an older pending read. Successful recovery clears the previous error. Focus
checks can recover from failed or expired connections, but never start an OAuth
popup. The observer schedules one cancellable read at the primary window's reported
`resetsAt` (Unix seconds, per the [app-server rate-limit contract](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt)).
New snapshots replace this deadline; logout, disconnect and disposal cancel it.
An expired or missing deadline never creates a polling or retry loop, and Galta
never assumes that usage became zero when a window elapsed.
The login-start response cannot overwrite a login-completed notification
that arrived while Chrome was still opening the popup.

Regression coverage: `tests/codex-account.test.mjs`,
`tests/codex-connection-state.test.mjs`, the existing bridge/login lifecycle tests,
and `tests/browser/codex-account.spec.ts`. Browser cases exercise the production
bundle with deterministic account responses, including draft preservation and
narrow-layout recovery. They do not revoke or replace the user's real credentials.

## Public integration boundary

Galta uses the official app-server binary and public RPC/configuration interfaces.
It does not patch the binary, intercept model requests, or rewrite Codex rollouts,
databases, cache keys or compaction state. The former offline tool-declaration
repair has been removed; historical evidence and user backups remain historical
records, not supported maintenance instructions. There is no supported removal
field for declarations retained by a legacy thread in bundled 0.162.0-alpha.17.2. Such
history is preserved; start a new conversation to obtain a fresh tool catalog.

## Current transport

This implementation uses a local process through native messaging. Browser-only subscription OAuth is not implemented or proven by this integration. It does not read ChatGPT cookies or copy Codex credentials into extension storage.

Chrome's native-messaging API is the narrow bridge: the service worker has the `nativeMessaging` permission, connects to `com.galta.codex`, and the host is restricted to Galta's exact extension origin. The host translates Chrome's length-prefixed messages to the Codex app-server's JSONL stdio protocol. Connection reads are bounded; if Codex does not answer, Galta retires that native transport before the user retries, so the next attempt initializes a fresh host.

Each direction owns its UTF-8 decoder so concurrent traffic cannot corrupt split
characters. Either peer closing cancels both read loops and ends the relay.
An explicit `GALTA_CODEX_BIN` is authoritative: an invalid path fails without
silently switching to another installation.

## Agent contract

The installed Codex app-server owns reasoning, native tools and persistent
conversations. All eight canvas tools, the three webpage tools and, while a
provider is connected, the generation tools use the same `galta` MCP server as
external clients. New threads declare no dynamic tools.
The runtime owns start/resume/fork, turn streaming, approvals and interruption;
it has no canvas execution callback.

Persisted legacy declarations are left to Codex; Galta never rewrites its storage.
The runtime has no retired-tool execution or rejection branch. Every turn directs
the agent to MCP; the host binds the current UI execution and the agent supplies
that turn's `execution.id` as `executionId` on each tool call. Historical dynamic calls retain
their original display labels; they are not relabeled as MCP calls.
Document rules, schemas and HTML requirements live in the shared tool
descriptions and the short `GALTA_MCP_INSTRUCTIONS`. `codexInstructions` adds
host-specific execution and reply guidance, and the canvas habits an agent must
follow before it has loaded any tool description.

The user request is sent verbatim. On every turn,
`additionalContext.galta_instructions` carries the current Codex-specific guidance
as `application` context, which Codex delivers as a separate developer message.
MCP owns the canvas/webpage contract and schemas; they are not repeated in each
turn. The adapter identifies Galta as a browser extension with its own canvas,
usually beside an independent webpage, and directs tools to the supplied execution.
This explicitly revokes the historical English-only rule and earlier image-route
configuration. It does not overwrite history, base instructions or collaboration
modes. Resuming an already-loaded thread does not reliably replace its original
developer instructions; the turn boundary covers new, continued and forked runs.
This is instruction delivery, not a deterministic output-language validator or a
provider prompt-cache guarantee. Trusted canvas context contains project/branch
identity; the structured observation and viewport image accompany the user
message. Selected IDs, visible geometry and net changes are bounded samples
with totals and truncation flags. Full element bodies, text, point arrays and
provenance URLs remain accessible through `canvas_inspect`. Read exact fields
by object ID and request further pixels through scoped captures when needed.
The viewport preview is the only image a message attaches; web captures are
`untrusted` data.
These observations do not update automatically as the user browses. In the
original bound tab, a fresh `browser_inspect` observes navigation and replaces old
refs. An active task never follows focus into a different tab. If its intended
source has gone, the agent reports that limit while independent canvas work can
continue.

Rules are conditional on the task: ordinary conversation does not require a
canvas read or an unrelated unavailable-page warning; explicit user scope takes
precedence over default selected targets. A submitted selection is the user's
attention signal: when a request refers to the just-selected objects without
naming another target, the agent resolves those IDs through `canvas_extract`
before looking for workspace files, and reports a missing source instead of
substituting an old output. The shared contract preserves requested
native/editable media. Tool descriptions identify DOM coverage and the execution
placement viewport, including its frozen background-task meaning. Codex's own
permissions block remains authoritative for sandbox/escalation behavior; Galta
does not repeat that policy in its application instructions. See the
content review for evidence,
remaining limitations and ownership decisions.

The bundled 0.162.0-alpha.17.2 schemas require `experimentalApi` for
`additionalContext`; history-node `lastTurnId` forks are part of the stable schema.
This capability opts into protocol fields, not the code-mode feature. The
app-server owns its local code-mode host and
model retries. Galta displays `error.willRetry` as model reconnection activity
and retains diagnostics without replaying the turn or its tools.

Following the official [app-server event contract](https://learn.chatgpt.com/docs/app-server),
`turn/completed` for the current turn is the runtime's preferred terminal
authority. `error` supplies diagnostics and `turn/interrupt` requests
cancellation; neither causes Galta to replay a turn or a tool. Galta keeps a
2-second window after a non-retry error for final item receipts, and bounds a
provider-retry stream to 30 seconds without model progress. If the matching
completion never arrives, the runtime emits a local failure so the task and its
UI can release; this is an orphan guard, not a second provider retry policy.
Pending UI interactions are dismissed on `serverRequest/resolved`, turn
completion or actual connection loss. An old turn's completion cannot release a
new turn's owner, and a late Stop cannot overwrite a completion already received.
If an orphaned turn cannot be interrupted, the bridge retires the shared
transport rather than reporting a false disconnect.

`canvas_inspect` returns a page and no pixels. `scope: selection` enumerates the
submitted selection, including IDs now missing from the live document.
The default `scope: canvas` reads current elements. Known `ids` are an alternative
scope, preserve requested order, and fail on missing IDs. Every response contains
counts, per-element `selectedAtSubmission` flags, and
`coverage {scope,total,offset,returned,nextOffset}`. Continue the same query with its revision; changes fail rather than mixing document versions.
Pages default to 32 records, at most 64, and break between records around 12,000
serialized characters. This is not a token limit; one exact detailed record may
be larger. Summary text is an explicit excerpt; full fields are opt-in. Complete
selection arrays never repeat as page metadata. Tool results describe
the document and submitted observations. UI selection belongs to the editor; a
background TaskScene retains only its submission copy, so projections and edit
receipts do not advertise a live selection.

Automatic naming is an isolated ephemeral thread. Its public per-thread overrides
set `skills.include_instructions=false`, `project_doc_max_bytes=0` and disable
automatic environment, permissions, collaboration-mode and apps instruction
blocks, alongside its existing tool restrictions. These settings never change
the main agent or the user's config files. `verify-conversation-metadata.ts`
checks actual model requests against the official binary, with seeded skills and
project instructions absent in naming and present in a subsequent ordinary turn.
The utility also disables inherited `code_mode_only`; normal threads retain their
configured mode. MCP overrides use a nested table so server names containing dots
remain opaque keys. Disabled entries retain only command/url and enablement flags:
CLI-defined transports must remain parseable, while nullable config/read defaults
must not be blindly replayed as TOML overrides. The fixture covers stdio and
HTTP servers from user, CLI and trusted workspace configuration, and checks that
process configuration remains unchanged.
The remaining `request_user_input` tool is rejected if invoked by the utility.
See the official [configuration schema](https://developers.openai.com/codex/config-schema.json).

Codex memory is one store per `CODEX_HOME`, shared with the user's coding
sessions, with no per-application scope. The embedded process therefore sets
`features.memories=false`, so Galta conversations never load that store and the
process never runs its consolidation pipeline on the user's account, and
`memories.generate_memories=false`, which records Galta threads as
`memory_mode = disabled` so other Codex processes sharing the home do not mine
them. `assertCodexEmbeddedConfig` rejects a connection whose effective config
differs. Threads created before this setting keep their recorded mode, and
memories already extracted from them stay in the user's store; Galta does not
rewrite Codex storage.

Every canvas message carries a bounded structured observation and, for a nonempty
viewport, a low-detail preview when rendering succeeds. The message schema limits
each object sample to 12 records and the observation to 12,000 characters. Its
evidence entries are summaries (revision, scope, medium, coverage counts and the
preview hash) without element ID lists; the tool's evidence ledger keeps the full
records and `canvas_report` returns them. When the latest observed turn in the
same thread saw this commit and viewport and no `contextCompaction` item has
appeared since, the preview is `unchanged`: it names the earlier preview's
evidence ID and attaches no pixels. The instructions tell the agent to capture
the viewport if that image is no longer in its context, which covers compaction
that starts with the new turn. Full selection, viewport
and change sets remain pageable through `canvas_inspect`. Changes compare saved
versions against the preceding actual turn's observation in the same conversation;
they preserve user/agent/import provenance without interpreting intention.
Empty, unavailable and partially unrendered previews remain explicit. The preview
uses the existing 1400-pixel, 600,000-byte JPEG capture limit and spends image
tokens. On-demand `canvas_capture` / `browser_capture` calls can add further visual
evidence. `canvas_extract` writes image,
video or embedded HTML source bytes into reusable content-addressed workspace files; paged exports include
target metadata and a revision. Image import and extraction share a format catalog:
PNG/APNG, JPEG, WebP, GIF, SVG, AVIF, BMP and ICO. Original source bytes are kept;
the formats accepted for model vision input are a separate concern. Native
publication validates the source format, declared MIME type and file extension.
SVG is parsed as XML without executing its content. `canvas_edit` commits chosen media alongside
native/layout edits in one transaction, and `canvas_place` is its single-file
convenience entry. `canvas_capture` emits a structured image block alongside
coverage metadata through MCP. The previous dynamic-tool image routing override
has been removed. After each initialization, `config/read` verifies that the full
`galta` server is enabled and required, with no browser-only mode, plus the
notification and execution defaults. A stale host fails explicitly. The runtime
binds the UI-owned execution and workspace in application context; webpage
content cannot supply or override that binding.
Local failures and remote disconnects share one cleanup path; events from retired
ports cannot affect a replacement connection.
The sidebar's browser port consumes Chrome's callback-scoped `runtime.lastError`
and reports the actual disconnect through the same visible connection state.
An explicit `Connect Codex` reopens its lifetime port; there is no automatic retry.
Intentional disposal and late events from retired ports do not report a new failure.
Canvas registration ports likewise retain the actual Chrome failure instead of
leaving an unchecked-error entry with only a generic UI message.

Galta's low/high view option controls render dimensions; the host still controls
image resizing and token cost. Global Codex configuration stays unchanged.
Rebuild both hosts and reload the extension to replace an existing connection.
For a raster edit Codex extracts the source, passes it to `generate_image`
(listed once a provider is connected), inspects the result and places it. Each successful mutation persists a reversible canvas version
immediately. Stop interrupts Codex and preserves edits already completed; it is
not an implicit rollback of the entire conversation.

Canvas operations are validated at the editor boundary, with revision checks
before asynchronous image reads, again after decoding and before mutations. Invalid native shape props
roll back the atomic edit. A missing image, stale revision, denied tool request,
failed provider response or disconnected bridge is reported as a failure, never
a successful visual result. The property schema exposes accepted native fields;
groups, text containers and arrow bindings retain Excalidraw's own semantics.
Region views include independent overlapping content, and related views expand
native ownership. Write replies return changed summaries and deleted IDs rather
than repeating the whole document. Successful edit revisions can be reused.
The Agent uses the user's language. None of these contracts dictates a particular
creative workflow or guarantees autonomous visual judgment.

Text binding retains native drawing order and restores original content on
detach. Invalid arrow-to-bound-text relationships fail before mutation. Clearing
text cleans reverse bindings and reports affected containers in the write
result. Path resize requests must supply `points`, the native geometry authority.

Galta's execution policy is `approvalPolicy: never` with
`sandbox: danger-full-access` for thread start/resume/fork and
`sandboxPolicy: {type: dangerFullAccess}` on every turn. Sending both policies
at the turn boundary covers already-loaded conversations. This permits Agent
commands outside the creative workspace and avoids command/file approval prompts;
it changes Galta's requests, not the user's global Codex configuration.
The native host applies the same execution defaults at process startup and sets
`notify=[]`. Galta owns turn completion in its conversation; a desktop client's
global notification command must not run after a Galta turn. In particular,
`SkyComputerUseClient turn-ended` can request macOS Automation permission even
when the Agent never uses a computer-control tool. Emptying the notification
command prevents that unrelated invocation without granting system permissions.

The host also sets `apps._default.default_tools_approval_mode="approve"` for
connected app tools. Explicit per-app/per-tool policy and administrator-enforced
restrictions remain authoritative. MCP servers have their own per-server/tool
approval settings; the app default does not override them. Authentication,
missing user input, and macOS consent are distinct from tool approval. TUI
notifications do not run in app-server. Lifecycle hooks and plugin enablement
are retained; Galta does not disable unrelated capabilities to hide a prompt.
`packages/runtime/src/codexConfig.ts` owns these process and turn settings.
Any server requests for extra permissions, approvals or user input are still
shown inside the conversation and answered through the exact original request.
The kernel still owns approval policy and tool execution. Unsupported interactive
request types return an explicit error. Galta is not feature parity with every
Codex desktop interaction: remote OAuth elicitation and arbitrary artifact
previews are not implemented.

The bridge distinguishes client responses from server requests, routes each
run to its owning canvas and interrupts when that canvas closes. Stop during
scheduling waits for the actual started turn. Generated output is chunked to
respect native messaging limits and stored as image bytes in local snapshots.
Original web references are embedded Excalidraw BinaryFiles; source URLs remain provenance metadata.

## Verification

`bun run test` covers protocol ownership, continuation/fork contracts,
cancellation races, tool failures, native framing, image artifact boundaries,
history and login lifecycle. `bun run test:browser` covers real Excalidraw operations and the production bundle.

`bun scripts/verify-agent-instructions.ts` is an opt-in real-model regression
using an isolated workspace and local configuration directory. It first reproduces
an English-only legacy thread, then checks current-language responses, explicit
language overrides and historical forks.
It makes no canvas edits or image-generation requests. Receipts go to a unique
temporary directory; the latest result
records its verification boundary. `bun scripts/verify-canvas-mcp.ts` independently
checks the shared advertised instructions/tools and real canvas behavior without
starting Codex.

`bun scripts/verify-unified-mcp.ts` loads the production extension build into
an isolated Chrome profile with the compiled native hosts and a companion
fixture for installation status. It runs one turn, closes the isolated browser
so the reopened canvas reconnects to a fresh app-server, and continues the same
thread through MCP. It checks that the original turn remains identical, runs a
webpage task and a canvas media task whose every tool call must complete, and
requires the model to recognize independent raster-only codes from webpage and
canvas image blocks. Dynamic calls must be absent. It writes an attested
receipt to its temporary run directory, which `bun run evaluate:agent` can
score. These current checks replace the retired direct-tool live and vision scripts;
their historical receipts remain in evidence. The test consumes the configured
model's usage.

`bun scripts/verify-codex-ui-live.ts` verifies the production conversation path:
selecting a model and effort, submitting through the composer, visible Stop,
exact text/geometry/style, persisted runtime provenance, and reloads around
same-thread continuation. It also stops an actual native turn, checks its remote
interrupted status, reloads the visible Stopped turn, and continues successfully
in the same thread. It reads the workspace through the production storage
repository. With `GALTA_VERIFY_IMAGE=1` it also replaces a submitted image with
`generate_image`, which needs a BytePlus key connected in Galta's Settings; the
isolated runtime reads the user's `media/keys.json` and never records it.
Only Chrome's message-delivery layer is adapted to the native host; this is not
an installed-sidebar or native cross-pane drag test. Its screenshots and receipt
go to a temporary directory that the run prints.

## Native Image Availability

The recorded Polyrouter diagnostic failed the authorization prerequisite in
Codex 0.158.0-alpha.2.1's native image-tool registration. This is evidence for that
tested version and provider configuration. A provider capability response
with `imageGeneration: true` does not establish an available generation tool.
The matching-version implementation requires all of the feature, account-plan,
provider capabilities, image input modality and authorization checks to pass:

- [Tool availability](https://github.com/openai/codex/blob/rust-v0.158.0-alpha.2.1/codex-rs/core/src/tools/spec_plan.rs#L3490)
  requires either OpenAI actor authorization or `requires_openai_auth` with
  current Codex-backend authentication.
- [Actor authorization predicate](https://github.com/openai/codex/blob/rust-v0.158.0-alpha.2.1/codex-rs/model-provider-info/src/lib.rs#L2801)
  requires a nonempty designated actor-authorization header on a provider that
  does not otherwise require OpenAI authentication.

The diagnosed provider had neither path: `requires_openai_auth` was false and
the actor-authorization header was absent. The diagnostic receipt
retains only these non-secret predicates, the installed version, official source
hashes and relevant excerpts. The failed image run
remains the observed output evidence. Source inspection explains the missing
tool; it does not certify a successful image run or the provenance of the local
binary beyond its reported version.

This remains a diagnostic of native Codex generation. Galta's own generate
tools, with the user's connected provider, replaced the temporary Desktop
seed-media route that followed it; see [generation](../agent-architecture.md#generation).

## Browser verification

Playwright is a repository development dependency used by tests and verification
scripts. Galta's canvas, HTML renderer and native bridge do not require it at
runtime. The native installer registers the bridge without downloading a browser
or exposing the checkout's packages to Agent scripts.

Every new, resumed and forked turn includes source-page identity separately from
the canvas; page content and pixels are read on demand. The embedded host configures the full `galta`
MCP server using the installed `galta-mcp` executable with no arguments, without
editing global Codex settings. Canvas and browser tools use the same active
execution; the latter retain its immutable source-tab binding. Continued legacy
threads use MCP while retaining their conversation history.
Both native hosts and the extension must be rebuilt/reinstalled for this change.
The extension needs Chrome's `<all_urls>` capture permission; source operations
still accept only HTTP(S) pages. See [source-page architecture](../architecture.md#source-and-import).

Unavailable source pages or host browser tools must be reported as
interactive verification not performed. The Agent must not install a browser,
reuse the retired Galta launch module, borrow Galta's test dependencies or
claim visual verification from source inspection. Browsers launched by an Agent
command must be closed in `finally`.

These are turn instructions, not a mechanical interceptor for arbitrary shell
commands. Unit tests cover the new/resumed/forked instruction contract and
approval/decline forwarding. No global Codex policy, selected model or credentials
are changed. See the September 17 incident
for the observed failure path and the scope of verification.

## Release boundary

The extension package can be published independently. The bridge installer must ship a signed native binary for each supported platform and register a manifest with the production extension ID. The installer must also verify that an official Codex CLI/app-server is available; the bridge must not download or replace a user's Codex installation without an explicit user action.
