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

### Section B — graph snapshots and lease reaping (merged)

- **W4 · Snapshot the graph onto the run.** `WorkflowRun.graphSnapshot` is frozen
  at run creation from a new installation-level `pinnedGraphJson`, via the shared
  `resolveInstallationPinnedGraph` (`@nessie/workspace-admin`), at all four
  run-creation sites. `loadWorkflowGraph` executes from that snapshot;
  pre-snapshot rows fall back to the template graph they were already executing.
  The migration pins only installations with nothing in flight. Self-healing
  edge: a run backfilled while suspended can disagree with its materialized step
  rows after a template edit, so the executor detects the drift and re-pins the
  graph those rows came from — old and new steps never interleave.
- **W6 · Reap stuck steps by lease, not by age.** `WorkflowStepRun` gained
  `leaseOwnerId`/`leaseExpiresAt`/`deadlineAt`. A `tool_call` step is claimed with
  a 120s lease and heartbeated every 30s; suspended steps hold no lease and take
  `deadlineAt` (step `timeoutMs` when present, else 24h). `reapStuckWorkflowSteps`
  (`worker/src/control/workflow-step-reaper.ts`, a 15s interval beside the trigger
  scheduler) selects `FOR UPDATE SKIP LOCKED` and reclaims on **two conditions**:
  expired lease (worker died) or expired deadline (suspended step). Reclaimed
  steps fail through the Section A guarded transition.

### Section C — validation and designer honesty (merged)

- **W8 · `paused` actually pauses.** Dispatch now rejects `paused`, and a new
  update-installation endpoint exists at all — status was write-once at install.
  Contradictory `active`/`status` combinations are rejected by one validated
  lifecycle (`resolveWorkflowInstallationLifecycle`).
- **W9 · `{{` no longer disables validation.** Binding expressions are parsed
  against one exported grammar (`@nessie/workspace-admin`
  `workflow-binding-grammar.ts`), and every `steps.<id>` reference must name a
  step that exists *and precedes* the referencing step. A typo is a save error.
  This grammar is the seam §5 requires the JMESPath compiler to share.
- **W10 · The designer stops eating steps.** Unknown/unrenderable steps
  (`environment_launch`) survive a load→save cycle instead of being silently
  dropped from the template.
- **W11 · The canvas stops drawing fiction.** Cycles, multiple outgoing *and
  incoming* edges, merges, and disconnected components are rejected; a graph must
  be exactly one connected chain, matching what the runtime can execute.
- **W12 · One tool allow-list.** The runtime list is authoritative; the canvas
  mirrors it (admin cannot import `@nessie/runtime`) and a test asserts the two
  agree, so they can no longer drift apart silently.
- **W13 · Trigger node demoted.** Cron/timezone/interval fields removed from the
  canvas inspector — they never created an `AgentTrigger` — and `trigger` dropped
  from the executable step-type set. The Triggers page is the one authoring
  surface; install-time `triggersJson` materialisation collapsed to one path.
- **W14 · Designer drafts keyed per template**, so opening "new workflow" no
  longer hydrates the previously edited template's nodes.
- **W24 · Cursor pagination** on the list endpoints, and the leading comment that
  claimed the select omits `graphJson` corrected.
- **W27 · Retry preserves the original actor** instead of overwriting
  `startedByActorId` with the retrying owner; the retry actor is recorded
  separately (migration `20260812190000_workflow_run_retry_actor`).
- **W28 · `agent_task` target check** moved inside the mailbox transaction and its
  failure text made org-generic, closing both the race and the cross-org
  existence leak. Required before Section G widens who may start runs.

### Section D — W0, the redaction boundary

The boundary lives in one shared module,
`@nessie/workspace-admin` `workflow-secrets.ts`, consumed by both the API
(write gate + server-side response redaction) and the worker
(interpolation-time redaction). No second secret store: reference bindings
hold only the `secret_*` ref shape the encrypted `@nessie/mcp-manage` store
already mints (`createPgSecretStore` enforces the prefix), so W19+ can resolve
them through the existing `createMcpSecretResolver` without new plumbing.

- **Write gate.** `validateWorkflowSecretWrite` runs inside
  `installWorkflowTemplate` (against the template's own `bindingSchema`) and
  `updateWorkflowInstallation`. A plaintext value at a reference-typed key, or
  a caller-chosen `secret_*` ref anywhere else (literal bindings, `config`,
  nested), throws `WorkflowSecretWriteError`; the install/PATCH routes map it
  to `400 WORKFLOW_BINDING_SECRET_INVALID` with per-path reasons. This mirrors
  the MCP rule that public writes never accept a caller-chosen credential ref.
- **Reference declaration.** `bindingSchema` per-key entries opt into
  reference-ness via `{ kind|type: 'reference' }`, `{ reference: true }`, or
  the bare string `'reference'`; everything else is a literal.
- **Taint is value-shaped, not schema-driven.** `collectWorkflowTaintedRefs`
  walks `resolvedBindings` for `secret_*`-shaped strings. The write gate
  already guarantees refs can only persist at reference keys, so every
  well-formed ref found is a capability — this covers pre-boundary rows and
  lets the worker taint identically without loading the template.
- **Sink 1 (read widening).** `mapWorkflowInstallation` replaces reference
  binding values with `[redacted]` in the service mapper (install response,
  list, PATCH); `getWorkflowRun` additionally re-reads the installation's
  bindings and redacts tainted refs from run `input`/`output` and every step
  run's persisted `input`/`output`. Server-side only — the admin renders what
  it is given.
- **Sinks 2+3 (messages, transform context).** `resolveWorkflowStepInput` in
  `worker/src/control/workflows.ts` derives the taint set once per context
  (`buildWorkflowBindingContext`) and redacts every value resolved from any
  scope (`workflow.*` and `steps.*` — a persisted pre-boundary step artifact
  must not become a bypass). A whole-ref value becomes `[redacted]`; a ref
  embedded in a longer string is masked in place. `buildAgentTaskBody` redacts
  step input and workflow input before the body reaches the agent prompt.
- **Sink 4 (persisted samples).** Same `getWorkflowRun` redaction: the step
  `input`/`output` the designer replay and §5 sample surfaces read is the
  redacted projection.
- **Tests.** `api/test/workflow-secrets.test.ts` (DB): plaintext write
  rejected at a reference key, caller-chosen ref rejected in `config` and on
  update; install/list responses never serialize the ref; run detail redacts
  a deliberately seeded tainted `WorkflowStepRun.input` and run `output`.
  `worker/test/workflow-redaction.test.ts`: exact-reference and mixed-template
  interpolation redact from both `workflow.*` and `steps.*` scopes, and
  agent-task bodies never carry a persisted ref.

### Section E — the primitives (merged)

- **W15 · `message_send`.** A deterministic channel write
  (`worker/src/control/workflow-message-send.ts`) through the existing
  message-create service, under the run's durable actor, defaulting to the
  installation's channel and validating any other target inside the same
  transaction. Bodies pass through W0's redaction, so a tainted binding cannot
  reach a channel. **This is the item that repays the whole subsystem:** a test
  asserts a workflow delivers a message with *zero* agent runs created, so
  deterministic output no longer costs an inference hop.
- **W16 · `when:` guard.** A step-level predicate; falsy marks the step `skipped`
  and the run continues. Carries the shared JMESPath evaluator
  (`packages/workspace-admin/src/workflow-jmespath.ts`) with the §5 envelope —
  4 KiB expression, 1 MiB input, 256 KiB output, evaluated off the worker event
  loop — which Section F's `transform` reuses. Compiled at save time through W9's
  grammar seam, so a bad predicate is a save error.
- **W18 · `state_put` compare-and-set, complete contract.** `state_get` and
  `change_detect` return the exact version compared; `state_put(expectedVersion)`
  fails on mismatch; the guarded write precedes the notification side effect; and
  the write is attempt-scoped — a same-`(stepRunId, attempt)` repeat with a
  matching value hash is an idempotent no-op, so a crash between a successful
  write and the step being marked finished cannot wedge a watcher permanently.
- **W26 · Overlap policy.** `WorkflowInstallation.concurrency`
  (`{ limit, onOverlap }`, default `{ 1, 'skip' }`) enforced under
  `pg_advisory_xact_lock` at every entrypoint, not only the scheduled path.
  `skip` records the delivery as `skipped_overlap` so silent skips stay
  diagnosable; `queue` is depth-bounded. CAS detects the collision, this prevents
  it — both were needed.
