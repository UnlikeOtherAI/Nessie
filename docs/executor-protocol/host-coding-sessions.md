# Host coding sessions: the `coding-sessions` bridge

Back to the [protocol overview](overview.md). The design, and the reviews it
answers, are in
[the plan chapter](../plans/2026-09-22-executor-local-apps/coding-sessions.md).

An agent must *instruct* a coding agent, not code. On a host with no VM
backend the guest `coding.*` lane cannot run, so the executor ships its own
local MCP server that runs Claude Code or Codex as long-lived sessions the
agent drives by conversation. Unlike guest work, such a session acts with the
host OS user's full authority: their files, their git and SSH credentials,
their Claude or ChatGPT subscription.

## What exists today, and what does not yet

This chapter describes the executor side, which is built and tested. The
pieces that make it reachable from a run are not yet in place: the executor
does not yet generate the `coding-sessions` entry in its named MCP servers or
put the power facts in the signed descriptor, the daemon does not yet stamp
the reserved `_meta` keys below, and the control plane's rule — private
executor, pairing owner only, `EXECUTOR_CODING_SESSIONS_OWNER_ONLY` — and the
first-class agent tools are not written. Until the daemon stamps an owner,
every session tool refuses, so the bridge cannot be driven through a plain
`mcp.call`. The trust-table row for this bridge lands with the control-plane
rule.

## Two processes: a stateless bridge and one host per session

`nessie-executor serve-coding-session-mcp --config <abs>` is an MCP stdio
server on the official SDK. It holds nothing in memory, because the daemon's
60-second idle close, the reporter's probe and a daemon restart may kill it at
any moment. Every call reads what it needs from disk, writes a request if it
has to, makes sure a host is alive, and answers in well under five seconds.

Each session is owned by a detached
`nessie-executor coding-session-host --config <abs> --session <id>`: the same
executor entry, started with the bridge's exec arguments and environment (so a
development loader and `NESSIE_EXECUTOR_PACKAGED_CLI` survive), detached, its
output in the session's bounded `host.log`. It outlives the bridge and exits
once no agent is alive and no request waits, after removing its lock and
looking at the inbox once more.

```
<config dir>/coding-sessions/
  commands/<commandId>.json   first outcome of each executor command
  sessions/<id>/meta.json     bridge-written once: owner, agent, root, path, title
  sessions/<id>/session.json  host-written, at most one write per 500 ms
  sessions/<id>/events.jsonl  projected events, host-written, rotated at 16 MiB
  sessions/<id>/inbox/        requests, one file per executor command
  sessions/<id>/host.lock     the live host's heartbeat
  sessions/<id>/host.log, agent-stderr.log   bounded
```

The directory is owner-only (0700 on POSIX; the packaged native helper's DACL
on Windows, and inherited from the executor state directory in a development
run). A root may not overlap it or the config file, and roots may not nest.

### The lock and the spawn window

`host.lock` holds `{pid, token, protocolVersion, runtimeDigest, startedAt,
heartbeatAt}` and is rewritten every 2 s. It is stale once its heartbeat is
10 s old; a dead pid makes it stale sooner, but a live pid never keeps it
alive, because pids are reused. Takeover renames the stale lock aside and
recreates it with `wx`, and a host re-reads the lock on every heartbeat and
just before it starts an agent, exiting the moment the token is not its own.

The bridge writes `spawn.json` when it starts a host and starts no second one
while that marker is under 15 s old; the host deletes it once it holds the
lock. A bridge that meets a host running an older protocol or other code asks
it to retire after its current turn.

### Requests, replays and reads

Requests are hard-linked into `inbox/` under the executor command id the
daemon passes in `_meta['nessie/command']`, so they land whole or not at all.
Because the host deletes a request once it has acted, `commands/` is what makes
a replay harmless: the first call for a command id records its outcome, and
every later call with that id returns it and does nothing else.

Reads use a `generation.byteOffset.seq` cursor and consume only
newline-terminated lines. The bridge keeps a delivered cursor per session —
one owner per session, so per owner — and the model never has to carry one.
Status is derived at read time: a session still marked working whose host has
stopped heartbeating reads `interrupted` with reason `host_lost`, and a read
that finds requests waiting with no live or starting host starts one.

## Owners

The bridge reads three reserved `_meta` keys the model cannot reach
([executor-local-mcp.md](../standards/executor-local-mcp.md)):
`nessie/owner` (the owner key), `nessie/command` (the command id) and
`nessie/daemon-control`. A call without an owner is refused.
`session_list` shows only the caller's sessions, every other tool answers "No
such session" for somebody else's, the live-session quota is per owner, and
`session_close_all` needs the daemon-control marker. Claude's auto-memory is
off by default so it cannot carry anything between owners.

## The reviewed configuration

The `--config` file holds one closed `codingSessions` object: `roots`, `agents`
(`claude`: `command`, `args`, `permissionMode`, `allowedTools`,
`disallowedTools`, `model`; `codex`: `command`, `args`, `model`), `agentEnv`
(`inheritUserSession`, `pass`, `set`), `maxLiveSessionsPerOwner` (3),
`idleMinutes` (30), `maxTurnMinutes` (45) and `maxBudgetUsd`. Unknown keys are
refused. `codingSessionsConfigDigest` hashes the normalised form, defaults
included; when `NESSIE_CODING_SESSIONS_CONFIG_DIGEST` is set and differs, the
bridge refuses `session_start` and `session_send`, and a host starts or resumes
no agent — it still carries out interrupts and closes, which only stop things.

## The agents

### Claude Code (verified against 2.1.280)

One process per live host:
`-p --input-format stream-json --output-format stream-json --verbose
--replay-user-messages (--session-id|--resume) <uuid> --permission-prompts none
[--permission-mode] [--allowedTools …] [--disallowedTools …] [--model]
[--max-budget-usd] [args] --append-system-prompt <text>`.

- Ready is the `initialize` control response; its `account` is never read.
- A follow-up is a stdin user line carrying our uuid. It folds into a running
  turn at the next tool boundary, and messages and results do not map one to
  one, so a turn ends only when a result has arrived, no message of ours is
  still queued and no background task runs. A message that had *started* when
  a result arrived belongs to that turn, however late its `completed` event.
  A turn a finished background task starts on its own is reported with its
  `origin`.
- Interrupt is a control request; close is `end_session`, end of stdin, and
  the tree kill five seconds later.
- `--permission-prompts none` was verified live: anything that would prompt is
  denied without a control request, and the denial arrives in the result's
  `permission_denials`, which the session reports as `permissionDenials`. The
  driving model never answers a prompt. `total_cost_usd` is a per-process
  running total, so each result carries its delta.

### Codex (failure path verified against 0.155.1)

One `exec --json` process per turn, the prompt on stdin, resumed with
`exec [args] -C <folder> resume <threadId> --json -`. The owner's `args` go
before `resume`: 0.155.1 refuses `--sandbox` after it. With the ChatGPT quota
spent, a turn prints `thread.started`, `turn.started`, `error` and
`turn.failed`, and exits 1; resuming an unknown thread prints only to stderr.
Messages sent during a turn start the next one; interrupt kills the turn's
tree. Item shapes other than the failure path stay unverified until a live
turn can run, and unrecognised events are kept as `system` events naming only
their type.

### Environment and self-check

The MCP SDK gives the bridge a minimal environment, so with
`inheritUserSession` the host rebuilds a login-like one: the machine and user
`Environment` registry keys on Windows; `launchctl getenv` and the login
shell's `env -0` on macOS; `systemctl --user show-environment` and the login
shell on Linux. It strips only `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`,
`CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_MESSAGING_SOCKET`,
`CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH` and the executor's own two markers,
then applies `pass` and `set`. Before an agent starts, the host checks
`git --version`, the agent's `--version` and login status, and `gh auth status`
when `gh` is installed; a failure makes the session `failed` with
`agent_missing`, `agent_not_logged_in`, `git_missing`, `gh_not_authenticated`,
or `unsupported_supervisor` (the Windows service's virtual account).

## Containment and teardown, per supervisor

| Host | How the session host runs | Survives a daemon restart | How the tree dies |
| --- | --- | --- | --- |
| Windows, desktop companion or hand-run daemon | detached; a packaged runtime starts the agent through the native helper's `job-run`, which holds it in a Job Object with `KILL_ON_JOB_CLOSE` | yes | the helper exits with the agent, and ends the job at once when the host dies; closing or killing the helper kills everything in the job. A development run has no verified helper and uses `taskkill /T /F` by its absolute System32 path |
| Windows service (virtual account) | refused: the session fails with `unsupported_supervisor` | — | — |
| macOS | detached, its own session | yes | group kill, then a sweep of every descendant in a `ps -A -o pid=,ppid=,pgid=` snapshot taken before signalling |
| Linux with a reachable user manager | `systemd-run --user --collect --unit nessie-coding-<sessionId> -p KillMode=control-group -p TimeoutStopSec=10` | yes, and it can never block the executor unit's stop | the unit's cgroup dies with the host; a closing host stops its own unit |
| Linux without one | detached (`setsid`) | no | as macOS |

`job-run -- <program> [args…]` starts the program suspended, assigns it to
the job and only then resumes it, so nothing the agent runs is ever outside
the job — including a grandchild whose parent already exited, which
`taskkill /T` cannot find. stdin, stdout and stderr pass straight through
and the helper exits with the program's code; its own refusal goes to stderr
with exit code 125 (`EXECUTOR_JOB_SPAWN_FAILED` reads as `agent_missing`,
`EXECUTOR_JOB_CONTAINMENT_FAILED` and `EXECUTOR_JOB_PARENT_GONE` as
`containment_failed`). The recorded agent identity is then the helper's.

The Windows service refusal reads the token, not only the marker:
`NESSIE_EXECUTOR_SUPERVISOR=service`, or a SID from `whoami /user` (by its
System32 path) that is LocalSystem, LocalService, NetworkService or a virtual
service account (`S-1-5-80-…`). None of them has a Claude login or a user
profile.

The Linux unit gets the bridge's environment through `--setenv` (a transient
unit starts from the manager's environment, not its caller's), its output in
the session's `host.log`, and `NESSIE_CODING_SESSION_UNIT` naming itself.
`XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`, which the MCP SDK strips,
are derived from `/run/user/<uid>`. When `systemd-run` refuses — no manager,
an older systemd without `StandardOutput=append:`, a unit of that name still
loaded — the host starts detached instead, and the lock still decides which
host serves the session.

Every kill checks the recorded pid and start time, so a reused pid is never
signalled, and a new host stops a lost host's still-running agent before it
resumes the session.

## What the bridge reports

Events are projected per kind with fixed caps — assistant 2 000 characters,
tool and tool result 300 (errors 1 000), result 4 000 — and init's `cwd`,
`memory_paths` and `mcp_servers`, rate-limit state and the initialize account
are never read into one. Every absolute path under a root becomes
`<root>/relative` and every other absolute path `<host path>`, in all its
spellings (slashes, case, `\\?\`, `/c/…`, JSON-escaped), and each answer is
rewritten once more, string by string, on its way out.

`session_status` never waits and answers at most 8 KB, `status`,
`nextCursor` and `pendingNotice` first. `session_review` runs read-only git in
the session's folder within 20 s: branch, the base commit recorded at start,
commits since, `git diff --stat`, uncommitted and untracked counts, worktrees
created under the root since the start, `gh pr view` per branch when `gh` is
installed, and the last test command with its exit code.

## Verifying

```bash
pnpm --filter @nessie/executor run test:mcp
```

`scripted-coding-agent.mjs` speaks both protocols as the real CLIs printed
them, and the subprocess suites drive a real bridge through the daemon's own
MCP session manager; they run on Windows and Linux alike. The live cycle —
start, follow-up, a denied `git push`, review and close against a logged-in
Claude Code, and a Codex turn — needs real subscriptions and is not automated.
