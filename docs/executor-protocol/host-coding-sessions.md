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

This chapter describes the executor side, which is built and tested: the
bridge and its hosts, containment per supervisor, the configuration the
executor generates the `coding-sessions` server from, the power facts in the
signed descriptor, the reserved `_meta` the daemon stamps, and the daemon's
teardown. What makes it reachable from a run is the control plane's, and is
not written yet: the worker stamping `owner` on the `mcp.call` payload, the
rule that refuses anyone but a private executor's pairing owner
(`EXECUTOR_CODING_SESSIONS_OWNER_ONLY`), the first-class agent tools, the API
producing `codingSessionClose`, and the review and admin rendering of the
facts and sessions below. Until the worker stamps an owner every session tool
refuses, so the bridge cannot be driven through a plain `mcp.call`. The
overview's trust table already says that its guest-coding row does not cover
this bridge; the bridge's own row lands with the control-plane rule.

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
  agent-help.json             what each installed CLI's --help offers, per
                              program path, size and modification time
  sessions/<id>/meta.json     bridge-written once: owner, agent, root, path, title
  sessions/<id>/session.json  host-written, at most one write per 500 ms; the
                              agent's identity and session id are written at once
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
It writes `session.json` only while the lock is its own, so a host that lost a
takeover race never overwrites the winner's state. A lock or state file that
exists but cannot be read — a Windows scanner or backup tool holding it — is
read again for about a second and is never taken for a missing one: a host
keeps a lock it cannot read for a moment, and refuses to serve rather than
reset a state file it cannot read.

The bridge writes `spawn.json` when it starts a host and starts no second one
while that marker is under 15 s old; the host deletes it once it has served
its first requests. The marker counts the hosts started since one last
served, so a host that dies before serving — a configuration it cannot load,
a runtime that cannot start — is not started for ever: after three, the
waiting requests get no more hosts and the session reads
`host_failed_to_start` (`failed` before its first turn, `interrupted` and
resumable after). Each new request gets three attempts of its own. A bridge
that meets a host running an older protocol or other code asks it to retire
after its current turn, and a request that arrived behind the retirement goes
to a successor the retiring host starts from the entry as installed now.

### Requests, replays and reads

Requests are hard-linked into `inbox/` under the executor command id the
daemon passes in `_meta['nessie/command']`, so they land whole or not at all.
Because the host deletes a request once it has acted, `commands/` is what makes
a replay harmless: the first call for a command id records its outcome, and
every later call with that id returns it and does nothing else.

Reads use a `generation.byteOffset.seq` cursor and consume only
newline-terminated lines. The bridge keeps a delivered cursor per session —
one owner per session, so per owner — and the model never has to carry one.
Every event line is at most 4 KiB — a longer one (JSON escaping and Czech
text make 4 000 characters far more bytes) is shortened field by field when
it is written — so one event always fits a read and an 8 KB answer, and
every read moves the cursor: events are halved down to one, a long final
result is cut next, and a line longer than the read window that got into the
file anyway is skipped whole with a notice. A rotation whose rename Windows
refuses is retried like every other rename and otherwise tried again half a
minute later, and the new generation reaches `session.json` at once rather
than after the debounce, so a reader never pairs the new file with the old
generation.

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
`session_close_all` and `session_list_all` need the daemon-control marker.
Claude's auto-memory is off by default so it cannot carry anything between
owners.

The owner is stamped by the worker, never taken from the model: the `mcp.call`
payload is `{args, runId, owner?}` (`ExecutorMcpCallPayloadSchema`, strict),
with `owner: {agentId, actorUserId}` beside `runId` and under the argument
digest. For calls to the executor's own bridge only, the daemon derives
`_meta['nessie/owner'] = sha256:` + hex SHA-256 of
`executorCodingSessionOwnerKeyInput(executorId, owner)` — the three ids
joined by a vertical bar — and sets `_meta['nessie/command']` to the command
id. "Its own bridge" is structural: the server named `coding-sessions` whose
argv ends `serve-coding-session-mcp --config <path>` and whose environment
pins the digest the descriptor states. No other server receives any `_meta`,
and the model's `arguments` are passed on untouched either way.

## The reviewed configuration

The owner configures the bridge through
`configure --configuration-input-stdin`, whose JSON gains a `codingSessions`
object (`null` withdraws the bridge, absent keeps it). That object is closed:
`roots`, `agents` (`claude`: `command`, `args`, `permissionMode`,
`allowedTools`, `disallowedTools`, `model`; `codex`: `command`, `args`,
`model`), `agentEnv` (`inheritUserSession`, `pass`, `set`),
`maxLiveSessionsPerOwner` (3), `idleMinutes` (30), `maxTurnMinutes` (45),
`maxBudgetUsd` and `closeOnDaemonShutdown` (false). Unknown keys are refused.
`permissionMode` is checked for its shape only (a letter, then up to 39
letters, digits, `_` or `-`): which modes exist is the installed CLI's to
say, so the host checks it against the choices the CLI's own `--help` lists
before every start (see "Environment and self-check"), and a mode a newer
Claude Code adds needs no executor release.

An agent's `args` and `command` may not carry what the facts below would not
show. For Claude that is every flag that bypasses, widens or relocates its
permissions or its settings — `--dangerously-skip-permissions`,
`--allow-dangerously-skip-permissions`, `--permission-mode`,
`--permission-prompts`, `--permission-prompt-tool`, `--allowedTools`,
`--disallowedTools`, `--tools`, `--add-dir`, `--settings`,
`--setting-sources`, `--mcp-config`, `--plugin-dir`, `--agents` and the
like — plus the protocol flags the bridge sets itself; the typed fields say
the same things where the review can show them. For Codex it is `-c` /
`--config` overrides, `--enable` / `--disable`, `--profile`, `--add-dir`,
`-C`, `--dangerously-bypass-hook-trust`, `--ignore-rules` and the `exec` /
`resume` subcommands; its stance flags (`--sandbox`, `--full-auto`,
`--approve-for-me`, `--dangerously-bypass-approvals-and-sandbox`) are what
the stance fact names. A `command` that names a `.cmd`, `.bat` or `.ps1`
shim is refused too: nothing without a shell can run one, and the job helper
resolves only programs, so the owner names `claude.exe` or `node` and
`codex.js` instead.

The executor then:

- writes it owner-only to `<state dir>/coding-sessions.json`, as given — the
  bridge's own state lives beside it in `<state dir>/coding-sessions/`;
- refuses a root that overlaps a workspace folder, the executor state
  directory, the bridge state directory or the config file, comparing
  canonical paths and folding case on Windows and macOS, and a root that does
  not exist;
- generates the `coding-sessions` server itself — `[execPath, …execArgv,
  entry, 'serve-coding-session-mcp', '--config', <path>]` with
  `NESSIE_CODING_SESSIONS_CONFIG_DIGEST` and, when packaged,
  `NESSIE_EXECUTOR_PACKAGED_CLI=1` — and refuses a hand-named server of that
  name;
- refuses the bridge unless `mcp.tools` and `mcp.call` are enabled;
- adds `codingSessions` to the signed descriptor, inside `localPolicyDigest`:
  `{serverName, agents, permissionMode, allowedToolCount, environmentNames,
  rootNames, configDigest}`. Claude's mode is its `permissionMode`
  (`default` when unset); Codex's is the stance its reviewed `args` take
  (`bypassApprovalsAndSandbox`, `fullAuto`, `approveForMe`,
  `sandbox:<mode>` or `default`). `environmentNames` lists, sorted and by
  name only, every variable `agentEnv.set` sets or `agentEnv.pass` passes:
  a `CLAUDE_CONFIG_DIR` or an `ANTHROPIC_BASE_URL` changes what an agent may
  do, or where its transcript goes, as surely as a flag.

Both CLIs still read their own configuration on this machine — Claude Code
its user, project and local settings (`~/.claude/settings.json`, a
repository's `.claude/settings*.json`), Codex its `~/.codex/config.toml` —
and those can pre-allow commands or set a default mode. The bridge leaves them
in force, because they are how the person has set up the CLI they are logged
into, and does not summarise them: `default` in the facts means "as this
machine's own settings for that CLI say", and a review should read it so.

On Windows, Claude Code 2.1.280 also runs commands through its own
`PowerShell` tool, which a `Bash(…)` rule does not cover: live, a
`git worktree add` it chose to run there was denied under `Bash(git *)` and
reported in `permissionDenials`, and the model redid it through Bash. A
`PowerShell(git *)` prefix rule did not pre-allow `git status --short` on that
machine either (the CLI reported its PowerShell parse failing); only a bare
`PowerShell` rule did, and that allows every PowerShell command.

`codingSessionsConfigDigest` hashes the normalised form, defaults included, so
`configDigest` covers even what no fact names. When the file on disk hashes to
anything else, neither the bridge nor a host resolves the roots it names, the
bridge answers every tool but `session_close`, `session_interrupt` and the
daemon's `session_close_all` and `session_list_all` with
`coding_session_config_changed` — so no listing, status or review reaches a
folder nobody reviewed — and a host starts or resumes no agent. Interrupts
and closes, which only stop things, still work. A state file whose facts and generated entry disagree
is malformed and refuses to load. `describe` shows the facts and the config
file's path.

## The agents

### Claude Code (verified against 2.1.280)

One process per live host:
`-p --input-format stream-json --output-format stream-json --verbose
--replay-user-messages (--session-id|--resume) <uuid> --permission-prompts none
[--permission-mode] [--allowedTools …] [--disallowedTools …] [--model]
[--max-budget-usd] [args] --append-system-prompt <text>`.

- Ready is the `initialize` control response. The answer is dropped; its
  account's e-mail and organisation become redactions in the host's memory
  (see "What the bridge reports") and are never written anywhere.
- A follow-up is a stdin user line carrying our uuid. It folds into a running
  turn at the next tool boundary, and messages and results do not map one to
  one, so a turn ends once a result has arrived and no message of ours is
  still queued. A message that had *started* when a result arrived belongs to
  that turn, however late its `completed` event.
- Background tasks hold no turn open: a dev server or a watcher runs for as
  long as the agent does, and a turn waiting on one would never end. The
  session reports `backgroundTasks` while any run, and the turn one of them
  starts when it finishes is reported with its `origin`. An idle agent is
  still ended after `idleMinutes`, background tasks and all.
- Interrupt is a control request. Its answer cancels every message of ours
  that had not started, except those it lists as `still_queued`, so a message
  the CLI dropped never keeps the session busy. Close is `end_session`, end of
  stdin, and the tree kill five seconds later.
- `maxTurnMinutes` interrupts a turn that runs past it. Any interrupt whose
  turn has not ended 30 s later (or after the turn limit, when that is
  shorter) ends the agent process instead, with the session `interrupted`
  and resumable (reason `max_turn_minutes` when the limit asked).
- `--max-budget-usd` is counted against the CLI's per-process running total
  (`total_cost_usd` accumulates across turns), so with `maxBudgetUsd` set, a
  message that would start a new turn in a process that has already spent
  something goes to a fresh process resuming the same session: every turn
  starts with the whole budget. A process with background tasks still running
  is kept, because a restart would end them. Whether 2.1.280 applies the
  budget per process or per turn was not measured; the restart is right either
  way.
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
`Environment` registry keys on Windows (read through PowerShell as UTF-8 —
`reg query` writes a redirected answer in the console's OEM code page, which
garbles a profile such as `C:\Users\Ondřej` and every path under it);
`launchctl getenv` and the login
shell's `env -0` on macOS; `systemctl --user show-environment` and the login
shell on Linux. It strips only `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`,
`CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_MESSAGING_SOCKET`,
`CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH` and the executor's own markers
(`NESSIE_EXECUTOR_PACKAGED_CLI`, `NESSIE_CODING_SESSIONS_CONFIG_DIGEST`,
`NESSIE_EXECUTOR_SUPERVISOR`, `NESSIE_CODING_SESSION_UNIT`), then applies
`pass` and `set`. Before an agent starts, the host checks
`git --version`, the agent's `--version`, what the agent's `--help` offers, its
login status, and `gh auth status` when `gh` is installed; a failure makes the
session `failed` with `git_missing`, `agent_missing`, `agent_outdated`,
`permission_mode_unsupported`, `agent_not_logged_in`, `gh_not_authenticated`,
or `unsupported_supervisor` (the Windows service's virtual account). The
read-only probes run side by side and are judged in that order; the login is
asked only after the help, because a CLI too old for `auth status` would
otherwise read as logged out.

The help check proves the installed CLI accepts every flag the adapter will
pass, so an outdated CLI is refused with `agent_outdated` before it starts
rather than dying on its first message with an argument error. The flags
required are the adapter's own argv, fresh and resumed, so a flag the adapter
gains is required with it:

- Claude Code (`claude --help`): `-p`, `--input-format`, `--output-format`,
  `--verbose`, `--replay-user-messages`, `--session-id`, `--resume`,
  `--permission-prompts` and `--append-system-prompt`; then
  `--permission-mode`, `--allowedTools`, `--disallowedTools`, `--model` and
  `--max-budget-usd` when the configuration turns each on; and every flag in
  the owner's `args`. A configured `permissionMode` must be one of the
  `(choices: …)` that `--permission-mode` lists (2.1.280: `acceptEdits`,
  `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan` — no `default`),
  or the start fails with `permission_mode_unsupported`.
- Codex (`codex exec --help` and `codex exec resume --help`): each help's
  `Usage:` line must name its subcommand (a codex without `exec resume`
  answers that help with the `exec` one); `-C` and `--json` on `exec`,
  `--json` on `exec resume`, which parses it there; `-m` with a `model`; and
  the owner's `args`. codex-cli 0.155.1's `exec` lists no `--full-auto`, so a
  configuration that still passes it is refused this way too.

Only option lines are read — a flag a description merely mentions (2.1.280
names `--permission-prompt-tool` only inside `--permission-prompts`'s text)
does not count. Each help gets 15 s and 256 KiB. What it offers is cached in
`agent-help.json` per agent and per real path, size and modification time of
each file in the agent's `command` (a bare name is found on the agent
environment's `PATH`), so an updated CLI is read afresh and an unchanged one
once; a help that could not be read is not cached. The host log names what
was missing; the session carries only the categorical reason.

## Containment and teardown, per supervisor

| Host | How the session host runs | Survives a daemon restart | How the tree dies |
| --- | --- | --- | --- |
| Windows, desktop companion or hand-run daemon | detached; a packaged runtime starts the agent through the native helper's `job-run`, which holds it in a Job Object with `KILL_ON_JOB_CLOSE` | yes | the helper exits with the agent, and ends the job at once when the host dies; closing or killing the helper kills everything in the job. A development run has no verified helper: it starts the agent through the agent guard, and it and the guard kill the tree they can see pid by pid, through one PowerShell (by its absolute System32 path) that reads the table and terminates each process through a handle it holds while it checks that process's start time; a packaged runtime whose helper is missing starts no agent (`containment_failed`) |
| Windows service (virtual account) | refused: the session fails with `unsupported_supervisor` | — | — |
| macOS | detached, its own session; the agent runs under the agent guard | yes | group kill, then a sweep of every descendant in a `ps -A -o pid=,ppid=,pgid=,lstart=` snapshot taken before signalling (`/proc` on Linux); SIGTERM first, SIGKILL two seconds later — three when the guard does it because the host died |
| Linux with a reachable user manager | `systemd-run --user --collect --unit nessie-coding-<sessionId> -p KillMode=control-group -p TimeoutStopSec=10` | yes, and it can never block the executor unit's stop | the unit's cgroup dies with the host; a closing host stops its own unit |
| Linux without one | detached (`setsid`); the agent runs under the agent guard | no | as macOS |

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
profile. The MCP SDK's minimal environment drops the marker, so the daemon
adds its own `NESSIE_EXECUTOR_SUPERVISOR` to the bridge's environment when it
starts it, and to no other server's.

The Linux unit gets the bridge's environment through `--setenv=NAME` (a
transient unit starts from the manager's environment, not its caller's); only
names go on `systemd-run`'s command line, which copies its own values, so no
value is readable in its `/proc/<pid>/cmdline`. Its output goes to the
session's `host.log`, and `NESSIE_CODING_SESSION_UNIT` names the unit.
`XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`, which the MCP SDK strips,
are derived from `/run/user/<uid>`. `systemd-run` gets two seconds; one that
timed out may have started the unit anyway, so the unit is asked
(`systemctl --user is-active`) before a second host is started beside it.
When `systemd-run` refuses — no manager, an older systemd without
`StandardOutput=append:` or name-only `--setenv`, a unit of that name still
loaded or deactivating — the host starts detached instead, says so in
`host.log` (a detached host shares the executor's cgroup, so an executor
restart can stop it), and the lock still decides which host serves the
session. The daemon's close-all asks every session's host side by side, so
many sessions do not add up past the call's budget.

Every kill checks the recorded pid and start time, so a reused pid is never
signalled, and a new host stops a lost host's still-running agent before it
resumes the session. The tree is held to the same rule: descendants are read
only below a root that is still the recorded process (the children of
whoever inherited its pid are nobody's this host started), each carries its
own start time, and each is checked again right before its own signal — never
`taskkill /T`, which walks parent ids as they are at that moment. On Windows
that check and the kill share one handle, so not even the moment between
them can hand the pid on, and the whole kill is one PowerShell: the table,
then the root, then each member. An identity without a start time is
unknown and is never signalled. A start time that
cannot be read while the process is alive — PowerShell or `ps` timing out
under load — is read again; an agent whose start time still cannot be read is
stopped through the host's own handle at once and its start fails with
`containment_failed`, because nothing could later tell it from a reused pid.
macOS start times are read in UTC and the C locale, so a laptop that changes
time zone still recognises its agent. On POSIX a tree gets SIGTERM and two
seconds before SIGKILL, so a `git` caught mid-commit can remove its
`index.lock`. What the next host needs, the agent's identity and its
confirmed session id, skips the 500 ms debounce, and a session id the agent
never confirmed is dropped: Claude refuses `--session-id` for an id it already
holds, so the next agent starts afresh rather than failing on every send.

### The agent guard: no agent outlives its host

On macOS, on Linux without a unit of its own and in a Windows development
run, nothing else would end an agent whose host was SIGKILLed or ran out of
memory: it saw its stdin close and finished the turn it was in, editing the
worktree unobserved, its result unrecorded. (On Windows libuv's own
kill-on-close job took the agent with its host, but not the agent's
children.) So there the host starts the agent through
`nessie-executor coding-session-agent-guard` — the same entry, runtime
arguments and environment as the host, from the host's folder — and a
packaged Windows host (the Job Object) or a Linux host in its unit (the
cgroup; `NESSIE_CODING_SESSION_UNIT` names it and `/proc/self/cgroup` must
agree) does not.

- **One inherited pipe.** The guard is started detached (on Windows every
  other child is in its parent's kill-on-close job, which would end the guard
  with the host before it could act) with Node's IPC channel at fd 3. The
  agent's argv, folder and environment arrive on that pipe, never on the
  guard's command line; a guard told nothing for 30 s refuses.
- **The agent's own identity.** The guard starts the agent as its child in a
  process group of its own (detached on POSIX, hidden on Windows), reads its
  start time, and reports `{pid, startedAt}` on the pipe before it relays
  anything. That is the identity the host records, so every kill the host
  makes goes to the agent and never to the guard; an agent whose start time
  cannot be read is stopped at once.
- **Transparent otherwise.** stdin, stdout and stderr are relayed, and the
  guard exits with the agent's code, or dies of its signal, once the agent's
  output is read. Its own refusals go to stderr with exit code 125, as the job
  helper's do: `EXECUTOR_GUARD_SPAWN_FAILED` reads as `agent_missing`,
  `EXECUTOR_GUARD_CONTAINMENT_FAILED` and `EXECUTOR_GUARD_NO_AGENT` as
  `containment_failed`.
- **The pipe closing is the host dying,** however it died. The guard then
  kills the agent's group and tree with the same identity-checked calls the
  host uses — SIGTERM, SIGKILL three seconds later on POSIX; pid by pid on
  Windows, never `taskkill /T` — and exits. On Windows the guard starts that
  kill's PowerShell as soon as the agent has an identity and holds it ready
  (it exits with the guard, unused): cold, a PowerShell and its CIM module
  took most of the five seconds on a loaded machine; ready, the same kill
  took under one there. A dead host closes the
  guard's stdin too, so the end of the agent's input is also sent on the pipe
  when the host means it: stdin ending alone never lets the agent finish its
  turn on its own.

A guard killed outright cannot act; on Windows the agent is in the guard's own
kill-on-close job and dies with it, and elsewhere the next host started for
the session stops the agent before doing anything else, as it always has.

### Teardown reaches the machine

Sessions outlive runs and daemon restarts, so the daemon ends them itself
(`executor/src/coding-sessions-daemon.ts`), always through the bridge's
daemon-only `session_close_all {ownerKey?, sessionId?, reason}`:

- **When the daemon's authority provably ends.** A failed command poll or
  heartbeat alone closes nothing: sessions are built to outlive a dropped
  connection, and a network blip, an API deploy or the reclaim after a fence
  must not end every long turn on the machine for good. Every session closes
  when the API answers that the executor is unknown or revoked
  (`EXECUTOR_NOT_FOUND`) or refuses its proof (`EXECUTOR_DAEMON_PROOF_INVALID`)
  — to a poll, a heartbeat or the reclaim, with that call's reason
  (`command_poll_failed`, `heartbeat_failed`, `claim_failed`) — and when no
  heartbeat has succeeded for ten minutes (`connection_lost`). The daemon
  stops its other, run-bound sessions on every failure as before. It keeps the
  owner keys it has dispatched for; sessions from an earlier daemon life may
  exist, so the first such teardown after start closes everything, and after
  one has succeeded a teardown with no owner dispatched since is skipped
  rather than starting a bridge to close nothing.
- **On the heartbeat's instruction.** The heartbeat response
  (`ExecutorDaemonHeartbeatResponseSchema`) may carry
  `codingSessionClose: [{ownerKey, sessionId?, reason}]`, sent when a lease
  ends, access is revoked, the executor is paused or a person presses Close.
  The daemon validates the list itself, so a field it does not know never
  fails a heartbeat, and closes each owner's sessions (or the one named)
  beside the heartbeat rather than in it. An instruction the bridge could not
  carry out — a bridge in its start-failure backoff, a call that timed out —
  is kept (up to 64) and tried again on every later heartbeat until it lands,
  so a revoked lease or a person's Close is never dropped. The API may repeat
  an instruction while the session is still reported open; repeating one that
  already landed is harmless.
- **At shutdown**, only when the reviewed configuration sets
  `closeOnDaemonShutdown` — or when the file no longer matches its review,
  which cannot be trusted to have opted out. The call gets five seconds and
  runs before the MCP session stops.

The same daemon-only `session_list_all` feeds the local-MCP report: for
`coding-sessions` its status carries `codingSessions`, each open session's
`sessionId`, `ownerKey`, `title`, `status` (with a categorical `reason`),
`agent`, `root` and `updatedAt`, newest first and at most 32 — never a prompt,
a transcript or a path. Absent means the bridge was not asked.

## What the bridge reports

Events are projected per kind with fixed caps — assistant 2 000 characters,
tool and tool result 300 (errors 1 000), result 4 000 — and init's `cwd`,
`memory_paths` and `mcp_servers`, rate-limit state and the initialize account
are never read into one. Every absolute path under a root becomes
`<root>/relative` and every other absolute path `<host path>`, in all its
spellings (slashes, case, `\\?\`, `/c/…`, JSON-escaped), and each answer is
rewritten once more, string by string, on its way out. A directory name with
spaces (`C:\Program Files\Git`, another account's `C:\Users\Other Person`)
is taken whole — a space-separated word a separator follows is still part of
the path — and every profile directory beside the host user's, and the
program directories, are named outright so a spaced last component is too.

The OS user and host names leave no more than the paths do. In the live
Windows run git printed `unable to auto-detect email address (got
'ondre@Minis.(none)')`; npm, a Git Bash prompt and `whoami` print the same
names with no path around them. So after the path rules the same rewriter
spells the user `<user>` and the host `<host>`, as whole words and
case-insensitively, in every projected field and every answer. The user's
names are `os.userInfo()`, `USERNAME`, `USER` and `LOGNAME` — not the home
directory's own name, which under a container or a service account is
`/app`, `/workspace` or `/tmp`. The host's are `os.hostname()` and
`COMPUTERNAME`, each whole and by its first label; on Windows
`<short>.<USERDNSDOMAIN>` on a domain and the NetBIOS form (its first 15
characters); elsewhere the FQDN forms the machine states itself, the
`/etc/hosts` aliases of the short name and `<short>.<domain>` for each
`/etc/resolv.conf` search domain, so git's `ondre@minis.corp.acme.com` leaves
no DNS domain behind. The `os` answers matter most: the MCP SDK's minimal
environment carries no `COMPUTERNAME`.

Some names are left alone. One shorter than three characters, and one any
machine may carry — `root`, `user`, `admin`, `localhost` and their like, the
usual defaults of CI runners, containers and cloud images (`runner`,
`ubuntu`, `node`, `app`, `vscode`, `ec2-user`, `dev`, `api`, `build`, …; the
list is `GENERIC_NAMES` in `host-identity.ts`), and the coding agents' own
`claude` and `codex` — would rewrite ordinary words, relative paths and fixed
values, and hide nobody. So is a name inside a word (a user `dan` leaves
`redundant` as it is), and a match that is one whole segment of a relative
path or a URL's path, with a single `/` or `\` before it and one after:
absolute paths were already rewritten whole, so such a segment is a
repository's own folder (`src/ondre/x.ts`) or a URL's owner
(`github.com/ondre/app`), and rewriting it would hand the model a path that
does not exist. Two separators before a name are a URL's host or a UNC
server, and are rewritten. The placeholders already written and UUIDs (a
session id's hex group may spell a short host name) are never rewritten
again.

The last pass over an answer gives the path rules alone, without the names,
to the fields other code parses as fixed values — `sessionId`, `ownerKey`,
`agent`, `status`, `reason`, `root`, `path`, the timestamps, `baseCommit`,
`code`, `nextCursor`, `kind`, `subtype`, and a pull request's `state`,
`mergeable` and `url` (`FIXED_VALUE_KEYS` in `bridge-server.ts`). A root
named after its user would otherwise come back as `root: '<user>'`, which
`session_start` cannot resolve, and the daemon's report would drop every
session whose `agent` or `root` no longer passed its schema. A pull
request's URL keeps its owner for the same reason and because it names the
repository, not the machine: the link is the one thing in a review a person
follows.

Credentials are scrubbed before anything else and read `<secret>`. A coding
agent runs `gh auth token`, `printenv` or `cat .env`, or pastes a header into
`curl`, and its command and output are exactly what the events carry. So the
values the host gave it — every `agentEnv.set` value, and every inherited
variable whose name says credential (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`,
`*API_KEY*`, …) — are redactions for that host's life, and anything shaped like
a GitHub, Anthropic, OpenAI, Slack or AWS key, a JWT, a bearer header, a
private key block or a `NAME=value` whose name says credential is replaced
wherever it appears.

The model itself knows who is logged in and repeats it: in the live Windows
run, Claude Code met a repository with no git identity and typed the account's
e-mail into `git config --global user.email`. So the e-mail and organisation
from the initialize answer are redactions for the rest of that host's life,
and every projected string spells them `<account>`. Codex's `exec` stream
names no account, but the model behind it knows it just the same, so the
e-mail and name in the id token's claims in Codex's own `auth.json` are read
at start (held in memory, no token used) and redacted the same way. A
command or an edit Codex declined (`status: "declined"` on the item, a shape
from the 0.155.1 binary not yet seen live) is a permission denial on its
result, as Claude's are. `session_review` runs in the
bridge, which never sees the account; its commit subjects are the agent's own
words.

`session_status` never waits and answers at most 8 KB, `status`,
`nextCursor` and `pendingNotice` first. `session_review` runs read-only git in
the session's folder within 20 s, in the same login-like environment the
agents get (the MCP SDK's minimal `PATH` finds no Homebrew `gh` on macOS):
branch, the base commit recorded at start, commits since, `git diff --stat`,
uncommitted and untracked counts, worktrees created under the root since the
start, `gh pr view` per branch when `gh` is installed, the last test command
with its exit code, and `staleIndexLock` when a git killed mid-commit left
`index.lock` behind, which every later git command would fail on. Branch
names — often their author's — are rewritten like every other string, keys
of `pullRequests` included (the bridge's last pass rewrites values, not
keys), while `gh` is still asked about each branch by its real name.

## Verifying

```bash
pnpm --filter @nessie/executor run test:mcp
cargo test --manifest-path executor/native/Cargo.toml
```

`scripted-coding-agent.mjs` speaks both protocols as the real CLIs printed
them, and the subprocess suites drive a real bridge through the daemon's own
MCP session manager; they run on Windows, Linux and macOS alike. It answers
`--help` with the texts captured from claude 2.1.280 and codex-cli 0.155.1
(`executor/test/fixtures/agent-help/`), or with `claude-older.txt` — the
2.1.280 text with `--permission-prompts` taken out — under
`NESSIE_SCRIPTED_HELP=older`, which the bridge suite starts to see
`agent_outdated`; its `#identity` directive prints the machine's real user
and host names the way git and a shell prompt do. A suite that
must see a turn while it runs holds it open with `#hold=<name>` and releases
it with the harness's `release`, rather than timing it with `#sleep`: a
bridge respawn and a detached host's start race each other under load, so a
timed turn can end before anything observes it. A follow-up that must fold
into a held turn waits for the agent's own `message` record before the
release. On Linux
with a reachable user manager those hosts run in their own
`systemd-run --user` units, so the same suites cover that start. The Job
Object is proved twice:
`executor/native/tests/job_run.rs` drives the built helper (exit code, stdio,
an orphaned grandchild dying with the job, the job dying with its parent), and
`coding-session-containment.test.ts` kills an agent's orphaning tree through
the helper whenever `executor/native/target` holds a build.
`coding-session-guard.test.ts` runs the real agent guard: the agent's own
identity, environment, output and exit code through it, its refusal when the
agent cannot start, which hosts use it, and a host killed with -9
(`taskkill /F` on Windows) — a stand-in host, and a real bridge's host
mid-turn under `#fork` — with the agent and its grandchild gone within five
seconds. On Linux with a user manager that second host is in its unit, so
there it is the unit that proves it and the stand-in the guard.
`coding-session-systemd.test.ts` restarts a stand-in executor unit with the
real unit's `KillMode=control-group` while a turn is held and drives the same
session afterwards — still working, the same agent, the turn finished and a
follow-up served — whenever `systemctl --user is-system-running` answers
`running` or `degraded`, and says why it skipped otherwise. The configuration
round trip through a real state file is skipped on a development Node on
Windows, where saving executor state needs the packaged helper; under a
packaged runtime it runs, and proves the config file owner-only through the
helper's DACL check instead of mode bits (`executor/test/windows-prerequisites.ts`). The live cycle — start, follow-up, a
denied `git push`, review and close against a logged-in Claude Code, and a
Codex turn — needs real subscriptions and is not automated.

The live cycle, and the restart before it became a suite, were last run by
hand on 2026-09-23. On Windows an MCP client started the
built bridge with the daemon's own generated argv and environment, stamped an
owner in `_meta`, and drove Claude Code (haiku, `acceptEdits`, `Bash(git *)`)
through a task, a correction, a review showing both commits and a close, once
in a development run and once packaged — the agent under `job-run`, with
`PowerShell(git *)` added;
the Codex start ended in its usage-limit result. No answer carried a host path
or any value of the logged-in account, and nothing was left running. On Linux
(WSL2, user manager running) a stand-in executor unit with the real unit's
`KillMode` was stopped mid-turn: the host's own unit and its agent lived on,
the turn finished, a new executor life sent a follow-up to the same agent, and
the close stopped the unit. Claude cannot log in over SSH on the macOS test
machine, so macOS ran the suites only.
