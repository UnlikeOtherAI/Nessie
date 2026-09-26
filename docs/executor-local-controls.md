# Local executor controls

Nessie decides **who may use a paired executor**: people, agents, projects and
team access. The executor decides **what this computer makes available**.
Folder access, command rules and installed interactive programs are configured
on the computer, separately for each paired team. Nessie's hosted UI and API
cannot edit them. Remote desktop access to the computer is still local control.

## One console on macOS and Windows

Both standalone apps package `packages/executor-console`. Windows hosts it in
the tray's local Tauri webview; macOS hosts the identical document in WKWebView.
Only the bundled local page gets the native configuration bridge. The Mac
bridge checks its main-frame file URL, and the Windows capability has no
remote origins. Nessie Desktop's hosted-page bridge exposes no configure or
change-workspace commands.

The console's home is **Paired teams**, reachable from the menu bar/tray.
**Add team** requests an eight-digit code from the unauthenticated pairing
start endpoint. The code appears in large black text with **Copy**. Paste it
into Nessie's **Admin › Computers › Pair a computer** popup, which explains both
the app and CLI entry points. Review the fingerprint in Nessie, then confirm
the claimed organisation and team on the computer. Expiry, single use and
confirmation bound to the displayed claim remain enforced by the runtime.

Each team row has Start, Stop and Permissions. **Folders** and **Commands**
have an explicit team selector. **Settings → Open Nessie Executor when I log
in** controls macOS's login item or Windows's per-user Run registration.
It starts the app and its paired connections; quitting stops app-owned daemons.

New Windows tray pairings run as the signed-in person and share the CLI's
`~/.local/state/nessie-executor/<executor-id>` directories. This lets installed
coding tools use that person's login. The tray still controls existing
service-account connections over the authenticated pipe; it never copies their
keys or changes their owner. Service connections remain independent of login.
A connection running in another CLI/app must be stopped there before this app
can reconfigure it. Both Windows supervisors share runtime-integrity and daemon
lease verification in `executor/windows-common`.

## Folder and command rules

Folders grant the executor's file tools named roots. Draft-file and guest
workspace checks continue to enforce those roots. The last file-tool folder
cannot be removed; pause or disconnect the connection to stop all its work.

New pairings store `commandPolicy: { mode: "all", allowlist: [], denylist: [] }`
in their owner-only local state. Existing pairings retain their old allowlist
until changed locally. **Only allowlisted commands** restricts launch requests;
denials win in either mode. Each rule is a bare executable with optional
argument prefixes and an optional trailing `*`, for example `git *` and
`git push *`. Existing structural restrictions on shell launchers and program
paths remain. These are launch rules, not a restriction on subprocesses a
permitted program may spawn.

The daemon checks the local rules before accepting `command.run`, and the
command-session manager checks them before creating a guest. The new rules
are never included in the signed server descriptor. The descriptor still
reports available operations and named roots. Untouched old descriptors may
retain their legacy allowlist field; the next local edit moves those rules to
local state without widening them. Saving locally restarts an app-owned connection to
apply the rules. A CLI operator restarts the daemon after changing them.
Allow-all is the default command policy; availability of sandboxed
`command.run` still requires a configured guest runtime.

## Interactive programs

Under **Commands**, enter the installed executable and optional arguments
(one per line), then select its working folder. This configures the existing
terminal-session bridge, supporting Codex, Gemini, Claude and other interactive
programs. Windows uses ConPTY; macOS/Linux require tmux on PATH.
On Windows use the actual executable, or `node` with the CLI's script path as
an argument, rather than a `.cmd`, `.bat` or `.ps1` shim.

Interactive programs are an explicit local grant of the OS account's access.
Their working folder is not an OS sandbox, and executor command allow/deny
rules do not police commands those programs execute internally. The console
states this distinction. Their working root must be separate from draft
workspace roots and executor state. Existing structured coding-agent settings
are preserved when the terminal entry changes. Nessie's Sessions surface
continues to expose live terminal views under its existing access checks.

## CLI

```sh
nessie-executor login --api nessie --workspace /path/to/work
nessie-executor teams
nessie-executor daemon --executor <executor-id>
nessie-executor permissions --executor <executor-id>
nessie-executor permissions --executor <executor-id> --allow-all --deny "git push *"
nessie-executor permissions --executor <executor-id> --allow "git *,pnpm *"
```

`login` uses the interactive code flow on every platform. After confirmation,
interactive CLI login enables a per-team launchd agent on macOS or a systemd
user service on Linux. `enable`, `disable` and `status` manage those services.
Installation and startup: [executor packages](running-the-apps/executor-cli.md). `teams --json` provides the
credential-free list of CLI pairings, with names read from the server and IDs
still available offline. `--state-root` selects an alternate CLI-format root;
`--state-dir` addresses a specific app-owned connection for local configuration.
The existing `configure --configuration-input-stdin` handles folders, operations
and interactive-program settings without placing their contents in argv.

## Verification

`executor/tray-windows/test/renderer-harness.mjs` loads the shared assets in
headless Playwright with each native transport stubbed. It checks leading-zero
codes, Copy, confirmation, two teams, independent permissions and login
settings, and captures both platforms' screens. The existing admin
`test:e2e:executor-pairing` checks the popup on desktop and mobile widths.
Runtime tests cover local deny precedence, legacy policy preservation, refusal
before guest launch, and exclusion of new rules from pairing network payloads.

## Existing coding sessions

The default-on **Existing coding sessions** switch in the shared console's
Commands page applies to the selected local connection. The same setting is
available in every CLI with `permissions --executor <id> --existing-sessions
on|off`, and is included in `permissions` and `describe` output. Existing
executor authorization is enough; there are no extra grants. Disabling stops
new discovery and dispatch and keeps the original coding processes running.
Provider behavior and Claude's experimental channel startup requirement are
in [existing coding sessions](plans/2026-09-26-existing-coding-sessions/overview.md).

The same Commands page has **Connect a Claude channel**, with the installed
executor's exact MCP JSON and Claude startup command. `describe --json` emits
this as `existingClaudeChannelConfiguration`. This connects Claude's native
experimental channel; it adds no Nessie authentication or approval. Sessions
already running without that channel stay inspectable until Claude connects it.

Background discovery reuses a 60-second cache. The existing daemon heartbeat
reports whether the connection has private-owner session access; shared
connections do not collect existing conversation metadata. Explicit owner
queries refresh the provider inventory. A missing or expired heartbeat receipt
stops channel delivery. Disabling the local switch takes effect immediately.
