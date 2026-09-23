# PR 3 — Coding sessions: an agent instructs Claude Code or Codex on the machine

Back to [overview](overview.md).

The CTO must *instruct* a coding agent, not code. On a host with no VM backend
the guest `coding.*` lane cannot run, and fronting `claude mcp serve` hands the
model Claude's primitive tools, so it ends up editing files itself. This
chapter adds a Nessie-shipped local MCP server, `coding-sessions`, that runs
coding-agent CLIs as long-lived sessions the agent drives by conversation.

PR 3a is executor-only (bridge, host, adapters, containment, descriptor,
teardown hooks, tests on three OSes). PR 3b is the control plane (the
first-class agent tools, owner stamping, the private-executor rule, the
admin session list).

## 1. Where it is allowed

A host-local coding agent acts with the host OS user's full authority — their
files, their git and SSH credentials, their Claude or ChatGPT subscription.
So, structurally:

- The executor must be **private** (`scopeKind === 'private'`).
- The run's initiating person (the launch or lease actor) must be the
  executor's **pairing owner**.
- The server must be the reviewed built-in bridge (§4), identified by the
  descriptor, not by a name anyone can give any program.

The API refuses a `coding-sessions` call that fails any of these at dispatch
(`EXECUTOR_CODING_SESSIONS_OWNER_ONLY`), and the worker offers the first-class
tools only when all three hold. The protocol's trust table gains the row
*"Owner-named host-local coding bridge — acts with the host OS user's full
authority; private executor, pairing owner only"*, and the sentences that say
the coding CLI never reaches host files or credentials, that there is no prompt
channel, and that host writes happen only by promotion are scoped to guest
work (`docs/executor-protocol/host-coding-sessions.md`, linked from the
overview's table of contents; full-actuation §7–§8 records the decision).

## 2. Shape: a stateless bridge and one detached host per session

`nessie-executor serve-coding-session-mcp --config <abs path>` is an MCP stdio
server the daemon starts like any named server. It holds **no state in
memory**: the daemon's 60 s idle close, the reporter's 120 s probe and a daemon
restart may kill it at any time.

Each session is owned by a detached **session host**,
`nessie-executor coding-session-host --config <path> --session <id>`, which
owns the coding-agent process and all session state on disk:

```
<stateDir>/sessions/<id>/
  session.json      host-written, debounced ≤ 1 per 500 ms, tmp+rename with EPERM/EACCES/EBUSY retry ≤ 2 s
  events.jsonl      host is the sole writer; rotated at 16 MiB
  inbox/            bridge writes requests (tmp + rename, named by command id, created wx)
  host.lock         {pid, token, protocolVersion, runtimeDigest, startedAt, heartbeatAt}
  host.log          bounded (1 MiB ring)
  agent-stderr.log  bounded; its last lines feed categorical failure reasons
```

`<stateDir>` is created owner-only (0700 on POSIX; the packaged helper's
owner-only DACL on Windows, as the executor state already is) and must not be
inside any coding root.

### The lock

- The host rewrites `heartbeatAt` every 2 s. A lock is stale when its
  heartbeat is older than 10 s; pid liveness may add "dead", never prove life
  (pids are reused).
- Takeover renames the stale lock to `host.lock.stale.<rand>`, then creates a
  new one with `wx`. The host re-reads the lock and checks its own `token` on
  every heartbeat and immediately before spawning or resuming the agent, and
  exits if it is not its own.
- The bridge records `spawnRequestedAt` and spawns no second host within 15 s
  unless the heartbeat is stale.
- A bridge that finds an older `protocolVersion` asks that host to close after
  its current turn.

### Requests and reads

- Requests are inbox files named after the executor command id the daemon
  passes in `_meta['nessie/command']`, created with `wx`: a replayed or retried
  `start`/`send` is a no-op that returns the first outcome.
- After writing a request, the bridge ensures a live host; the host, before
  exiting, removes its lock and re-checks `inbox/`, re-acquiring if non-empty.
- Reads use a byte-offset cursor plus event `seq`; a reader consumes only
  newline-terminated lines. The bridge keeps a **delivered cursor per session
  per owner**, so the model never has to carry one.
- A read that finds an active status with a stale lock reports
  `interrupted` with reason `host_lost` and, if the inbox is non-empty, spawns
  a host.

### Spawning the host

The bridge resolves its own entry once at start (`realpathSync(process.argv[1])`,
asserted to be `index.js` or `nessie-executor.cjs`) and spawns
`[...process.execArgv, entry, 'coding-session-host', …]` with the environment
it received (so `NESSIE_EXECUTOR_PACKAGED_CLI` survives), detached, stdio to
`host.log`, `windowsHide: true`.

## 3. Containment and teardown, per supervisor

| Host | How the session host runs | Survives a daemon restart | How the tree dies |
|---|---|---|---|
| Windows, desktop companion or hand-run daemon | detached; the agent runs under the packaged native helper's new `job-run` subcommand, which holds a Job Object with `KILL_ON_JOB_CLOSE` | yes | host death or close kills the whole job; `taskkill /F` per verified pid, by absolute `%SystemRoot%\System32` path, only as the dev fallback |
| Windows service (virtual account) | **refused**: `unsupported_supervisor` — that account has no Claude login and no user profile | — | — |
| macOS, menu-bar app / desktop / hand-run | `setsid`; own process group | yes | group kill, then a descendant sweep from a `ps -A -o pid=,ppid=,pgid=` snapshot taken before signalling (catches setsid'd grandchildren) |
| Linux with a user manager (`systemctl --user` reachable; `XDG_RUNTIME_DIR` derived from `/run/user/<uid>`) | `systemd-run --user --collect --unit nessie-coding-<id> -p KillMode=control-group -p TimeoutStopSec=10 -- …` | yes, and it can never block the executor unit's stop/restart | `systemctl --user stop nessie-coding-<id>` |
| Linux without a user manager | `setsid` fallback | no (documented) | as macOS |

Every agent and tool spawn passes `windowsHide: true`. Before killing, the host
checks the recorded agent identity (pid + process start time) so it never
signals a reused pid — and reads the tree only below a root that is still that
process, checking each descendant's own start time before its signal. When a
new host takes over a session whose previous agent is still alive, it kills
that tree before resuming.

**Teardown reaches the machine.**

- The daemon keeps a registry of bridge-owned sessions by owner key and calls
  the reserved bridge tool `session_close_all {ownerKey?, reason}` (accepted
  only with `_meta['nessie/daemon-control']`, which only the daemon's own calls
  carry) when the daemon's authority provably ends — the API answers that the
  executor is unknown or revoked, or refuses its proof — or no heartbeat has
  succeeded for ten minutes, and at shutdown when the policy opts in. A
  transient poll or heartbeat failure, and the reclaim after a fence, close
  nothing: these sessions are built to outlive a dropped connection, and
  closing on every blip would end every long turn on the machine for good.
- The heartbeat response gains `codingSessionClose: [{ownerKey, reason}]`,
  produced when a lease ends, access is revoked or the executor is paused; the
  daemon closes those owners' sessions, and retries on every later heartbeat
  an instruction the bridge could not carry out.
- A person's **Close** on a session in the admin (§8) travels the same way.
- Hard limits from config: `maxTurnMinutes` (default 45) interrupts a runaway
  turn, and ends its agent process when an interrupt is ignored for 30 s;
  `maxBudgetUsd` per turn is passed to Claude, whose budget counts a
  per-process total, so each new turn starts in a fresh process resuming the
  session; `idleMinutes` (default 30) ends an idle agent process (the session
  stays resumable).

## 4. The reviewed descriptor

The owner configures the bridge through the existing
`configure --configuration-input-stdin` JSON:

```json
{
  "codingSessions": {
    "roots": [{ "name": "nessie", "path": "C:/Users/ondre/Projects/Nessie" }],
    "agents": {
      "claude": { "command": ["C:/…/claude.exe"], "permissionMode": "acceptEdits",
                  "allowedTools": ["Bash(git *)", "Bash(pnpm *)", "Bash(gh *)"], "model": "opus" },
      "codex":  { "command": ["node", "C:/…/@openai/codex/bin/codex.js"], "args": ["--dangerously-bypass-approvals-and-sandbox"] }
    },
    "agentEnv": { "inheritUserSession": true, "pass": [], "set": {} },
    "maxLiveSessionsPerOwner": 3, "idleMinutes": 30, "maxTurnMinutes": 45, "maxBudgetUsd": 20
  }
}
```

The executor writes the host-local config owner-only, **generates** the
`coding-sessions` mcpServers entry itself (`[execPath, entry,
'serve-coding-session-mcp', '--config', <path>]` plus the packaged-CLI marker),
and puts the power facts in the signed descriptor, inside `localPolicyDigest`:

```ts
codingSessions?: {
  serverName: 'coding-sessions'
  agents: Array<'claude' | 'codex'>
  permissionMode: Record<'claude' | 'codex', string>
  allowedToolCount: number
  environmentNames: string[]   // agentEnv.set and agentEnv.pass, names only
  rootNames: string[]
  configDigest: string   // sha256 of the canonical host-local config
}
```

Review renders them ("Coding agents on this machine: Claude Code (accept
edits, 3 pre-allowed commands) in nessie"). The bridge refuses to start a host
when the config's digest differs from `configDigest` (passed in its env), so
editing the file silently changes nothing until a person reviews it. Roots are
refused when they overlap a workspace folder, the executor state dir, the
bridge state dir or the config file (realpath, case-insensitive on Windows and
macOS); paths resolve through the existing `safeRelativeWorkspacePath` /
`resolveExistingWorkspacePath` helpers.

## 5. Owners

The worker stamps the command payload with `owner: {agentId, actorUserId}`
taken from the binding's candidate (never from the model); the digest covers
it. For calls to the bridge only, the daemon injects
`_meta['nessie/owner'] = sha256(executorId | agentId | actorUserId)` and
`_meta['nessie/command'] = commandId`. The bridge records the owner key in
`session.json`; `session_list` shows only the caller's sessions and every
other tool answers "No such session" for a foreign id. The quota is per owner.
`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` is set by default so Claude's auto-memory
is not a channel between owners (the owner may override it in `set`).

## 6. The agents

### Environment

With `inheritUserSession` the host rebuilds a login-like environment, because
the MCP SDK hands the bridge only a minimal set (six variables on POSIX,
twelve on Windows):

- Windows: user and machine `Environment` registry keys, plus `PATHEXT`,
  `ComSpec`, `windir`, `ProgramData`, `TMP`.
- macOS: `launchctl getenv SSH_AUTH_SOCK` / `TMPDIR`, then `$SHELL -lc 'env -0'`.
- Linux: `systemctl --user show-environment` when available, then
  `$SHELL -lc 'env -0'`.

It strips only variables that couple to a parent Claude session
(`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SSE_PORT`,
`CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH`), then
applies `pass` and `set`. At start it self-checks `git --version`, the agent's
own `--version`, and `gh auth status` when `gh` exists; a failure makes the
session `failed` with a named reason (`agent_missing`, `agent_not_logged_in`,
`git_missing`, `gh_not_authenticated`).

### Claude Code

One long-lived process per live host:
`<claude> -p --input-format stream-json --output-format stream-json --verbose
--replay-user-messages (--session-id <uuid> | --resume <uuid>)
[--permission-mode <m>] [--allowedTools …] [--disallowedTools …] [--model <m>]
[--max-budget-usd <n>] --append-system-prompt <text>`.

- `permissionMode` is validated against the installed CLI's choices
  (`acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`); unset means the
  flag is omitted. The CLI version is recorded and checked by the self-check.
- Ready = the `initialize` control response (its `account` field is dropped).
- A follow-up is a stdin user line with our uuid; it folds into a running turn
  at the next tool boundary, which is the steering behaviour we want.
- Interrupt = `control_request {subtype:'interrupt'}`; close = `end_session`,
  stdin end, then the tree kill after 5 s.
- Turn finished = a `result` with no queued or started `command_lifecycle`;
  background tasks are reported as a count rather than holding the turn open
  (a dev server never ends), and unsolicited results (`origin.kind`) are
  recorded too.
- The appended system prompt says a Nessie agent is driving it, there is no
  person at this terminal, it should work in its own git worktree, commit and
  push as its instructions say, and end each turn with a short summary of what
  it did and what it needs.

### Codex

Per-turn processes: `<codex> exec --json [args] -C <folder> -` (first turn,
prompt on stdin) and `<codex> exec resume <threadId> --json [args] -`.
`thread.started.thread_id` is the session id. Messages queue between turns;
interrupt kills the turn's job/group (resumable). Unknown events are kept as
`system` events. Live verification is blocked until the ChatGPT Codex quota
resets on 2026-09-26; the failure path is verified now.

### Permission prompts

The driving model never answers them. In this plan every prompt is **denied**
with a readable reason (Claude's `--permission-prompts none`, or its
stdio prompt answered deny), and the denial is carried on the result
(`permissionDenials: [{tool, summary}]`) and on the session status, so the
CTO tells the person what the coding agent could not do. Routine commands are
allowed up front by the reviewed `allowedTools`. Relaying a prompt to the
lease holder as an approval card, through the existing suspend path, is the
follow-up.

## 7. What the bridge reports — projected, never raw

Each event kind has an allowlist of fields:

- `assistant` text (≤ 2 000 chars), `tool` name + one-line input summary
  (≤ 300), `tool_result` (≤ 300; errors ≤ 1 000), `result` (final text
  ≤ 4 000, isError, subtype, turns, cost delta, duration, permission denials),
  `user` (our message echoed), `system` (model and permission mode from init;
  categorical errors).
- `rate_limit_event`, init's `cwd`, `memory_paths`, `mcp_servers`, sockets and
  the initialize `account` are dropped.
- Every absolute path under a root becomes `<root>/relative`; any other
  absolute path (home, `~/.claude`, temp) becomes `<host path>` — all slash,
  case and `\\?\` variants — in every field. The existing "reported message
  carries neither argv nor host path" test is extended to session output.

## 8. The tool surfaces

### Bridge MCP tools (what the worker calls)

`session_list`, `session_start {agent, root, path?, prompt, title?}`,
`session_status {sessionId, detail?: 'summary' | 'events', cursor?}`
(non-blocking, ≤ 8 KB, status/nextCursor/pendingNotice first so a cut keeps
them), `session_send {sessionId, message}`, `session_interrupt`,
`session_review`, `session_close`, and the daemon-only `session_close_all`.
Every call returns in under 5 s.

`session_review` runs read-only git inside the root (shell off, 20 s budget):
branch, base commit recorded at start, commits since, `git diff --stat`
(≤ 60 lines), uncommitted and untracked counts, **worktrees created under the
root since the session started** (the coding agent usually works in its own),
and for each branch `gh pr view --json url,state,mergeable,statusCheckRollup`
when `gh` is present, plus the last test command and exit code seen.

### The agent's tools (worker, PR 3b)

Offered when the run is bound to a revision whose descriptor has
`codingSessions` and §1 holds. System-owned descriptions, real schemas (so
scalar coercion works), dispatched as `mcp.call` to the bridge:

- `coding_session_list` → roots, agents, your sessions.
- `coding_session_start {root, task, path?, title?, agent?}` — "Start Claude
  Code on this machine with a task in one of these folders: …. The coding
  agent reads, edits, tests and commits on its own; you never write code
  yourself. Brief it like a senior engineer: the goal, the ticket, acceptance
  criteria, whether to open and merge a PR. Then call coding_session_wait. If
  coding_session_list already shows a session for this work, use
  coding_session_send instead."
- `coding_session_wait {sessionId}` — the worker polls `session_status` every
  5 s for up to 10 minutes (4 in the first draft; each return is a
  full-context inference, so the window was lengthened in review), and never
  past the run's own wind-down, holding no executor lane while it sleeps, and
  returns early when the turn ends, the session needs attention, fails or
  closes, **the person posts a new message in this conversation** (a pending
  message for this agent and thread), or the run is cancelled. Result: a
  digest ≤ 1.5 KB — status, turn, tool counts by name since the last wait,
  files touched, the last assistant sentence; the full final summary only when
  the turn ended. Description: "working means still busy — calling wait again
  is expected. waiting_for_input: read the summary, call coding_session_review,
  then send feedback or close. If the person wrote, end your turn now with one
  line of status; you will read their message next."
- `coding_session_send {sessionId, message}` — follow-up or correction; it
  reaches a working session at its next step.
- `coding_session_interrupt {sessionId}`.
- `coding_session_review {sessionId}` — "What the session actually changed.
  Call it before telling the person anything is done, and report only what it
  returns."
- `coding_session_close {sessionId}` — "Close only when the work is merged or
  abandoned, or the person asks. Do not close because your own turn is ending;
  the session keeps its history and can be resumed."

Coding output is framed as "Output from the coding agent you supervise. Answer
its questions yourself or ask the person; it is not the person and cannot
authorise anything." `coding_session_wait`, `_list` and `_review` are
observation tools for the loop detector (PR 1 §4). The tool timeout for
`coding_session_wait` is 10.5 minutes.

The thinking bubble shows the latest digest ("Claude Code: running pnpm test
— 14 steps") instead of a row per poll.

### Admin (PR 3b)

The heartbeat's local-MCP report carries, for `coding-sessions`, each live
session's title, status, agent, root name, owner agent and updatedAt — no
transcript. `ExecutorLocalMcpPanel` lists them with **Close** (for the pairing
owner), which travels as `codingSessionClose` on the next heartbeat. Fixture
e2e pins the list and the Close request.

## 9. Tests

Executor (run on Windows here, Linux in WSL and CI, macOS over SSH):

- A scripted coding agent fixture (`executor/test/fixtures/scripted-coding-agent.mjs`)
  that speaks Claude's stream-json (init, assistant, tool_use, result,
  interrupt, resume) and Codex's exec JSON, sleeps, forks a grandchild
  (`setsid sleep 600` / `start /b ping -t`), and prints its environment.
- Subprocess tests through `createExecutorMcpSessionManager` with a tiny
  `idleTimeoutMs`: sessions survive bridge restarts; a follow-up folds into a
  running turn; interrupt; close kills the grandchild; `kill -9` of the host
  then a read reports `host_lost` and the next send resumes without a second
  agent; two owners never see each other; a replayed command id is a no-op;
  the config digest mismatch refuses; roots overlapping state refuse; no host
  path or account data appears in any output; env inheritance per OS.
- Linux: a systemd user unit restart leaves a live session running (WSL with
  systemd, and CI where available).
- Live on Windows with the logged-in Claude Code: one start → wait → send →
  wait → review → close cycle in a scratch repository.

Worker/API (3b): owner stamping and the `_meta` injection, the private and
pairing-owner rule, first-class tool offering, the wait loop's early returns
(pending human message, cancel), the digest size, descriptor rendering.

## Follow-ups

Known gaps, found in review of PR 3b and left for later:

- **Nothing wakes the agent when a turn outlives its run.** A turn may run
  45 minutes (`maxTurnMinutes`), as long as a whole run's wallclock, and a
  run's wait ends at its wind-down. When the run ends while the coding agent
  is still working, the turn's end reaches nobody: the person learns of it by
  writing again. A wake-up — a run the host's turn-end starts for the owner's
  conversation, through the ordinary pending-message path and under the
  lease's rules — would close it.
- **A long supervision still spends inferences.** Each wait's return is a
  full-context inference; the 10-minute window cuts a 20-minute turn to two,
  but a model whose provider reports no cache reads still reaches the token
  wind-down in about a dozen returns. Prompt caching the digest's stable
  prefix, or answering an unchanged wait from the worker without an
  inference, would cut it further.
