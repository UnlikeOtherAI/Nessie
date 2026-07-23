# Known Limitations

A candid, code-verified register of Nessie's current limitations, modeled on the
"Known Limitations" candor practice from block/buzz's `ARCHITECTURE.md` (see
[docs/reviews/2026-07-23-buzz-comparison.md](reviews/2026-07-23-buzz-comparison.md)
§3, "Docs candor").

**How to read this.** Every entry below was checked against the code at the
cited path on **2026-07-23** — this table is not a copy of stale planning-doc
claims. Where a source doc (`docs/implementation-phases.md`, mostly the
2026-04-08/09 "Phase 2 code-level prerequisites" list) claimed a defect that the
code has since fixed, the entry is recorded as **Resolved** with the evidence,
so the register stays trustworthy rather than alarmist. Line numbers are
approximate and drift with edits.

**Status taxonomy**

- **Confirmed in code** — the limitation is present and verified at the cited location.
- **Partially mitigated** — a real mitigation exists in code but does not fully close the gap.
- **Fix in progress** — an active branch/spec addresses it as of 2026-07-23 (see note); the entry is worded to stay accurate whether or not that work has merged when you read this.
- **Stale / superseded** — the original concern no longer applies because the architecture changed (e.g. Cloud Run → self-hosted Hetzner).
- **Resolved** — a previously documented limitation that current code fixes; kept here only to correct a still-open claim in a source doc.

> **Update, later on 2026-07-23:** both in-flight fixes have landed on `main`.
> Silent budget-cap truncation (L1) is Resolved — stops are now classified and
> user-visible. Realtime channel-privacy fan-out (L2) was re-verified as
> already mitigated and is now locked in by regression tests; its residual is
> mid-connection membership revocation.

---

## Active limitations

| ID | Limitation | Where (file:line ≈) | Status | Impact / notes |
|----|------------|---------------------|--------|----------------|
| L1 | **Silent budget-cap truncation.** A per-run cap (iterations / tool calls / wallclock / tokens / cost / repeated-calls) used to end the run with an empty `finalText` and only a `console.warn`. | `worker/src/run/execute/budget-stop.ts` (classification + notice); wired in `worker/src/run/execute/run-job.ts` | Resolved (2026-07-23) | Cap stops are now classified (`iteration_limit` … `repeated_tool_calls`), recorded as a `run.budget_exhausted` `TaskEvent`, and always user-visible: partial answers are delivered with an explicit stop notice, and no-answer stops post the notice as the terminal message and fail the run. Remaining harness-v2 scope (`waiting_budget` pause/resume, run-detail UI badge) is still open — see `docs/plans/2026-07-20-agent-harness-v2.md`. |
| L2 | **Realtime WS/SSE channel-privacy fan-out.** Historically events were published at org scope and delivered on org match alone, bypassing channel privacy. | `api/src/realtime/hub.ts` (`shouldDeliverWsNotification`); `api/src/lib/request-helpers.ts:433` (`canAccessChannelRealtimeEvent` via `getVisibleChannel`, `filterAuthorizedScopes`); wired at `api/src/index.ts:215` | Partially mitigated | Re-verified 2026-07-23: subscribe-time authorization (`filterAuthorizedScopes`, membership-derived SSE scopes, thread access checks) and delivery-time re-checks are all in place and locked in by `api/test/realtime-subscription-authz.test.ts`. The remaining gap is **mid-connection membership revocation**: a user who loses channel access keeps receiving that channel's events until they reconnect (`api/src/services/realtime-events.ts:100` TODO). |
| L3 | **Run execution idempotency is enqueue-level only.** At-least-once queue retries can still re-run a claimed job's side effects. | `worker/src/queue.ts:23-49` (`INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`) | Partially mitigated | Duplicate *enqueues* are now deduped via a unique `idempotency_key`, and `QueueJob.idempotencyKey` is populated by callers (e.g. `worker/src/run/memory-consolidation.ts`). There is still no "already completed" guard on retry of an in-flight job, so a retried attempt can re-emit output. `docs/implementation-phases.md` #8 ("PARTIAL — schema field exists, enforcement missing") remains directionally accurate. |
| L4 | **Single active membership in the tenant context.** A user in multiple orgs/teams is bound to their first membership for role/tenant resolution; project/team switching is limited. | `api/src/services/users.ts:28-29` (`organizationMembers[0]`) | Confirmed in code | `docs/implementation-phases.md` #5. Auth *does* now enumerate memberships (`api/src/services/auth.ts` `loadUserMemberships`) and login guards `NO_MEMBERSHIP`, but the mapped `TenantContext`/`/me` role still hard-selects index `[0]`. Full multi-membership switching is not implemented. |
| L5 | **Tenant hierarchy cross-consistency is not DB-enforced.** `Channel` references organization, project and team via independent FKs; nothing constrains that the team's project belongs to the same organization. | `api/prisma/schema.prisma` (`model Channel` — separate `organization`/`project`/`team` relations) | Confirmed in code | `docs/implementation-phases.md` #10. Individual `onDelete: Cascade` FKs exist, but no composite invariant or application-level check was found guaranteeing hierarchy consistency. Low risk for API-created rows (the services set all three coherently); the gap is at the schema/raw-write boundary. |
| L6 | **Whole context re-sent each iteration; no auto-compaction.** Every agentic turn re-sends system prompt + tool schemas + full conversation + accumulated tool results, and `maxTokens` counts cumulative usage across turns. | `worker/src/run/agentic-loop.ts` (`sumTokens`); analysis in `docs/context-window-optimization-audit.md` §1–2 | Confirmed in code | Gives context overhead a ~`iterations ×` multiplier against the run's token budget, so long-horizon work hits `maxTokens` early. Prompt-prefix caching softens cost but not the budget count. The Agent Harness v2 spec (auto-compaction at 90% context) is the intended remedy; not yet built. |
| L7 | **Pub/Sub queue provider is not implemented.** Setting `config.queue.provider = 'pubsub'` warns and silently falls back to the Postgres queue. | `worker/src/index.ts:102-105` | Stale / superseded | No longer a real defect: production is self-hosted on Hetzner with a **Postgres-backed queue by design** (no Redis, no Pub/Sub) — the Cloud Run assumption behind `docs/implementation-phases.md` #12 is retired. Kept here only to flag that the config switch is a dead branch that could be removed. |

## Resolved since documented (source doc still lists them open)

These correct still-open claims in `docs/implementation-phases.md`'s Phase 2
prerequisite list (statuses there were last touched 2026-04-09). Verified fixed
in current code.

| ID | Was documented as | Now | Evidence |
|----|-------------------|-----|----------|
| R1 | #3 "Agent binding has no authorization check" (NOT FIXED) | Resolved | `api/src/routes/agents.ts:259` gates `agent`/`bind` through `checkPolicy` and returns `403 POLICY_DENIED`; `bindAgentToChannel` is org-scoped (`api/src/services/agent-bindings.ts:19-45`). |
| R2 | #4 "`NESSIE_AUTH_SECRET` fallback to per-process random breaks multi-instance" (NOT FIXED) | Resolved | `api/src/lib/server-context.ts:162-172` requires the secret in `hosted`/`selfHosted` modes (FATAL `process.exit(1)` if unset); the ephemeral `randomUUID()` fallback only applies to single-instance `local` dev. |
| R3 | #7 "Worker ignores `actorContext`" (PARTIAL — carried but unused) | Resolved | `actorContext` is consumed for tenancy and policy in `worker/src/run/execute/budget-gate.ts:62-64`, `worker/src/run/execute/policy.ts:59-115`, `worker/src/run/execute/memory.ts:156-161`, and tool actor context in `worker/src/run/execute/agent-loop.ts:284`. |
| R4 | #9 "Agent model lacks ownership fields" (NOT FIXED) | Resolved | `model Agent` in `api/prisma/schema.prisma` now carries `organizationId`, `projectId`, `teamId` (with indexes). |
| R5 | #11 "Public channels require membership to be visible" (NOT FIXED) | Resolved | `api/src/services/channels.ts:39` includes `{ visibility: 'public' }` in listing and `:295-300` grants public-channel access without a membership row. |
| R6 | #2 "Shared-agent REST endpoints leak cross-channel history" (NOT FIXED) | Resolved | `api/src/services/agent-read-model.ts:360-385` scopes agent reads by channel scope through `buildAccessibleChannelWhere(visibility)`; owner-only widening is gated by `createAgentVisibilityScope` (`api/src/lib/request-helpers.ts:440`). |
| R7 | #6 "Login and SSO auto-provision hardcode bootstrap org/project/team IDs" (NOT FIXED) | Resolved (see L4) | `api/src/routes/auth-core.ts` + `api/src/services/auth.ts` resolve real memberships (`loadUserMemberships`) and error `NO_MEMBERSHIP` instead of issuing reserved bootstrap IDs. The residual single-active-membership limit is tracked as L4. |
| R8 | #15 "Admin WS client missing ping; SSE missing `Last-Event-ID` reconnect" (NOT FIXED) | Resolved | SSE clients send `Last-Event-ID` on reconnect (`admin/src/facades/threads/hooks.ts:92-93`, `admin/src/facades/notifications/useMessageNotifications.ts:363-364`); the server keeps a replay store (`api/src/realtime/hub.ts`), and `PresenceProvider` runs a keepalive heartbeat (`admin/src/providers/PresenceProvider.tsx:94`). |

---

*Not re-verified this pass (carried from `docs/implementation-phases.md` without
independent code confirmation): #13 channel-listing N+1 and #14 activity-query
scaling. They are omitted from the tables above rather than asserted, to keep
this register limited to checked claims. Verify against
`api/src/services/channels.ts` and the agent activity loaders before relying on
their status.*
