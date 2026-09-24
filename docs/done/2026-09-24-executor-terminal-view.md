# Executor terminal sessions

Status: implemented; release gated by PR checks.

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

Verification on 2026-09-24:

- Windows (Minis): two real Claude sessions launched through the executor's
  MCP transport; both answered prompts. After reconnecting the bridge and closing
  one session, the other answered another prompt.
- macOS (dictator): the same checks passed with two real Claude sessions in tmux.
- Linux (umac): the same checks passed with two real `kimix` sessions using Kimi K3
  in tmux. User-local Node and tmux were installed without changing other checkouts.
- Real PTY tests passed on all three hosts: concurrent session isolation, ANSI
  screens, bridge restart, owner denial and independent teardown.
- Postgres tests passed for encrypted snapshots, independent viewer demand,
  immutable ownership, stale epochs, explicit sharing and revocation.
- Headless Playwright verified the owner and shared-recipient viewers, live updates,
  sharing/removal, access revocation and mobile layout. Screenshots were inspected.
- API, worker, executor and admin type checks passed through Turbo.

Native CLI checks used isolated development worktrees and temporary state folders;
they do not assert that a production installer has already shipped.
