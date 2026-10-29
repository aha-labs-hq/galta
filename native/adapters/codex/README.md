# Codex adapter for built-in chat

The browser extension cannot launch a local process or access a Codex login by itself. This tiny native host is the one-time local bridge that lets Galta use the user's existing Codex subscription without an API key.

The bridge starts `codex app-server --stdio` and translates Chrome native-messaging framing to Codex's JSONL protocol. Each direction owns its UTF-8 decoder; a partial model response cannot affect an incoming browser frame. It does not read ChatGPT cookies, persist OAuth tokens, or send canvas data to a Galta server. Codex owns login, token refresh, model availability, and rate-limit accounting in the user's existing `~/.codex` installation.

The host configures one required `galta` MCP server using the installed
`galta-mcp` executable with no arguments. Canvas and webpage operations both use
it. Its tools stay deferred in Code Mode, which keeps the request prefix
shared with Codex's prompt cache; see
[the agent contract](../../../docs/agents/codex.md#agent-contract). The extension verifies effective configuration once per connection; a stale
or browser-only host is rejected. New threads register no dynamic Galta tools.
Galta never rewrites Codex rollouts or databases. Legacy declarations and history
remain owned by Codex; a new conversation obtains a fresh catalog. No dynamic-tool callback or image-routing workaround
remains in the runtime.

Embedded MCP starts with `GALTA_MCP_UI_OWNED=1`. Its canvas and webpage schemas
require the exact `execution.id` supplied with the current turn; missing and
released bindings fail without global discovery. This keeps concurrent tasks
in Chrome, Dia and other canvases separate. The UI owns acquisition and release;
embedded callers cannot list, connect or disconnect. Independent MCP clients
retain their explicit connection protocol. The effective Codex configuration
and tool-contract fingerprint both verify this binding at connection time.

All native hosts share `native/messaging.ts` for ordered, framed output. Its
stream writer waits for browser pipe capacity before sending the next fragment.
Direct `Bun.stdout.write` stalled after a partial write to a nonblocking macOS
pipe during large history restoration; the regression test fills that pipe,
delays consumption, then verifies Unicode reassembly and a subsequent response.

To apply a host change on a Mac managed by Galta for Mac, update the complete app
and choose **Connect browser**. All native registrations must point to its selected
immutable release. Standalone developer installations instead rebuild and run both
bridge installers, then reload the extension. An already-running host keeps its
loaded binary. Global Codex configuration is not edited. See the
[agent architecture](../../../docs/agent-architecture.md).

Galta also sets `notify=[]` for its process: desktop-specific end-of-turn
commands must not run from an embedded host. The inherited Codex Computer Use
notification helper otherwise triggers a macOS Automation prompt at task
completion, even without computer-use tool calls. The host defaults to
`approval_policy="never"`, `sandbox_mode="danger-full-access"`, and
`apps._default.default_tools_approval_mode="approve"`, consistent with Galta's
user-authorized execution policy. It also sets `features.memories=false` and
`memories.generate_memories=false`: Codex memory is one store per `CODEX_HOME`,
shared with the user's coding sessions, so Galta conversations neither load it
nor run its consolidation pipeline, and Galta threads are recorded as excluded
from memory mining. The connection checks these effective values alongside the
MCP configuration. Global configuration, plugin hooks, explicit app/MCP
tool policies, authentication and macOS privacy permissions are not rewritten.
See [execution policy](../../../docs/agents/codex.md) for the boundaries.

Run `bun scripts/verify-codex-policy.ts` to verify the installed bridge with the
configured model. This opt-in check uses two real turns in an ephemeral thread,
verifies temporary file writes and zero interactive server requests, and checks
that global notification and approval settings remain unchanged. It consumes
model usage, removes its temporary files, and does not edit a canvas.

## Development install

These scripts are for standalone developer installations without Galta for Mac.
They refuse to run when a selected release, activation journal or companion
registration exists, even if it is broken: the Mac app owns that repair and update
flow. Mixing standalone bridges with a packaged companion breaks its registration
check. For a Mac app installation, build and install a complete engineering candidate
using the [distribution instructions](../../../docs/distribution.md).

```sh
bun run bridge:build
bun run canvas:install <your-unpacked-extension-id>
bun run bridge:install <your-unpacked-extension-id>
```

Dia is the default browser. On macOS its native host manifest belongs in
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.galta.codex.json`,
not a Dia profile folder. This is a registry location used by Dia; Chrome does
not need to be installed or opened. See the [browser registry maintained by AdGuard](https://github.com/AdguardTeam/CompatibilityIssues/blob/master/mac/browsers.json).

The independent canvas host coordinates document leases for both embedded and
MCP agents. See [the agent architecture](../../../docs/agent-architecture.md) for
MCP setup; that path requires no Codex account.

Embedded use needs an official Codex. `GALTA_CODEX_BIN`, when set, selects that
executable explicitly; an invalid value fails instead of selecting a different
installation. Without it, the bridge uses the user's newest Codex at or above the
pinned version from ChatGPT for Mac, Codex for Mac, `~/.local/bin`, Homebrew,
`/usr/local/bin`, npm's usual prefixes or the host's PATH, then a copy Galta
downloaded into its data directory
([distribution](../../../docs/distribution.md#codex-for-chat-in-galta)). With
none, it answers every request with the step that sets Codex up. After installation,
reload the extension, choose **Connect an agent**, and open **Use built-in chat** in Connection details. An existing local Codex sign-in should
be recognized without another authorization tab. A ChatGPT browser session alone
does not authenticate the local Codex process. Authentication failures ask Codex
to refresh once; a missing account or an unrecoverable credential needs the
separate `Sign in with ChatGPT` action. Galta clears obsolete account/usage state
and keeps drafts intact. See [account recovery](../../../docs/agents/codex.md#account-state-and-recovery).

The installers copy the compiled binaries to the platform-native Galta data
root's `bin` directory before registering their absolute installed paths. On
macOS that is `~/Library/Application Support/Galta/bin`; on Linux it is
`${XDG_DATA_HOME:-~/.local/share}/galta/bin`. `canvas:install` also installs
`galta-mcp` there. An optional source-binary argument selects what to copy, not
where the browser will run it. Every native rebuild requires re-running the
installers, then reloading the extension. Complete files replace the installed
binaries atomically, so a running host remains valid until that reload.

The first macOS upgrade from the former `~/.local/share/galta` location moves
the complete private data root into Application Support after all Galta canvases
have closed. It does not copy or merge workspace trees. If both locations have
data, installation stops and reports the conflict instead of guessing.

Do not point native manifests at a checkout in Documents, Desktop, or Downloads.
macOS protects those folders, and an ad-hoc binary's identity changes on rebuild;
the combination can repeatedly trigger folder-access prompts during startup.
The installed hosts run outside those folders, and Codex app-server starts in
the managed data root's private `runtime` directory. Normal canvas work uses its managed `workspaces`
subdirectory and requires no Documents access. User-requested access to protected
files still follows macOS consent.
Galta does not grant Full Disk Access or change TCC settings. A distributable
release still needs stable Developer ID signing and notarization.

Playwright is a repository test
dependency, not part of the bridge or an Agent browser runtime. Agent browser
checks use tools already available in the Codex session. Galta's user-authorized
execution policy is full access without command approvals. See
[the browser contract](../../../docs/agents/codex.md#browser-verification).

The verified development targets are macOS Dia and Chrome. The installers also
support the Linux Chrome registry; Windows installation is not implemented.
Closing either peer cancels both input readers and terminates the app-server
started by this host. An app-server exit cannot leave the native relay waiting
indefinitely on the browser's open input stream.

For an isolated real-extension, native-host and model continuation test:

```sh
bun scripts/verify-unified-mcp.ts
```

This opt-in command makes real Codex requests using the existing subscription.
It continues one thread across an app-server restart and exercises the browser
tools and the canvas inspect, edit, place, capture and extract tools through
the galta MCP server. Its attested receipt is written
to its temporary run directory. It does not establish which build the
user's existing browser has loaded.

Generation runs in the `galta` MCP server with the provider account the user
connects under Generation in Settings; this bridge has no image route of its own. See
[generation](../../../docs/agent-architecture.md#generation).
Its real production image receipt is separate from native Codex image-tool
availability; the bridge continues to transport the actual generated file.

The production installer should provision the bridge with a signed, platform-specific binary and the published extension ID. Chrome requires the exact extension ID in `allowed_origins`; a host cannot be shared by an arbitrary extension.
