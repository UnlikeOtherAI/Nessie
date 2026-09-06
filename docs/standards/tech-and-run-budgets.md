# Stack, agentic-loop run budgets and run lifecycle

Authoritative standard, moved verbatim out of
[`CLAUDE.md`](../../CLAUDE.md) so it is read when the work touches this area
rather than loaded into every session. `CLAUDE.md` carries the one-line
summary and points here; **this file is the rule**.


- Node/TypeScript (strict mode), Fastify, Prisma + PostgreSQL
- Multi-tenancy: Organisation → Team → Project → Channel ([team-model.md](team-model.md)) with `organization_id` scoping on all child tables
- RBAC policy engine with deny-overrides; OIDC SSO with PKCE
- Agentic loop — run budgets (2026-08-05 redesign). The model and the failures
  behind each rule are the spec's:
  [docs/plans/2026-08-05-run-budgets-context-and-research-routing.md](../plans/2026-08-05-run-budgets-context-and-research-routing.md)
  — effective-token metering and the cache-read weight (§2a), the 80%
  wind-down and the ~90% reserved-headroom stop with its `RunCheckpoint`
  (§3/§3a), mid-run org-`Budget` recheck (§4), checkpoint continuation and the
  admin Continue (§5/§6), TaskEvents (§7), per-model context window and real
  compaction (§8), research routing (§9). Facts not restated there:
  - `Agent.effort` maps **only** to provider `reasoning_effort`; it never
    implies a spend cap. Per-dimension budget = `Agent.runLimits` (Agent
    Designer "Run limits") `??` the deployment backstop
    (`NESSIE_RUN_BACKSTOP_MAX_{TOKENS,TOOL_CALLS,ITERATIONS,WALLCLOCK_MS,COST_CENTS}`,
    defaults 500k / 2000 / 1000 / 45 min / 2000¢ — a safety envelope, not a
    user budget; `worker/src/run/run-budget.ts`).
  - A stop is classified `iteration_limit` / `tool_call_limit` / `time_limit` /
    `token_limit` / `cost_limit` / `repeated_tool_calls` / `org_budget_blocked`
    (`budget-stop.ts`); member-visible copy carries **no currency figures**.
  - The cache-read weight resolves once per run from the org
    `ModelPricingProfile` (`cacheReadPerMillion / inputPerMillion`, clamped to
    [0,1]), else `NESSIE_CACHE_READ_WEIGHT` (0.25).
  - Non-interactive runs (`payload.interactive !== true`) never ask and
    auto-continue up to `NESSIE_RUN_AUTO_CONTINUATIONS` (default 2), yielding to
    the per-(agent, thread) slot when busy. `delegate` sub-agents take a fixed
    small budget capped by `NESSIE_MAX_DELEGATES_PER_RUN` (16) and — like
    compaction — use `NESSIE_UTILITY_MODEL` when it resolves through the run's
    own org provider.
  - Tool results (builtin, MCP, `delegate`) are truncated **middle-out** at the
    single loop chokepoint (head ~70% / tail ~30%, idempotent). Per-tool caps:
    4,000 chars for `web_search`/`web_fetch`/`document_read`, 12,000 for raw
    `http_fetch` bodies, 32,000 as the ceiling (`worker/src/run/tool-util.ts`).
  - MCP tool descriptors are name-sorted with exposed names allocated in a
    fixed order, so the tool array is byte-identical across iterations and the
    prompt-cache prefix survives. Builtin sets above
    `NESSIE_BUILTIN_INLINE_TOOL_LIMIT` (default 20) keep a hot set inline and
    serve the rest through the non-mutating `tool_spec` meta tool
    ([docs/context-window-optimization-audit.md](../context-window-optimization-audit.md)).
  - Every run records a wall-clock-only stage breakdown at its terminal state
    (completion **and** failure) as a `run.timing` `TaskEvent` — `{ outcome,
    runId, queueWaitMs, totalMs, inferenceMs, inferenceCount, toolMs,
    toolCount }`, no cost data (`run-timing.ts`), written after the status flip
    so it can never fail a finished run. Owners: `GET /api/ledger/runs/timing`.
- **Budget and storage-quota admission are atomic, and say what they promise.**
  A run enters through `admitRunToBudget` (`packages/runtime/src/budget.ts`),
  not `evaluateBudget`: for an `enforce`/`degrade` budget with a limit it takes
  `pg_advisory_xact_lock` on the governing scope, reads recorded spend **plus
  the ceilings of runs already admitted and not yet settled**
  (`budget_reservations`, written from the run's `Agent.runLimits` ?? backstop
  envelope), and reserves inside one transaction. The guarantee is that
  admissions for one scope are serialised and a run that has recorded nothing
  yet is counted at its **full ceiling**, so two runs that fit one at a time but
  not together can never both be admitted, however many replicas are admitting.
  **State its limit alongside it** — an overclaimed cap is worse than an
  honestly documented soft one. The reservation is dropped by
  `recordInferenceUsage` on the run's **first** recorded usage (leaving the
  estimate beside the real number would double-count it), so from then on the
  run counts at what it has recorded, not at what it may still spend: "past the
  cap by at most one ceiling" is exact only while the competing runs have not
  started spending, and across a period of long, partially-recorded runs the
  excess is bounded by their unrecorded headroom instead. Bounding a single
  run's own total remains the envelope's and the mid-run recheck's job.
  Reservations are an estimate, so only admission reads them: `/ops/usage`,
  `listBudgetStatuses` and the mid-run recheck stay on recorded spend. A
  reservation is ignored once its run is terminal, and swept in
  `worker/src/control/budget-reservation-sweep.ts`. `warn`/`unlimited`/`off`
  never take the lock. The storage quota is the same shape:
  `withStorageAdmission` (`packages/runtime/src/storage-quota.ts`) runs the
  check and the `storage_usage_events` writes in one transaction under the
  organisation's lock, which makes it exact rather than "exact modulo
  concurrent uploads". **Both** paths that store bytes go through it — the
  upload itself (`files/index.ts`) and the deferred preview backfill
  (`files/attachment-thumbnails.ts`, whose pre-check is only a cheap early-out);
  a preview is stored bytes like any other, so a check that is not atomic with
  the write making it visible would reopen the same race. What the guarantee
  rests on is that `FileService` is the only writer of those bytes.
- **Budget threshold alerts + failed-run attribution** (local ops only, never
  UOA credits). The gate no longer only observes usage passively: `evaluateBudget`
  (`packages/runtime/src/budget.ts`) returns the byte-identical verdict PLUS an
  alert snapshot, and `applyBudgetGate` fires **at most once per budget scope per
  period** when cumulative spend first crosses `Budget.warnThresholdPercent`
  ('threshold') or first blocks a run ('blocked'). Alerting runs AFTER the verdict
  is applied and swallows its own errors, so blocking behaviour is unchanged.
  Durable crash-safe dedupe = a `budget_alerts` marker row unique on
  `(scopeType, scopeId, periodStart, kind)`; each alert emits a
  `budget.threshold_alert` `TaskEvent` and enqueues `budget.alert-dispatch`,
  notifying org owners + the scope's managers through the shared push pipeline
  (`worker/src/control/push-delivery-core.ts`), respecting preferences and
  deep-linking `/ops/usage`. Every terminal run persists its inference spend —
  the generic failure/crash path too, via a caller-owned invocation accumulator
  threaded through `runAgenticLoop`, so a failed run's tokens stay attributable
  (idempotent on `inferenceInvocationId`). Owners read spend by run outcome at
  `GET /api/ledger/tokens/by-outcome`.
- Active run lifecycle controls (`api/src/routes/runs.ts` +
  `api/src/services/runs.ts`): org-scoped `GET /api/runs/active` lists live runs
  (+ recently-ended restartable ones); `POST /api/runs/:id/cancel` cancels — a
  queued/approval-suspended run flips straight to `cancelled` (never executes),
  a running run gets a cooperative `cancelRequestedAt` flag the loop polls
  between iterations and tool batches, exiting via the classified-stop
  machinery (`worker/src/run/execute/cancel-stop.ts`, mirroring budget-stop:
  partial text + a "cancelled" notice + `run.cancelled` `TaskEvent`).
  `POST /api/runs/:id/restart` re-runs a terminal `failed`/`cancelled` run,
  replaying the same trigger message and linking via `Run.restartOfRunId`.
  `POST /api/runs/:id/continue` (`api/src/services/run-continuation.ts`)
  resumes a terminal run from its unconsumed `RunCheckpoint`: same channel
  access that could have triggered the run, one transaction claiming the
  checkpoint (set-once `consumedByRunId`) + creating the continuation run
  (`Run.continuationOfRunId`) + task + enqueue; 409s: `RUN_BUSY`,
  `RUN_CHECKPOINT_CONSUMED`, `RUN_NOT_CONTINUABLE`. A run whose
  trigger message carries `integrationLaunch` metadata (DeepWater handoff) is
  rejected from cancel/restart/continue with `409 RUN_HANDOFF_MANAGED` → use
  `research_cancel`; the
  handoff invariants are never touched. `Run.triggerMessageId` (populated by the
  chat orchestrator + integration handoffs) backs both the guard and the replay.
  Admin cancel is surfaced on the live document-stream dialog
  (`useCancelRun`) and Continue on budget-stop notices
  (`admin/src/components/features/channels/RunStopContinue.tsx`, `useContinueRun`);
  the standalone Agents → Activity page and its `RunLifecyclePanel` were removed,
  so the org-wide active-run list and the restart control have no admin surface
  (the `GET /api/runs/active` and `POST /api/runs/:id/restart` endpoints remain,
  API-only).
- MCP connector management (REST, not JSON-RPC): `api/src/routes/mcp.ts`
- MDNS/Bonjour — backend advertises `_nessie._tcp` for local network discovery
