# Live terminal sessions

The home is **Executors → Sessions**. It lists the latest 200 sessions the
person owns or has been explicitly invited to view, across their organisation.
An executor's **Sessions** tab reuses that list, filtered to that machine.
**View session** beside an open Local apps session, and the `viewPath` returned
by an agent's session tools, open the same detail page. Opening a page never
starts a process.

The viewer is read-only. It renders xterm at the session's fixed 120×36 size,
with up to 500 scrollback lines, and refreshes approximately once a second.
Different viewers never resize or type into the process. A structured
Claude/Codex session shows its projected activity; a `terminal` session shows
the interactive program's actual terminal screen, including input echo and
full-screen terminal interfaces. This is a current screen with bounded
scrollback, not a recording of every intermediate animation or keystroke.

## Machine-side sessions

The existing detached coding-session host owns one session ID, owner key,
reviewed configuration, inbox, quota and process tree. It outlives the MCP
bridge, executor reconnect and viewer. Closing the session, losing authority,
the configured maximum turn duration or the existing prolonged-disconnection
teardown still ends it. A killed terminal process is never silently restarted
or replayed; start a new session. A reboot does not preserve a live PTY.

On macOS and Linux each terminal host owns a separate foreground **tmux**
server, socket and session named `nessie`. It never changes the user's own
tmux configuration or server. The private
`coding-sessions/sessions/<id>/terminal-connection.json` holds its socket path.
The machine owner can attach locally with
`tmux -S <socketPath> attach -t nessie`; this local OS access is independent of
Nessie's view-only web sharing. tmux must be installed and on the reviewed
program environment's PATH.

On Windows the installed native helper's `terminal-run` command provides
**ConPTY**, inside the host's existing Windows Job containment. It ships in
the same signed helper and hash manifest; no extra native Node module is
loaded. A development checkout first builds `executor/native` with
`cargo build --release --manifest-path executor/native/Cargo.toml`.

## Configure and connect

Install and pair the executor using [executor pairing](../executor-pairing.md),
as the logged-in machine owner, choosing a **private** executor. Review its
local-apps capability in Nessie and give the supervising agent access.
The host CLI must already be installed and authenticated as that OS user.
Never put login tokens into this configuration.

For the development LAN, SSH is available at `dictator@dictator.local`,
`ondre@Minis.local` and `umac@umac.local`. Use isolated worktrees and external
state directories as described in AGENTS.md. macOS noninteractive shells may
need `/Users/dictator/.homebrew/bin` and `/Users/dictator/.local/bin` on PATH.

* macOS: install tmux with `brew install tmux`; use the installed Claude
  executable, for example `/Users/dictator/.local/bin/claude`.
* Linux: install tmux with `sudo apt-get install tmux`; use
  `/home/umac/.local/bin/kimix` on umac (the Kimi K3 CLI wrapper).
  A user-local tmux installation also works when its library path and PATH
  are present in the reviewed `agentEnv.set`.
* Windows: use Claude's executable rather than a PowerShell/npm shim, for
  example `C:/Users/ondre/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe`.
  ConPTY is supplied by Windows; tmux is not required.

The local policy's `codingSessions` supports this additional agent:

```json
{
  "operationKeys": ["mcp.tools", "mcp.call"],
  "workspaceFolders": [],
  "codingSessions": {
    "roots": [{ "name": "work", "path": "/absolute/working/folder" }],
    "agents": {
      "terminal": { "command": ["/absolute/path/to/claude"], "args": [] }
    },
    "agentEnv": { "inheritUserSession": true },
    "maxLiveSessionsPerOwner": 3,
    "maxTurnMinutes": 45,
    "closeOnDaemonShutdown": false
  }
}
```

Supply this JSON through `configure --configuration-input-stdin` with the
executor's `--state-dir`, then `connect` and approve the resulting descriptor
revision in Nessie. Preserve other operations/folders in an existing policy;
the example is a standalone terminal-only proposal. A coding root may not
overlap executor state or a copy-on-write workspace root.
The reviewed descriptor explicitly declares `terminal: hostUser` authority.
Arguments are passed as argv, not shell-joined. Select the desired program
locally; the agent cannot supply a different executable to the start tool.

## Agent tools

`terminal_session_start({root, path?, title?})` starts the configured program.
`terminal_session_read({sessionId})` reads a bounded plain-text screen through
the normal owner and disclosure gates. `terminal_session_write({sessionId,
data})` sends exact key/text bytes, without adding a newline.
`coding_session_list`, `coding_session_interrupt` and
`coding_session_close` also cover these sessions. Results include a viewer
link the agent can give the person on request. A link does not grant access.

Send text and Enter separately when a CLI distinguishes paste from a keypress.
Usually Enter is `\r`, Ctrl-C is `\u0003`, and Up is `\u001b[A`.
Claude on Windows was verified with CSI-u Enter `\u001b[13;1u`; a plain
carriage return can insert a newline in its configured input mode.
The model reads the application screen to decide how to proceed. Nessie does
not classify prompts, infer completion or answer approvals with keyword rules.

## Sharing and relay boundary

The pairing owner with current access can add an active user in the same
organisation in **Share session**, or remove a viewer. The grant covers only
that session's screen and metadata, including available scrollback. It grants
no executor membership, input, close or reshare authority. Another machine
administrator receives no output access just by managing the machine.
Every list/read checks active membership and the explicit grant; revoked or
removed executors cannot be viewed. Poll failures hide the previous screen.

The daemon signs and epoch-fences outbound `/api/executor-daemon/session-views`
exchanges. Its private inventory populates `ExecutorHostSession` metadata;
the existing heartbeat still reports open sessions for teardown. Viewer demand
and encrypted snapshots live in Postgres so API instances need no shared
in-memory terminal connections. At most eight requested screens are returned
per exchange, prioritising recent viewer demand. Each snapshot is bounded to
256,000 characters. Content expires for readers after 30 seconds and is cleared
on a subsequent daemon exchange after demand expires. Session identity and
explicit grants persist. No organisation-wide event broadcasts carry bytes.
Sharing changes are audited without screen contents.

## Verification

`DATABASE_URL=... pnpm exec turbo run test:terminal --filter=@nessie/executor
--filter=@nessie/executor-manage` covers real concurrent PTYs, bridge
reconnection, independent teardown, owner isolation, encrypted relay, epochs,
sharing and revocation. Set DATABASE_URL even on hosts selecting only the
executor tests. Windows requires the native helper build above.

The explicit operator-run `executor/scripts/terminal-host-smoke.ts` starts
two real configured CLIs through the executor's MCP transport. Set
`NESSIE_TERMINAL_SMOKE_COMMAND` to a JSON argv array and run it with
`node --import tsx executor/scripts/terminal-host-smoke.ts`. Its stdin accepts
JSON lines: `{"index":0,"data":"text"}`, `{"action":"reconnect"}`,
`{"index":0,"action":"close"}`, and `{"action":"finish"}`.
It uses temporary work/state and cleans up only its own processes.
It is intentionally excluded from automatic CI because it uses real logins.

Headless browser coverage lives in `admin/e2e/executor-coding-sessions`,
including live screen updates and share/revoke. Browser Suites must be
dispatched explicitly for this surface, as required by AGENTS.md.

The implementation was verified on 2026-09-24 with two interactive Claude sessions
on Windows and macOS and two `kimix` (Kimi K3) sessions on Linux. Each host passed
bridge reconnection, closing one session and continuing the other. These checks
ran development executor builds in isolated worktrees, with temporary state.
