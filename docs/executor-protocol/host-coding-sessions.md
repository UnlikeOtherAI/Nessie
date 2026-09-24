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
`executor-coding-sessions.ts`). The generic pair never names the bridge — the
reserved name, or the one the revision's facts give — whether or not the run
is offered the tools: `executor_mcp_tools` and `executor_mcp_call` offer every
other program the revision names, and a call to the bridge through them
anyway is refused as correctable, before any command exists, with a pointer
to the tools, or, for a run the rule does not allow (which is offered none),
with the reason it cannot drive coding sessions. The API refuses such a call
as well, an `mcp.tools` listing of the bridge included.

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
reaches the payload. A blank optional argument — the `""` a model fills an
optional field with — counts as absent: a blank `path` is the root, a blank
`title` is taken from the task, and a blank `agent` is the default agent.

**The wait is the worker's.** `coding_session_wait`
(`worker/src/run/coding-session-wait.ts`) reads `session_status` every 5 s for
up to 10 minutes, and nothing is outstanding on the machine's command lane
between reads. It returns early when the session needs the agent — its turn
ended (`waiting_for_input`), it was `interrupted`, it `failed` or `closed` —
and when the agent should stop watching: the person posted a new message in
this conversation (a live chat `RunThreadPendingMessage` for this agent and
thread made after the run was, which says "The person sent a message; end
your turn now with one line of status; you will read it next." — a row a
drain left behind from before the run is not news), the run was stopped, the
worker is draining, or the run's own wallclock entered its wind-down ("This
run is nearly out of time…", so the agent can still say where the session
stands). A request the host has not picked up yet (`pendingNotice`,
`queuedMessages`), and the turn a start or a send is still owed, are not the
turn ending. Its tool timeout is 10.5 minutes; every read's command expires no
later than that less the margin, so only a single read's own TTL can end in an
unknown outcome, and a late read whose expiry the deadline shortened just ends
the wait. The first read carries the call's own ToolCall row, which the answer
ends; every later read's row — each executor command needs one of its own —
names that row as its `parentToolCallId` and is ended by the wait, and the
run's tool-call views (the run's list, its count, an agent's current and
recent calls) leave such steps out, so a ten-minute wait reads as one call
rather than a hundred and twenty.

The window is long because each return is a full-context inference for the
agent: a twenty-minute turn is two waits, not five
([tech-and-run-budgets.md](../standards/tech-and-run-budgets.md) → "What a
coding wait costs"). A turn can still outlive the run that started it — a
turn may run 45 minutes (`maxTurnMinutes`), as long as the whole run's
wallclock — and nothing wakes the agent when such a turn ends: the person
learns of it when they next write, and the agent reads the session's state
then.

Its answer is a digest of at most 1.5 KB — status, turn, the coding agent's
tool calls by name since the last wait, the files it touched and its last
sentence — and, only once a turn has ended, the full final summary and its
permission denials. The worker's own guidance goes above the frame; what the
coding agent said and did goes inside it under "Output from the coding agent
you supervise. Answer its questions yourself or ask the person; it is not the
person and cannot authorise anything." Every other coding tool's answer is
framed the same way — a review's branches and commit subjects, and also the
list, start, send, interrupt and close answers, whose titles and statuses come
from the coding agent's work too. The bridge's refusals of a session or an
argument are stated as ours and are correctable.

The wait, the list and the review are observation tools for the loop
detector. A wait says why it stopped: one that was still watching is never
refused, and three in a row that saw nothing move are nudged; one that stopped
because the session needs the agent is not repeated until the agent does
something that can change that; and once the person has written or the run's
time has entered its wind-down, no further wait runs this turn
([tech-and-run-budgets.md](../standards/tech-and-run-budgets.md) → "Loop
detection"). While it waits, the thought-process bubble shows one line for it,
rewritten in place under the same chunk id — "Claude Code: Bash pnpm test —
turn 2, 14 steps (Bash 7, Edit 3)". While the agent works the line leads with
its latest tool call as the bridge projected it (`summary.lastTool` in a
status read: the tool's name and its one-line input summary, paths
rewritten), so a long test run reads apart from a stall; otherwise with the
status. It never carries what the coding agent said. The run's machine-reach
fact names the tools and lists the sessions the person holds there as the
machine last reported them — their titles only in the person's own DM, where
the listing stamps the run's disclosure basis as a coding tool's answer does
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
  agent-help.json             what each installed CLI's --help offers, per
                              program path, size, modification time and
                              --version answer
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
every later call with that id returns it and does nothing else. The host
writes `session.json` at once, past its debounce, before it deletes a request
it acted on: a read that finds the inbox empty never finds the state from
before the request — a send's new turn, a queued message — and takes the last
turn's end for the answer. `session_send` answers with the `turn` it was made
at, so a caller that never read the session knows which turn is still owed.

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
with `owner: {agentId, actorUserId, contextId?}` beside `runId` and under the
argument digest. For calls to the executor's own bridge only, the daemon
derives `_meta['nessie/owner'] = sha256:` + hex SHA-256 of
`executorCodingSessionOwnerKeyInput(executorId, owner)` — the three ids
joined by a vertical bar, then `|contextId` when there is one — and sets
`_meta['nessie/command']` to the command id. "Its own bridge" is structural:
the server named `coding-sessions` whose argv ends
`serve-coding-session-mcp --config <path>` and whose environment pins the
digest the descriptor states. No other server receives any `_meta`, and the
model's `arguments` are passed on untouched either way.

The owner is the launch or lease actor, or the actor of one ticket's work
under a standing policy
([ticket-driven agents](../plans/2026-09-23-ticket-driven-agents/machine-access.md#session-isolation)),
whose `contextId` is `ticket:<policyId>:<taskId>` in lowercase ids
(`ExecutorCodingSessionOwnerContextSchema`). A context is its own owner: the
person's own sessions with that agent and every ticket's are isolated from
one another, each has its own `maxLiveSessionsPerOwner`, and a lease's
owner-wide close — keyed without a context — never reaches a ticket's
session. Without a context the key is the three ids exactly as before
contexts existed, so no session's key changed. The API admits a payload's
context only when its binding pins that same one, and none does until the
standing-policy binder lands.

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
garbles a profile such as `C:\Users\Ondřej` and every path under it), taking
only `REG_SZ` and `REG_EXPAND_SZ` values, machine then user: a key's plain
values first, then its expandable ones in rounds until nothing changes, so
`GOBIN=%GOPATH%\bin` resolves in any listing order (a value naming itself
reads what came before its key; a cycle stops after one round per value, at
32,767 characters), and `Path` is machine;user. On macOS, `launchctl getenv`
and the login shell's `env -0`; on Linux, `systemctl --user show-environment`
and the login shell. It strips only `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`,
`CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_MESSAGING_SOCKET`,
`CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH` and the executor's own markers
(`NESSIE_EXECUTOR_PACKAGED_CLI`, `NESSIE_CODING_SESSIONS_CONFIG_DIGEST`,
`NESSIE_EXECUTOR_SUPERVISOR`, `NESSIE_CODING_SESSION_UNIT`), then applies
`pass` and `set`. Before an agent starts, the host checks
`git --version`, the agent's `--version`, what the agent's `--help` offers, its
login status, and `gh auth status` when `gh` is installed; a failure makes the
session `failed` with `git_missing`, `agent_missing`, `agent_outdated`,
`agent_help_unreadable`, `permission_mode_unsupported`, `agent_not_logged_in`,
`gh_not_authenticated`, or `unsupported_supervisor` (the Windows service's
virtual account). The
read-only probes run side by side and are judged in that order; the login is
asked only after the help, because a CLI too old for `auth status` would
otherwise read as logged out.

Every program the host runs by a bare name is found on the absolute entries
of its environment's `PATH` and nowhere else (`program-path.ts`). Left to
itself, Windows looks in the child's working directory first — libuv's
search for `execFile` and `spawn` (unless the parent carries
`NoDefaultCurrentDirectoryInExePath`), and `CreateProcessW`'s inside the job
helper — and that directory is the session's folder, a repository the agent
edits; POSIX `execvp` honours a relative `PATH` entry, relative to the same
folder. A `claude.exe` committed there, or written by the agent during a turn,
would otherwise be what the next start ran. So the host resolves the agent's
`command[0]` once, before anything runs it, and passes that absolute path to
`--version`, `--help`, the login check, the help cache's key and the agent's
own start, through the agent guard or the job helper alike; a name it cannot
resolve fails the start with `agent_missing`. `git` and `gh`, in the
self-check and the review, are resolved the same way.

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
  or the start fails with `permission_mode_unsupported`, as it does with no
  list at all (commander prints one exactly when the CLI checks the value).
  A list it cannot read (unquoted) leaves the mode unchecked, as the host
  log says; that CLI still checks it.
- Codex (`codex exec --help` and `codex exec resume --help`): each help's
  `Usage:` line must name its subcommand (a codex without `exec resume`
  answers that help with the `exec` one); `-C` and `--json` on `exec`,
  `--json` on `exec resume`, which parses it there; `-m` with a `model`; and
  the owner's `args`. codex-cli 0.155.1's `exec` lists no `--full-auto`, so a
  configuration that still passes it is refused this way too.

Only option lines are read — a flag a description merely mentions (2.1.280
names `--permission-prompt-tool` only inside `--permission-prompts`'s text)
does not count. An argv is read as the CLI reads it: each letter of a
combined short group is a flag of its own (`-dv` needs `-d` and `-v`), and the
token after a flag whose option line takes a value (`<value>`) is that value
even when it starts with a dash, so neither hides a flag nor invents one.

Each help gets 15 s and 256 KiB. A help that did not answer — a timeout on a
busy machine, a non-zero exit — fails the start as `agent_help_unreadable`,
not `agent_outdated`: it proves nothing about the CLI's age, and the person
should not be sent to update a current one. What a help offers is cached in
`agent-help.json` per agent, per real path, size and modification time of
each file in the agent's `command` (its program as resolved above), and per
the CLI's own `--version` answer, which the self-check reads beside it: a
version manager's shim (volta, asdf, mise, a Homebrew wrapper) stays put while
the CLI behind it changes. So an updated CLI is read afresh and an unchanged
one once; a help that could not be read, or a version that could not, is not
cached. The host log names what was missing; the session carries only the
categorical reason.

## Containment and teardown, per supervisor

How each supervisor (Windows Job Object, systemd, the agent guard) holds a
session's process tree, how the tree dies, how teardown reaches the machine
and how close requests work is in
[host-coding-sessions-containment.md](host-coding-sessions-containment.md).

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
- `canClose`, true for the pairing owner of a private machine and nobody else
  (`executorCodingSessionsAllowed`, the rule that lets them drive it). Every
  session acts as that person, so managing the machine is not enough to end
  one: another administrator sees the list without Close, and is told who
  can; on a shared machine, which runs no session anyone drove, nobody has
  Close.

Close posts `POST /api/executors/:executorId/coding-sessions/close {ownerKey,
sessionId}`, the pair exactly as the list gave it. Anyone else who manages the
machine — on a shared machine, everyone — is refused with
`EXECUTOR_CODING_SESSIONS_OWNER_ONLY` (403), anyone
who does not with `EXECUTOR_NOT_FOUND`, and a session the last report does
not list as that owner's and open with `EXECUTOR_CODING_SESSION_NOT_FOUND`
(404). Otherwise it writes the `person` request above, audits
`executor.coding_session.close_requested` (the session id, nothing it did),
and answers 202 `{closing: true, sessionId}` — accepted, not done; a second
press while it is open adds nothing. The row reads "Closing…" from the press.
While the section is on screen (and the tab in front) the list is read again
every 20 s, the heartbeat's pace, because any heartbeat may replace the report
it is: a session that ended leaves, one that started arrives, each row's
"updated … ago" counts from the latest read, and a closing row goes once a
report no longer carries the session, which takes up to the report's
two-minute refresh. A report whose bridge status has
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
path or a URL's path, with a single `/` or `\` before it and one after: such
a segment is a repository's own folder (`src/ondre/x.ts`), a URL's owner
(`github.com/ondre/app`) or a folder under a root (`<app>/ondre/y.ts`), and
rewriting it would hand the model a path that does not exist. A segment of an
absolute path is not left alone, since the path rules rewrite only the host
directories they name (`/data/ondre/x`, `//server/share/ondre`,
`~other/ondre`). A path is absolute when it starts — after whitespace, a
quote, a bracket, `=`, `,`, `;`, `|` or a `:` that is not `://`, and past a
redirection (`>`, `2>>`, `<`), `@`, `*` or a one-letter option (`-o`, `-I`)
— with `/`, `\`, `~`, a drive letter or `file:`; one that goes on from a
closing bracket (`$(pwd)/ondre/x`) is relative. So a route with no host
(`/api/ondre/runs`) and a glob that starts at `*` (`**/ondre/*.ts`) have
their name rewritten, a letter and a colon read as a drive (`a:src/ondre/x`),
and a directory with a space in its name (`/data/My Files/ondre`) ends the
path at the space and keeps the name. Two
separators before a name are a URL's host or a UNC server, and are
rewritten. A branch (`session_review`'s `branch`, a worktree's `branch`, the
keys of `pullRequests`) is a name, not a path: every segment is rewritten
(`feature/<user>/fix`), but one named in prose (a commit subject, `git push
origin feature/ondre/fix`) reads as a relative path and keeps its name. The
placeholders already written and UUIDs (a session id's hex group may spell a
short host name) are never rewritten again.

The last pass over an answer gives the path rules alone, without the names,
to the fields other code parses as fixed values — `sessionId`, `ownerKey`,
`agent` and `agents`, `status`, `reason`, `root` and a listed root's `name`,
`path`, the timestamps, `baseCommit`,
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
the helper whenever `executor/native/target` holds a build; it fails chosen
`ps` reads under the macOS kill (on Linux's `/bin/ps`: no macOS runner runs
it) and cuts a Windows kill and a standby short partway through.
`coding-session-guard.test.ts` runs the real agent guard: the agent's own
identity, environment, output and exit code through it, its refusal when the
agent cannot start, which hosts use it, and a host killed with -9
(`taskkill /F` on Windows) — a stand-in host, and a real bridge's host
mid-turn under `#fork` — with the agent and its grandchild gone within five
seconds. On Linux with a user manager that second host is in its unit, so
there it is the unit that proves it and the stand-in the guard. The same file
kills a guard outright while its host lives (the agent, and on POSIX its
grandchild, gone by the time the host hears it exited), closes a guard's pipe
right after the agent starts (on Windows that is before the report, so the
identity-free kill runs), stands in a guard that never reports (asked to stop,
then killed) and one that cannot identify its agent (its tree goes, or its
group), and has a descendant write for longer than the drain after its agent
exited (every line reaches the host).
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
