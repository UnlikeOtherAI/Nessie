# Host coding sessions: containment and teardown, per supervisor

Part of [host coding sessions](host-coding-sessions.md), which covers the
bridge, owners, configuration and the agents. This chapter says how each
supervisor holds a session's process tree, how it dies, and how close
requests reach the machine.

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
then the root, then each member, then a closing line. One ended before that
line (its ten seconds out under load) has not done the kill, so the guard's
ready-held kill is followed by a cold one, by the members its table showed:
the root it killed first leaves no tree to walk down from. An identity
without a start time is unknown and is never signalled. A start time that
cannot be read while the process is alive — PowerShell or `ps` timing out
under load — is read again; an agent whose start time still cannot be read is
stopped through the host's own handle at once and its start fails with
`containment_failed`, because nothing could later tell it from a reused pid.
macOS start times are read in UTC and the C locale, so a laptop that changes
time zone still recognises its agent. On POSIX a tree gets SIGTERM and two
seconds before SIGKILL, so a `git` caught mid-commit can remove its
`index.lock`. A failed table read then (`ps` timing out) is no reading, not
an empty table: the grace goes on by the last good one, each read capped at
what is left, and a failed last read gets one more with the full ten seconds;
if that fails too, no SIGKILL is sent, not even to the group (a stranger may
lead its id once every member exited), and the host log says so. What the
next host needs, the agent's identity and its confirmed session id, skips the
500 ms debounce, and a session id the agent never confirmed is dropped: Claude
refuses `--session-id` for an id it already holds, so the next agent starts
afresh rather than failing on every send.
Every message sent until the agent confirms its session or answers a turn
stays in `session.json` (`firstPrompt`): the next send that finds no agent
that had them running carries them first and joins them, and a start
redelivered because its host died holding it is sent once.

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
  cannot be read is stopped at once, tree and all (`killChildTree`, else its
  POSIX group: it is the guard's unreaped child). A host waits 60 s for the
  report (a guard's start and three table reads fit well inside it); then it
  closes the guard's pipe, which the guard reads as its host dying, gives it
  ten seconds to end what it started and exit, then kills it, and only once
  the guard has exited does the start fail with `containment_failed`.
- **Transparent otherwise.** stdin, stdout and stderr are relayed, and the
  guard exits with the agent's code, or dies of its signal, once the agent's
  output is read: when its pipes close, or — a descendant holding them — once
  they have been quiet for a second with nothing still waiting to reach the
  host. A line still arriving, or a relay paused because a busy host has not
  read the last one, keeps it waiting, so the turn's final `result` line is
  never cut off. Its own refusals go to stderr with exit code 125, as the job
  helper's do: `EXECUTOR_GUARD_SPAWN_FAILED` reads as `agent_missing`,
  `EXECUTOR_GUARD_CONTAINMENT_FAILED`, `EXECUTOR_GUARD_NO_AGENT` and
  `EXECUTOR_GUARD_HOST_GONE` as `containment_failed`.
- **The pipe closing is the host dying,** however it died. The guard then
  kills the agent's group and tree with the same identity-checked calls the
  host uses — SIGTERM, SIGKILL three seconds later on POSIX; pid by pid on
  Windows, never `taskkill /T` — writes `EXECUTOR_GUARD_HOST_GONE` for a host
  that closed the pipe itself, and exits. On Windows the guard starts that
  kill's PowerShell as soon as the agent has an identity and holds it ready
  (it exits with the guard, unused): cold, a PowerShell and its CIM module
  took most of the five seconds on a loaded machine; ready, the same kill
  took under one there. A host that dies while the agent's start time is
  still being read — that cold PowerShell, seconds under load — leaves an
  agent with no identity yet: its tree then comes from one table read that
  needs none (`killChildTree`), and failing that its own still-unreaped pid
  and, on POSIX, the group it leads. A dead host closes the guard's stdin
  too, so the end of the agent's input is also sent on the pipe when the host
  means it: stdin ending alone never lets the agent finish its turn on its
  own.

A guard killed outright cannot act, but its host sees it go. On Windows the
agent is in the guard's own kill-on-close job and dies with it (a child the
agent started is not: libuv's job lets it break away, the same grandchild a
development run's pid-by-pid kill misses). Elsewhere the agent runs on in a
group of its own, so a host that sees its guard exit kills the agent's tree,
identity-checked, before it records the agent as exited and forgets the
identity — an agent that really exited is not there to kill, and one whose
pid is not alive costs no table read. Only when the host and the guard both
die at once is the agent left to the next host started for the session, which
stops it before doing anything else.

### Teardown reaches the machine

Sessions outlive runs and daemon restarts, so the daemon ends them itself
(`executor/src/coding-sessions-daemon.ts`), always through the bridge's
daemon-only `session_close_all {ownerKey?, sessionId?, reason}`. The reason
is a category (`ExecutorCodingSessionCloseSchema`'s own `reason`,
`^[a-z][a-z0-9_]{0,63}$`; free text is refused) and becomes each closed
session's `reason` in `session_status`, `session_list` and the closing
`status` event, so a close forced by a lease's end or a revocation reads
differently from one the owner asked for, which carries none:

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
  is kept (up to 64) and tried again on every later heartbeat that still
  lists it, so a revoked lease or a person's Close is never dropped. Each
  heartbeat's list is the API's whole open set (absent is none), so one it no
  longer lists — done, a day old, or withdrawn because the owner launched
  again — is dropped rather than retried into the session that relaunch
  starts; a list the daemon cannot read changes nothing. The API may repeat
  an instruction while the session is still reported open; repeating one that
  already landed is harmless. One narrow race remains: a close already in
  flight to the bridge when the owner relaunches can still land after their
  new session starts, since `session_close_all` closes every session the
  owner has when it runs.
- **At shutdown**, only when the reviewed configuration sets
  `closeOnDaemonShutdown` — or when the file no longer matches its review,
  which cannot be trusted to have opted out. The call gets five seconds and
  runs before the MCP session stops.

The same daemon-only `session_list_all` feeds the local-MCP report: for
`coding-sessions` its status carries `codingSessions`, each open session's
`sessionId`, `ownerKey`, `title`, `status` (with a categorical `reason`),
`agent`, `root`, `updatedAt`, `turn` (the turns begun, 0 before the first),
`lastTurnEndedAt` (when the host last saw the status leave `working` —
a result, an interrupt, the agent exiting, a close mid-turn — or `null`) and
`totalCostUsd` (what the session has cost so far, once a turn reported a
cost), newest first and at most 32 — never a prompt, a transcript or a
path. A turn that begins and ends between two reports keeps the status and moves `turn`,
which is how a reader tells it from no change. All three are optional in the
schema: an older daemon's report has none, and absent infers nothing.
Absent `codingSessions` means the bridge was not asked.

### Close requests

The control plane keeps each instruction as a row of
`executor_coding_session_close_requests` — executor, owner key, optional
session id, a reason from `EXECUTOR_CODING_SESSION_CLOSE_REASONS` (`lease_ended`,
`access_revoked`, `executor_paused`, `executor_revoked`, `person`, and for one
ticket's work under a standing policy `ticket_left_flow`, `trigger_changed`,
`policy_suspended`, `policy_ended`, `work_limit`, `machine_reassigned` and
`mover_lost_access`, all pinned by a CHECK),
who asked, and when it was made and resolved — written in the transaction
that causes it (`executor-coding-session-closes.ts`):

- a conversation lease's end, for its holder, unless they still hold another
  live lease for the same agent there. One transition that ends several of
  the holder's leases writes one request, and its own end takes precedence
  over an `expired` it found on the way: a pause that finds one of them already
  past its window asks with `executor_paused` and the person who paused, not
  `lease_ended` and nobody, whichever lease it read first. A new lease
  withdraws that owner's open `lease_ended` request, never one for revoked
  access or a paused or revoked machine
  ([conversation-leases.md](conversation-leases.md) → §3). A
  drain ends every lease on the machine, so it closes each live holder's
  sessions this way, a turn in flight included; unlike a pause it leaves
  sessions no live lease covered;
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
  lease withdraws only owner-wide requests, never this one;
- one ticket's work ending its sessions, each named by id, for the ticket's
  seven reasons: the ticket entering an end column (`ticket_left_flow`), the
  trigger disabled, deleted or edited in a pinned field (`trigger_changed`),
  the policy suspended (`policy_suspended`) or ended (`policy_ended`), the
  work hitting a limit (`work_limit`), the work leaving this machine for
  another — it stayed offline past the trigger's `waitingMachineHours`, or
  the work was placed elsewhere — so the sessions it left here close when
  this one next reports (`machine_reassigned`, T5), or queued work cancelled
  because the person whose move started it can no longer edit the board
  (`mover_lost_access`, T5; both in migration
  `20260925090000_executor_coding_session_reassigned_close_reason`)
  ([ticket-driven agents](../plans/2026-09-23-ticket-driven-agents/machine-access.md#server-side-closes)).
  A request expires after a day like every other, counted from when it was
  written — except `machine_reassigned`, which exists for a machine that is
  away and so waits for a report of it that shows the session done. A ticket's sessions have an owner key of their own ("Owners" in
  [host-coding-sessions.md](host-coding-sessions.md)), so no owner-wide
  request above that is keyed without a context reaches them.

Owner keys are derived as the daemon derives `_meta['nessie/owner']`
(`executorCodingSessionOwnerKey`), and only for the one person who can own a
session — a private executor's pairing owner — and only on a machine that can
hold sessions: one with a revision that ever offered the bridge, or whose
last report lists it. Any other machine has no bridge a close would reach,
and its request would only ride every heartbeat for a day. The table's
partial unique indexes keep one open request per owner and one per named
session, so a pause that ends leases and fences the machine asks once.

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
