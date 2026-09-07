# Board watcher executor runs

**Date:** 2026-09-07 · **Status:** proposal awaiting approval

This proposal connects a board watcher to an already paired, explicitly
authorised executor. It does not approve a new executor capability, make an
agent choose a machine, or expose a person's logged-in Chrome. The latter is
the separate `connected_browser` path, which the executor protocol says is
not advertised until its private-origin and disclosure gates are complete.

## Current truth

Remote board changes already have a durable watcher path:

1. `worker/src/control/board-source-webhook.ts`
   and `board-source-sync.ts` call `applyInboundItem`, then pass changed
   items to `notifyBoardWatchers`.
2. `worker/src/control/board-watch-notify.ts` claims the fingerprint,
   resolves board visibility and entitlement, writes a user's `UserAlert`, or
   calls `wakeBoardWatcherAgent` for an agent.
3. `worker/src/control/board-watch-wake.ts` checks the captured DM/thread and
   binding, writes a hidden `system` kickoff, and uses
   `claimThreadRunOrPend` plus `startAgentRun`.
4. `worker/src/control/agent-run-start.ts` creates the `Run` and `Task` and
   enqueues `run.execute`. `worker/src/run/execute/run-setup.ts` builds the
   executor toolset from bindings belonging to that run.

The watcher wake intentionally bypasses `AgentTrigger` delivery and trigger
health. It reuses the lower-level run claim and queue machinery because a
watcher is not a trigger row. That means a failed wake is currently a worker
log (`[board-watch] wake failed` or `agent watcher is unreachable`), with no
watcher-facing delivery state.

The gap is structural: a board wake creates no `ExecutorBinding`. The run
therefore has no executor tools when `buildExecutorToolset` queries bindings by
`runId`. The existing `/api/threads/:threadId/executor-runs` route and
`ExecutorRunLauncherDialog` are human-directed; they consume an opaque,
short-lived candidate handle and bind an exact bundle for that one run.

Board watchers also have no executor status or last-run doorway. The current
editor is Project → Settings → Boards → Watchers. It edits recipients only.
Separately, `moveProjectTaskToColumn` records local task events but does not
call `notifyBoardWatchers`; this proposal initially targets remote webhook and
sync events, and keeps that native-move gap explicit.

## Smallest secure scope

Add an optional **Act through executor** policy to one board watcher agent. The
policy is configured by an entitled human and contains only:

- the agent and board;
- one executor scope (private, project, or organization) or one pinned
  executor identity;
- one exact supported bundle: sandbox browser
  (`browser.open`, `browser.observe`, `browser.act`, `sandbox.stop`) or
  command workspace (`command.run`, `workspace.review`, `sandbox.stop`);
- an enabled/disabled state and an optional per-board run budget.

Do not persist the existing candidate handle: it is deliberately one-use and
run-bound. At wake time, the server should resolve the stored policy against
the current project, agent operation grants, approved descriptor, online state,
local policy, lifecycle state, and scope. Under the same transaction that
creates the watcher run, it should create the exact run-scoped bindings and
session required by the selected bundle. The agent still receives only the
operations granted to it; it never selects an executor or expands the bundle.

The policy editor belongs beneath the existing Watchers editor, with a clear
consequence sentence and an explicit **Disable executor actions** control. The
board page's Configure menu is the in-context doorway. The executor detail
page remains the home for descriptor review, grants, pause, drain, revoke, and
session inspection.

## Cost, lifecycle, and failure

Keep the existing board-watch coalescing: webhook changes are per ticket and a
sync sweep is one summary per board/run. A busy `(agent, thread)` slot already
uses `claimThreadRunOrPend`; executor actions must remain inside that one run,
not create one executor session per changed ticket. A board policy should also
have a bounded daily/run budget and a maximum session duration, using the
existing executor descriptor limits.

Every wake rechecks the policy. Disable, pause, drain, revoke, stale
descriptor, offline, missing grant, or scope mismatch must prevent binding and
write a sanitized last-run reason. Revocation and daemon fencing must stop an
active session through the existing `sandbox.stop`/session fence path. Unknown
command outcomes remain unknown; the board status must not claim that an agent
acted.

Add a compact status row to Watchers: last event time, run state, executor
scope, and one remediation message such as “Executor offline — start it” or
“Grant required — review executor access.” Link the run to the executor
Sessions view and the originating board, subject to the same project access.
Do not show command output, browser content, local paths, or origin ceilings on
the board surface.

## Verification seam

Extend the existing database test seams rather than adding a second watcher
pipeline:

- Extend `worker/test/db/board-watch-wake.test.ts` to prove a configured policy
  creates the exact bundle bindings and that a disabled/offline policy creates
  no binding and records its safe reason.
- Use a stand-in board-source adapter with
  `processBoardSourceWebhook` (and one post-initial-sync sweep) to prove remote
  change → watcher claim → run/task → binding → `run.execute` queue.
- Add a `@nessie/mock-llm` scenario that requests one allowed
  `executor.command.run` or `executor.browser.act` operation. A fake daemon can
  use the existing poll/receipt helpers to complete the command, proving the
  durable `executor.command` queue and result path without a Windows executor.
- Keep `worker/src/run/executor-toolset.test.ts` assertions for exact bundles,
  stable logical grants, operation grants, and no bindings meaning no tools.
- Add failure cases for budget exhaustion, stale descriptor, revocation during
  a pending wake, and unknown command outcome.

## Adoption gaps to keep visible

- Remote board creation is not a watcher trigger. The current source contract
  mirrors provider items inbound; the shipped write-back covers selected task
  edits and moves, not a general “create a ticket upstream” action.
- Several mapped fields remain inbound-only. The as-built board plan records
  that priority and custom fields are overwritten by the next sync; title,
  detail, and deadline have the narrower write-back path.
- Initial sync deliberately sends no watcher notifications. The first import
  produced 543 created rows in the tested board, so notifying each would be a
  flood; mapping and identity review still precede trustworthy automation.
- Watcher health is currently absent from the UI. The proposed status row is
  part of this change, rather than treating worker logs as an operator
  doorway.
- Native local moves do not yet enter the watcher notification seam. Adding
  them should be a separate decision because it changes the event and
  coalescing contract beyond remote-source adoption.

Approval is required before implementing the policy schema, run binding, UI,
and status surface.
