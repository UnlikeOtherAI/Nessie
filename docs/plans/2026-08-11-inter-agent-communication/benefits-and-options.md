# Part 3 — Benefits and costs

## 3.1 Benefits

**The product promise becomes true.** "Agents are employees" currently means
"agents answer in channels." Delegation with a reply, a deadline, and a visible
status is what makes a team of agents different from a chatbot with sub-calls.

**Async work becomes possible.** `delegate` blocks the parent for the sub-agent's
whole run. A mailbox does not: a researcher can be tasked at 09:00 and answer at
09:40 while the requester goes on with other work — which is also how the run-slot
serialization and pending-marker machinery already wants to behave.

**One channel means one audit.** Every hand-off in a single typed, append-only,
hash-chained stream gives an inter-agent timeline nobody can assemble today. It
also makes cost attribution across a delegation tree possible.

**Attenuation kills privilege laundering.** With a grant object, "researcher asks
builder to deploy" is refused by the policy engine rather than by hoping the
builder's prompt holds.

**It shrinks the improvisation incentive.** The incident's lesson is that agents
route around missing capability. A good bus is a security control precisely because
it is easier than a workaround.

**Enterprise sales.** "Show me every instruction one agent gave another, who
authorized it, and what it cost" is a procurement question with no answer today.

## 3.2 Costs and risks — stated plainly

**Cost 1: this is genuinely large.** The full brief is 4 phases, ~15 new tables,
a policy decision point, an artefact service, and a broker abstraction. That is
several months. Nessie's real constraint is not ambition, it is
[`AGENTS.md`](../../../AGENTS.md) → Rule zero: capabilities that ship without a
surface. A grant engine with no grant UI would be the largest unsurfaced
capability in the codebase.

**Cost 2: over-engineering risk is real and named in our own standards.**
`AGENTS.md` → Code Quality says "build the simplest thing that satisfies the
current goal. No premature abstractions, no speculative generality." SPIFFE/SPIRE,
mTLS between agents, and a Cedar/OPA policy engine are speculative for a
single-process worker where every agent runs in the same Node process. **They
should be explicitly deferred, not silently skipped.**

**Cost 3: latency and token overhead.** Every hop through a policy decision point
adds a round trip. Grant summaries in the system prompt cost tokens on every
iteration — and the run-budget work of 2026-08-05 exists precisely because context
is scarce.

**Cost 4: agents will hit walls that used to be open.** Attenuation means a child
can no longer do what its parent could. Expect a period where legitimate work is
refused, and budget for the diagnostics to explain *why* (this is what the
`AUTHORIZATION_REQUIRED` reason codes are for).

**Cost 5: a second messaging system is a maintenance liability.** Nessie already
has `Message` + threads + reply threads + realtime + push. A parallel bus that
duplicates delivery, ordering, and read-state would be a fork of the surface —
also forbidden by Rule zero #4. **The bus must reuse threads as its transport
where the exchange is conversational.**

**Cost 6: RLS is not free.** Adding RLS to a schema this size means an application
role, session-variable plumbing on every connection, and a real risk of breaking
the worker's global pollers (which deliberately read across tenants). Worth doing,
but not as part of this feature.

## 3.3 What I recommend against

- **A peer-to-peer agent mesh.** Supervisor-led + capability addressing only.
- **Cryptographic per-agent workload identity (SPIFFE/mTLS) in v1.** Agents share
  one worker process; broker-verified publisher metadata gives the same durable
  attribution at a fraction of the cost. Revisit if agents ever get separate
  containers.
- **A separate broker (NATS/Pub-Sub) in v1.** `QueueJob` + Postgres `LISTEN/NOTIFY`
  already provide at-least-once delivery with idempotency. Keep the
  `AgentEventTransport` interface so a broker can be swapped in later.
- **A general policy engine (OPA/Cedar) in v1.** The existing deny-overrides RBAC
  plus a `TaskGrant` row is enough for the first two phases.

---

# Part 4 — Auditability options

The question "how do we audit inter-agent communication" has three real answers at
increasing cost. They are additive: B contains A, C contains B.

### Option A — Reuse the existing spine (cheapest, ~1 week)

Write every inter-agent hand-off into the structures that already exist:

- an `AuditLog` row per send / claim / deliver / dead-letter — inherits the
  per-org SHA-256 hash chain and the existing verifier for free;
- a `TaskEvent` (`agent.message.sent` / `.delivered` / `.failed`) on the
  requesting task, so it lands on the task timeline;
- `ToolCall` already captures the sending tool call.

**Pros:** no new tables, tamper-evidence on day one, works with the existing audit
UI and chain verifier.
**Cons:** no causation graph (you can list events but not walk a chain);
`AuditLog.metadata` is untyped JSON, so queries are ad-hoc; no artefact hashing.

**Audit what is meaningful, not every transition.** `writeAuditEntry` opens its
own transaction and swallows its failures
([`audit.ts:46-71`](../../../api/src/services/audit.ts#L46)), so auditing every lease
claim and retry is both noisy and non-atomic. Audit **send / accepted /
completed / failed**; leave claims and retries as operational telemetry. If audit
must be atomic with the state change, use a transactional audit outbox rather
than a nested write.

### Option B — Typed envelope on a dedicated stream (recommended, ~3 weeks)

Add one table, `agent_task_events`, holding a **slimmed** version of the
CloudEvents-shaped envelope from brief §5 — only fields we can populate and use:

```text
id, organizationId, taskId, parentTaskId, threadId,
type              -- versioned string: ai.nessie.task.<name>.v1
sequence          -- monotonic per task, gaps allowed
causationId       -- the event this answers
correlationId     -- the root run
fromAgentId, fromRunId, recipientKind, recipientRef,
grantId, purpose,
payload (jsonb, schema-validated per type),
artifactRefs (jsonb: [{attachmentId, sha256}]),
idempotencyKey, expiresAt, createdAt
```

Server-stamped fields (`organizationId`, `fromAgentId`, `fromRunId`, `grantId`,
`sequence`, `causationId`, timestamps) are never accepted from the model — the
tool gateway derives them from the authenticated run, exactly as brief §5 requires.

**Cut from the first draft, on review:**

- `classification` — Nessie has no data-classification system. Importing the
  vocabulary before the concept exists is exactly the speculative generality
  `AGENTS.md` forbids.
- `payloadSha256` — redundant with the `AuditLog` hash chain, which lives in the
  same database under the same threat model. It buys nothing an attacker who can
  write one table cannot also defeat in the other.
- **gap-free** `sequence` — requires per-task write serialization this plan
  elsewhere rejects. Monotonic-with-gaps plus `causationId` is sufficient for
  ordering and reconstruction.

**Why not just extend `TaskEvent`?** This was the reviewers' sharpest
disagreement and it is worth recording. Reusing `TaskEvent` is attractive — it
exists, it is insert-only, it renders the timeline, and adding four nullable
columns is one migration. But `TaskEvent` **cascade-deletes with its task and has
no `organizationId`** ([`schema.prisma:2518-2528`](../../../api/prisma/schema.prisma#L2518)).
An inter-agent audit trail that dies when someone deletes a task, and cannot be
queried per tenant, is not an audit trail. Inter-agent causation also spans
tasks, which a task-scoped table models badly.

**The dissent, recorded:** one reviewer argued to extend `TaskEvent` anyway,
first removing the cascade — which is defensible, but that is a migration
touching every existing task timeline plus a backfill of `organizationId`, to
avoid adding one table. Decision: separate table. Revisit if a second consumer
of `TaskEvent` ever needs the same columns.

**Avoid triple-writing.** The draft would have written `TaskEvent` +
`agent_task_events` + `AuditLog` per hand-off. Make `agent_task_events` the only
new write and **project the task timeline at read time**; keep `AuditLog` as the
tamper-evident compliance copy for the meaningful transitions named in Option A.

**Pros:** causation chains are walkable; typed events let the UI render a
delegation tree; survives task deletion; tenant-queryable.
**Cons:** one migration and a read-time projection for the timeline view.

### Option C — Independent evidence pipeline (later, ~1 month+)

Brief §10.2: collect from independent sources (API gateway, tool gateway, egress
proxy, policy decision point), correlate on an OpenTelemetry trace id, and ship to
a store the runtime cannot read. Plus signed evidence-bundle export.

**Pros:** survives a compromised worker; the only option that satisfies "do not
rely on events emitted by the agent framework."
**Cons:** needs OTel instrumentation end-to-end and a second storage boundary. For
a self-hosted single-tenant deployment this is a genuine enterprise requirement but
not a launch blocker.

### Recommendation

**Do A immediately (it is nearly free and closes G6), build B as the backbone of
the feature, and write C into the roadmap with an explicit "not yet" decision** so
it does not silently become a gap.

One addition worth pulling forward from C regardless: **a channel-abuse detector**
(brief §12.5) over the shared namespaces we already have — KB writes, attachment
names, `file_write` paths.

**Structural signals only.** All three reviewers independently flagged that the
first draft's "high-entropy payloads" is a *content-derived* signal and drifts
toward the `AGENTS.md` rule that intent is model-judged, never string-matched.
Entropy is content inspection; if it deterministically blocks or quarantines, it
breaks the rule. The detector is therefore limited to signals requiring no
interpretation of content: **repeated writes to the same key by different runs,
one task's run reading another task's artefacts, write-rate anomalies, and
cross-run key overlap.** It raises an operational alert for human or model
judgement — it never blocks on its own verdict.

---
