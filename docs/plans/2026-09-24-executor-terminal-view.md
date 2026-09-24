# Executor terminal sessions

Status: implementation in progress.

The owning surface is an executor's session detail, reached from its Local
apps session list and from a link returned to an agent supervising a session.
The person watches only; keyboard input remains an agent operation under the
existing reviewed local-apps binding, private-executor pairing-owner rule and
disclosure boundary. Opening a view never launches a process.

Existing Claude/Codex sessions expose their projected activity. A separately
reviewed `terminal` program adds a real PTY on macOS, Windows and Linux, including
interactive programs such as `kimix`. The configuration names the executable,
arguments and roots locally. Its descriptor explicitly states `hostUser`
authority. It does not turn the guest command lane into a host shell.

The existing session host owns lifecycle, quotas, command replay protection,
containment and teardown. On macOS and Linux a terminal child owns a dedicated
foreground tmux server, with an owner-only socket separate from personal tmux.
On Windows the native helper owns ConPTY, rendered by xterm's headless emulator.
Fixed terminal dimensions keep different
viewers from resizing the agent's screen. Bounded serialized screen snapshots
include scrollback and ANSI state, so reloads and missed frames recover the
screen without replaying incomplete escape sequences.

Viewer demand and encrypted snapshots live in Postgres, not an API process.
The executor exchanges signed, epoch-fenced snapshots over an outbound polling
lane. The pairing owner with current executor access can read and explicitly
share an individual session with active users in the same organisation.
Recipients get view-only output access and cannot reshare, close or type.
Every poll rechecks membership and grants. Revocation hides the screen on the
next poll. An administrator's machine-management access alone grants no content.
Snapshots are short-lived; the durable session state stays on the machine.
Terminal bytes are never broadcast to an organization or logged in audit.
Persistent metadata and grants live in the control plane's host-session registry.
Executors → Sessions lists owned and explicitly shared sessions. The same detail
page opens from a machine's Sessions tab or an agent's returned viewer link.

Verification must cover owner isolation, stale epochs, independent concurrent
sessions, reconnect/reload, input and full-screen ANSI rendering, teardown and
headless browser screenshots. Real-host checks run Claude on dictator (macOS)
and Minis (Windows), and `kimix` on umac (Linux), from this branch in isolated
worktrees and state folders. Verification results remain pending.
