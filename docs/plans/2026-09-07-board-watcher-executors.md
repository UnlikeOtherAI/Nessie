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

Watcher recipient authorization remains a separate prerequisite. The server
must apply the same agent visibility fence as the rest of the product: a
shared team agent may be selected when the board administrator is entitled to
address it, a private agent only by its live owner, and system-managed agents
and the Personal Assistant are never watcher targets. A project-admin role
does not widen a private agent's audience. The current watcher resolver checks
the organization and the private home, but does not compare the adder with the
private owner; that comparison must land before an executor policy can attach
to a watcher.

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
- Add recipient authorization cases: a system-managed agent is refused, a
  private agent is accepted only for its live owner, and another project admin
  cannot use that private agent's owner DM as a watcher destination.
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

- A board's **New task** action creates a native Nessie task. It does not create
  a Jira, Linear, Trello or GitHub item upstream. The reverse direction is
  inbound mirroring, and remote item creation is not a watcher trigger until
  its first sync/webhook apply; there is no general upstream-create action.
- Several mapped fields remain inbound-only. The as-built board plan records
  that priority and custom fields are overwritten by the next sync; title,
  detail, and deadline have the narrower write-back path.
- Source destination is not implicit. Attach seeds provider-derived category
  mappings, but a person must review the state table and choose a default
  write-back state for each active category (or bind a board column to one).
  The source remains `read_only` by default, so no executor policy should
  assume that a card move can reach the provider.
- Webhook and polling are equivalent intake paths, not equivalent freshness:
  per-source webhooks notify per item when registration and provider
  permissions allow them; the incremental sweep is the fallback and emits a
  coalesced summary. The status surface must say which path is active and the
  tests must prove both paths share fingerprint/idempotency handling.
- Initial sync deliberately sends no watcher notifications. The first import
  produced 543 created rows in the tested board, so notifying each would be a
  flood; mapping and identity review still precede trustworthy automation.
- Email auto-matching is only an adoption bridge against UOA-mirrored profile
  data. UOA's stable subject and live membership remain the authority; a
  provider email must never create a Nessie person or become a durable
  identity key. Until a provider-to-UOA subject binding exists, exact email
  matching should stay reviewable, visible as `matchedBy: email`, and easy to
  override; membership deactivation or an upstream email change must stop
  future automatic reprojection rather than silently retargeting work.
- Watcher health is currently absent from the UI. The proposed status row must
  cover ordinary wake failures as well as executor failures, with a durable
  sanitized reason and a remediation doorway; worker logs alone are not an
  operator surface. Executor policy must also show disabled, unavailable,
  denied, budget-exhausted and unknown-outcome states without claiming that an
  agent acted.
- Native local moves do not yet enter the watcher notification seam. Adding
  them should be a separate decision because it changes the event and
  coalescing contract beyond remote-source adoption.

## Acceptance checklist before approval

- A native task remains local; a mapped remote item is created only by sync or
  webhook intake, and the first import produces no watcher wake.
- A reviewed state mapping has an explicit category destination before
  read-write movement or executor action is enabled.
- The same changed remote item produces one coalesced watcher outcome through
  either webhook or polling, with duplicate delivery suppressed by the existing
  fingerprint claim.
- A provider identity is either explicitly linked or visibly unresolved;
  email auto-match is never treated as UOA identity authority.
- A watcher failure has a durable, sanitized reason reachable from Watchers;
  executor actions are bound only after current policy, scope, grant,
  descriptor, budget and live-agent authorization checks pass.

Approval is required before implementing the policy schema, run binding, UI,
and status surface.
