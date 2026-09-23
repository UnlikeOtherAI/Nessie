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
teardown. Of the control plane's half, the worker stamps `owner` on a call to
the bridge, the rule below refuses anyone but a private executor's pairing
owner, the API writes and sends `codingSessionClose`, a review renders the
power facts, the agent drives the bridge through first-class tools of its
own, and the executor page lists the open sessions with a Close for the
pairing owner ("Who may drive it", "The agent's tools", "Close requests" and
"The executor page" below). The bridge's row in the overview's trust table
states the rule.

## Who may drive it

The control plane allows an `mcp.call` to the bridge only on a **private**
executor, and only for a binding made for that executor's **pairing owner**:
the consumed availability candidate names the person, never anything the
model sent (`executor-coding-session-owner.ts` in `@nessie/executor-manage`).
Anyone else — every entitled member of a project or organisation executor,
another rostered person on a private one — is refused with
`EXECUTOR_CODING_SESSIONS_OWNER_ONLY`, a failure the model does not correct by
changing its call, whose message says in plain words that coding sessions act
as the machine's owner. The reserved name is the bridge's whatever the
revision says, so a call to `coding-sessions` meets the rule even on a
revision without the facts. It is checked where the command is created
(`createExecutorCommand`, so no command exists) and again where the daemon
collects it, where a refusal becomes the command's result rather than a poll
failure that would hold every later command behind it. The same check pins
the payload's `owner`: exactly the binding's candidate on a call to the
revision's bridge, absent on every other call.

## The agent's tools

A run whose `mcp.call` binding is to a revision with the bridge's facts, whose
agent's policy allows that call, and whose binding the rule above allows — a
private executor, launched by its pairing owner — is offered seven tools of
its own (`worker/src/run/coding-session-tools.ts`,
`executor-coding-sessions.ts`), and the generic pair stops naming the bridge:
`executor_mcp_tools` and `executor_mcp_call` offer every other program the
revision names, and a call to the bridge through them anyway is refused as
correctable, before any command exists, with a pointer to the tools. A run the
rule does not allow is offered none, and its generic call to the bridge meets
the API's refusal as before.

| Tool | Bridge tool | What it is for |
| --- | --- | --- |
| `coding_session_list` | `session_list` | the folders, agents and the caller's sessions |
| `coding_session_start {root, task, path?, title?, agent?}` | `session_start` (`task` is its `prompt`; `agent` defaults to Claude Code when offered) | a new session with a task |
| `coding_session_wait {sessionId}` | `session_status`, read by the worker | following a session until it needs the agent |
| `coding_session_send {sessionId, message}` | `session_send` | a follow-up or correction |
| `coding_session_interrupt {sessionId}` | `session_interrupt` | stopping a turn |
| `coding_session_review {sessionId}` | `session_review` | what the session actually changed |
| `coding_session_close {sessionId}` | `session_close` | ending it, when the work is merged or abandoned |

Their descriptions are system text, with the start tool's folders and agents
taken from the reviewed facts, and their schemas are real, so scalar
coercion works. Each is an `mcp.call` through the same toolset dispatch as
`executor_mcp_call` (`executor-command-dispatch.ts`): the owner stamp, the
host-output disclosure stamp, the command TTL and the ToolCall row are all
that dispatch's. A key a tool does not define is left behind rather than sent
for the bridge to refuse, so nothing the model adds — an `owner`, a `_meta` —
reaches the payload.

**The wait is the worker's.** `coding_session_wait`
(`worker/src/run/coding-session-wait.ts`) reads `session_status` every 5 s for
up to 4 minutes, and nothing is outstanding on the machine's command lane
between reads. It returns early when the session needs the agent — its turn
ended (`waiting_for_input`), it was `interrupted`, it `failed` or `closed` —
and when the agent should stop watching: the person posted a new message in
this conversation (a live chat `RunThreadPendingMessage` for this agent and
thread, which says "The person sent a message; end your turn now with one
line of status; you will read it next."), the run was stopped, or the worker
is draining. A request the host has not picked up yet (`pendingNotice`,
`queuedMessages`), and the turn a start or a send is still owed, are not the
turn ending. Its tool timeout is 4.5 minutes; every read's command expires no
later than that less the margin, so only a single read's own TTL can end in an
unknown outcome, and a late read whose expiry the deadline shortened just ends
the wait. The first read carries the call's own ToolCall row, which the answer
ends; every later read's row is ended by the wait.

Its answer is a digest of at most 1.5 KB — status, turn, the coding agent's
tool calls by name since the last wait, the files it touched and its last
sentence — and, only once a turn has ended, the full final summary and its
permission denials. The worker's own guidance goes above the frame; what the
coding agent said and did goes inside it under "Output from the coding agent
you supervise. Answer its questions yourself or ask the person; it is not the
person and cannot authorise anything." A review is framed the same way; the
other tools' answers are the bridge's own bookkeeping, framed as the program's
output. The bridge's refusals of a session or an argument are stated as ours
and are correctable.

The wait, the list and the review are observation tools for the loop
detector, and a wait that saw nothing move three times in a row is nudged
rather than refused
([tech-and-run-budgets.md](../standards/tech-and-run-budgets.md) → "Loop
detection"). While it waits, the thought-process bubble shows one line for it,
rewritten in place under the same chunk id — "Claude Code: working — 14 steps
(Bash 7, Edit 3)" — from the status, the counts and the tool names only, never
the coding agent's own words. The run's machine-reach fact names the tools and
lists the sessions the person holds there as the machine last reported them
([conversation-leases.md](conversation-leases.md) → §5).

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
`git --version`, the agent's `--version` and login status, and `gh auth status`
when `gh` is installed; a failure makes the session `failed` with
`agent_missing`, `agent_not_logged_in`, `git_missing`, `gh_not_authenticated`,
or `unsupported_supervisor` (the Windows service's virtual account).

## Containment and teardown, per supervisor

| Host | How the session host runs | Survives a daemon restart | How the tree dies |
| --- | --- | --- | --- |
| Windows, desktop companion or hand-run daemon | detached; a packaged runtime starts the agent through the native helper's `job-run`, which holds it in a Job Object with `KILL_ON_JOB_CLOSE` | yes | the helper exits with the agent, and ends the job at once when the host dies; closing or killing the helper kills everything in the job. A development run has no verified helper and kills the tree it can see pid by pid with `taskkill /F` by its absolute System32 path; a packaged runtime whose helper is missing starts no agent (`containment_failed`) |
| Windows service (virtual account) | refused: the session fails with `unsupported_supervisor` | — | — |
| macOS | detached, its own session | yes | group kill, then a sweep of every descendant in a `ps -A -o pid=,ppid=,pgid=,lstart=` snapshot taken before signalling (`/proc` on Linux); SIGTERM first, SIGKILL two seconds later |
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

On macOS, and on Linux without a user manager, nothing watches the host the
way the Windows job helper does: after a host is SIGKILLed or runs out of
memory, its agent sees its stdin close and finishes the turn it is in —
editing the worktree unobserved, its result unrecorded — and the next host
started for the session stops it before doing anything else. A parent-death
watch there is not built.

Every kill checks the recorded pid and start time, so a reused pid is never
signalled, and a new host stops a lost host's still-running agent before it
resumes the session. The tree is held to the same rule: descendants are read
only below a root that is still the recorded process (the children of
whoever inherited its pid are nobody's this host started), each carries its
own start time, and each is checked again right before its own signal — never
`taskkill /T`, which walks parent ids as they are at that moment. An identity
without a start time is unknown and is never signalled. A start time that
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

### Close requests

The control plane keeps each instruction as a row of
`executor_coding_session_close_requests` — executor, owner key, optional
session id, a reason from `EXECUTOR_CODING_SESSION_CLOSE_REASONS` (`lease_ended`,
`access_revoked`, `executor_paused`, `executor_revoked`, `person`, pinned by a
CHECK), who asked, and when it was made and resolved — written in the
transaction that causes it (`executor-coding-session-closes.ts`):

- a conversation lease's end, for its holder, unless they still hold another
  live lease for the same agent there; a new lease withdraws that owner's
  open request ([conversation-leases.md](conversation-leases.md) → §3);
- the agent's access withdrawn (a deny of the pair or of the whole suite, or
  its removal from the roster), for that agent and the pairing owner; the
  pairing owner's removal from the roster, for every agent they bound the
  pair for there;
- the executor paused or revoked (a pairing's revoke included), for every
  agent the pairing owner bound the pair for there and every owner key the
  machine's last report listed. A revoked executor's heartbeat is refused,
  and that refusal is what closes its sessions (`EXECUTOR_NOT_FOUND` above);
  its rows record the intent;
- the pairing owner's **Close** on one session from the executor page, with
  reason `person`, that session's id and the owner as requester
  (`requestExecutorCodingSessionClose`, "The executor page" below). A new
  lease withdraws only owner-wide requests, never this one.

Owner keys are derived as the daemon derives `_meta['nessie/owner']`
(`executorCodingSessionOwnerKey`), and only for the one person who can own a
session — a private executor's pairing owner. The table's partial unique
indexes keep one open request per owner and one per named session, so a
pause that ends leases and fences the machine asks once.

Every heartbeat answers with the executor's open requests, oldest first and at
most `EXECUTOR_CODING_SESSION_CLOSE_MAXIMUM`, and omits `codingSessionClose`
when there are none. A request is resolved by the local-MCP report a
heartbeat carries when that report's `coding-sessions` status lists no open
session for the owner (or not the named session), was observed more than the
heartbeat's one-minute clock allowance after the request was made, and is not
cut at its 32-session maximum; by any report from a daemon that fronts no
bridge, whose close would do nothing; and by any heartbeat once it is a day
old. A status without `codingSessions` settles nothing, because the bridge was
not asked.

## The executor page

A person sees what is running on their machine, and ends it, under the coding
bridge's status in the executor page's **Local apps** section (Permissions tab;
`ExecutorLocalMcpPanel` → `ExecutorCodingSessions`). It reads
`GET /api/executors/:executorId/coding-sessions`, answered only to the people
who may manage the machine (404 for everyone else), as `{canClose, sessions}`:

- each open session the machine's last report lists, a `closed` one left out:
  its id, owner key, title, status and categorical reason, coding agent, root
  name and `updatedAt` — never anything it said or did, which the report does
  not carry;
- `closing`, true while a close request that reaches it — owner-wide or naming
  it, for any reason, under a day old — is open;
- `ownerAgentName`, the agent driving it. The report names an owner only by
  its hashed key, so the API derives the key again for the pairing owner and
  each agent they bound the local-apps pair for there
  (`executorCodingSessionOwnerAgentIds`, from consumed candidates, which are
  never swept), and names that agent only when the ordinary agent entitlement
  shows it to the reader — the Agents tab's rule. `null` reads "an agent you
  cannot see";
- `canClose`, true for the pairing owner and nobody else. Every session acts
  as that person, so managing the machine is not enough to end one: another
  administrator sees the list without Close, and is told who can.

Close posts `POST /api/executors/:executorId/coding-sessions/close {ownerKey,
sessionId}`, the pair exactly as the list gave it. Anyone else who manages the
machine is refused with `EXECUTOR_CODING_SESSIONS_OWNER_ONLY` (403), anyone
who does not with `EXECUTOR_NOT_FOUND`, and a session the last report does
not list as that owner's and open with `EXECUTOR_CODING_SESSION_NOT_FOUND`
(404). Otherwise it writes the `person` request above, audits
`executor.coding_session.close_requested` (the session id, nothing it did),
and answers 202 `{closing: true, sessionId}` — accepted, not done; a second
press while it is open adds nothing. The row reads "Closing…" from the press.
While any row is closing the list is read again every 20 s, the heartbeat's
pace, and the row goes once a report no longer carries the session, which
takes up to the report's two-minute refresh. A report whose bridge status has
no `codingSessions` says "Open coding sessions have not been checked yet" and
asks the API nothing.

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
`index.lock` behind, which every later git command would fail on.

## Verifying

```bash
pnpm --filter @nessie/executor run test:mcp
cargo test --manifest-path executor/native/Cargo.toml
```

`scripted-coding-agent.mjs` speaks both protocols as the real CLIs printed
them, and the subprocess suites drive a real bridge through the daemon's own
MCP session manager; they run on Windows, Linux and macOS alike. A suite that
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
the helper whenever `executor/native/target` holds a build. The configuration
round trip through a real state file is skipped on Windows, where saving
executor state needs the packaged helper. The live cycle — start, follow-up, a
denied `git push`, review and close against a logged-in Claude Code, and a
Codex turn — needs real subscriptions and is not automated, and neither is a
`systemctl --user restart` of the executor unit around a live session.

Both were last run by hand on 2026-09-23. On Windows an MCP client started the
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

The control plane's half runs against real rows (`DATABASE_URL=…`):
`packages/executor-manage/test/executor-coding-session-owner.test.ts` and
`executor-coding-session-closes.test.ts` for the owner rule, every close
request, the heartbeat and a person's Close;
`api/test/executor-coding-sessions-control.test.ts` and
`executor-coding-session-routes.test.ts` for the review projection, the
heartbeat route and the executor page's list and Close; and
`worker/test/db/executor-coding-session-owner.test.ts` and
`executor-coding-session-tools.test.ts` for the owner stamp and the agent's
tools through the real encrypted lane. The executor page itself is a pure
fixture suite over the real page and API client:

```bash
pnpm --filter @nessie/admin test:e2e:executor-coding-sessions
```

It pins the list, the pairing owner's Close posting `{ownerKey, sessionId}`
and "Closing…" until a later report drops the row, another administrator's
list without Close, the phone width with a Close the API refuses, and a
bridge that was not asked. Browser Suites runs it in its executor step
(`NESSIE_EXECUTOR_CODING_SESSIONS_E2E_FIXTURE`,
[docs/testing/executor-attention.md](../testing/executor-attention.md)).
