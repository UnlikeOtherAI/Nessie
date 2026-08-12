# Workflows delivery log

Shipped work for [2026-08-12-workflows-first-class.md](./2026-08-12-workflows-first-class.md).
The plan states intent and stays stable; this log records what actually shipped,
so the plan does not grow an implementation history inside itself.

## Stage 1

### Section A — correctness core (merged)

- **W1 · Guard terminal transitions — done.** Both writes in
  `markWorkflowStepRunFinished` / `markWorkflowRunFinished`
  (`worker/src/run/workflows.ts`) are guarded `updateMany` on non-terminal status
  (the `cancelWorkflowRun`/`skipWorkflowStepRun` pattern) and report `applied`, so
  callers skip continuation and the terminal event when the write lost the race; a
  cancelled run can no longer be resurrected by its orphaned child.
- **W2 · Cancel propagates to every kind of child, not just agents — done.**
  `cancelWorkflowRun` (`api/src/services/workflows.ts`) skips pending/blocked
  steps outright and propagates per running-step kind: agent children get the
  cooperative `cancelRequestedAt` flag (the step output names the abandoned
  queued mailbox message), `environment_launch` instances get an
  `execution.environment.terminate` job, in-flight tool steps are recorded
  *abandoned-but-possibly-executing* (`cancelAbandonedAt` on the output, reason
  extended with "may still execute"). Propagation is gated on the guarded run
  transition winning, so a concurrent terminalization owns it.
- **W3 · Emit terminal events from async continuations — done.**
  `worker/src/run/execute/parent-workflow.ts` and
  `worker/src/control/execution/workflow-continuation.ts` now finish through
  `finishWorkflowStepRun` (`worker/src/run/workflow-step-finish.ts`), the
  emitting seam shared with `worker/src/control/workflows.ts` (placed in `run/`
  so `run/` needs no `control/` dependency): a final asynchronous step
  (`agent_task`, the common last step) fires `workflow.run.completed/failed`,
  and only when the guarded transition applied.
- **W4 · Snapshot the graph onto the run — done.**
  `WorkflowRun.graphSnapshot` is frozen at run creation from the installation's
  new `pinnedGraphJson`, via the shared `resolveInstallationPinnedGraph`
  (`@nessie/workspace-admin`), at all four run-creation sites.
  `loadWorkflowGraph` executes from that snapshot; pre-snapshot rows fall back to
  the template's current graph — what they were already executing. The migration
  pins only installations with no run in flight. Self-healing edge: a run
  backfilled while suspended can disagree with its materialized step rows after a
  template edit, so the executor detects the drift and re-pins the graph those
  rows came from, and old and new steps never interleave.
- **W5 · Remove `delegate` from the workflow tool set — done.**
  `packages/runtime/src/workflow-tools.ts` no longer advertises it, so
  `WORKFLOW_TOOL_IDS` rejects it at save time. Not implemented — sub-agent fan-out
  from a deterministic step stays out of scope.
- **W6 · Reap stuck steps — by lease, not by age — done.**
  `WorkflowStepRun` gained `leaseOwnerId`/`leaseExpiresAt`/`deadlineAt`. A
  `tool_call` step is claimed with a 120s lease and heartbeated every 30s while
  `executeWorkflowBuiltinTool` runs; suspended steps hold no lease and take
  `deadlineAt` instead (step `timeoutMs` when present, else a 24h default). The
  sweep `reapStuckWorkflowSteps` (`worker/src/control/workflow-step-reaper.ts`,
  a 15s interval beside the trigger scheduler) selects `FOR UPDATE SKIP LOCKED`
  and reclaims on **two conditions**: an expired lease (worker died) **or** an
  expired deadline (suspended step waiting on an external continuation).
  Reclaimed steps fail through the Section A guarded transition, so the run
  terminalizes and emits its event. Finishing clears the lease/deadline.
- **W7 · Mark unreached steps `skipped` on failure — done.** The guarded
  failure transition in `markWorkflowStepRunFinished` flips still-`pending`/
  `blocked` steps to `skipped`, so a failed run no longer leaves later steps
  reading as "still coming".
