# Part 5 — Proposed plan

Sequenced so each phase is independently shippable **with its surface**, per Rule
zero. Phases 0–2 are the ones I would commit to now; 3–4 are scoped but deliberately
deferred.

## Phase 0 — Close the live boundary (≈1 week)

No new architecture. Fix the hole that exists and make what exists honest. This
phase is a **precondition** for Phase 1, not a nice-to-have: every item here is
the enforcement seam Phase 1 would otherwise inherit broken.

1. **Route `delegate`'s inner calls through the real boundary (G11).** Inner
   builtin and MCP calls take the same authorization, approval,
   `ToolCall` telemetry, and cancellation path as a main-agent call. Concretely:
   `executeGuardedBuiltin` calls `evaluateToolInvokePolicy`, and `delegate`'s
   `onToolCallStart`/`onToolCallEnd` stop being no-ops. This closes an active
   privilege *and* observability bypass and creates the seam mailbox delegation
   reuses.
2. **Attribute peer content write-side (G2).** Stamp the delivered `Message` with
   the sending agent's identity and provenance metadata so the existing
   `prompt.ts` foreign-agent labelling, the admin feed, and the engagement
   orchestrator all inherit it from the row. Make the `promptOverride` path and
   `triggerIsHuman` consistent with the row. **Do not** build a parallel
   prompt-side untrusted-block mechanism.
3. **Audit the meaningful mailbox transitions (G6).** Option A: send / accepted /
   completed / failed, with `pended` distinguished from `delivered` (G17).
4. **Validate sender and recipient atomically (G4).** One exact-organization
   check covering `fromAgentId` and `toAgentId`, with an explicit rule for
   global/system agents. Never trust the request body.
5. **Surface it (G5).** Extend the existing Agents → Activity surface
   (`RunLifecyclePanel`) with the hand-off view; do **not** name a parallel
   "Agent activity" page. The hand-off row is **one component parameterised by
   scope**, reused by the agent view and the task timeline.
6. **Fail-safe contract (G10).** Uniform `AUTHORIZATION_REQUIRED` /
   `CAPABILITY_UNAVAILABLE` reason codes across builtin failures, plus the
   no-circumvention statement in the system prompt: a denial is final.

**Ships:** the delegate bypass closed, honest attribution, a tamper-evident
inter-agent trail, and the first human-visible view of agent-to-agent traffic.

## Phase 1 — Give agents the mailbox (≈2–3 weeks)

7. **A minimal grant, before the capability that needs it.** Not the full
   Phase-2 object — just: task, issuer, sender, recipient, intersected tool IDs,
   budget, expiry, parent grant, status. Shipping `delegate_task` with no grant
   at all creates the unsafe channel Phase 2 would then have to repair.
8. **`delegate_task` builtin.** Addresses a **bound agent within the caller's
   reachable scope**; capability addressing waits for Phase 2. Note that
   dispatch dead-letters without an `AgentBinding`, so a recipient resolves to an
   **(agent, channel) pair**, not an agent. Writes through one service seam
   shared with the workflow engine (no fork). Carries `purpose`, bounded input,
   and an expiry that the dispatcher **enforces** (G20).
9. **`report_back` write path (G12).** An explicit write on run completion
   routing the result to the requester on the `correlationId` — not an assumption
   that it happens.
10. **Loop and depth bounds (G14).** A hop count / TTL on the correlation chain,
    not just per-task fan-out caps, because auto-continuation compounds cycles.
    **Keep delegation depth at 1 through Phase 1.** Raising it to 3 before
    attenuation exists means three hops each *copying* authority — strictly worse
    than today. Depth rises only when child grants are provably narrower.
11. **Per-tree budget accounting (G15).** Child runs charge against the root's
    caps. Without this, fan-out × depth multiplies spend with only the org
    `Budget` as a backstop.
12. **Recipient consent (G13).** A per-agent or binding-level policy for who may
    delegate to whom. Delivery currently bypasses the engagement judgement
    entirely, so without this any sender can force a run on any bound agent.
13. **Reap `spawn_subtask` agents (G8)** — or better, re-point `spawn_subtask` at
    the mailbox so delegation stops minting permanent `Agent` rows.

**Ships:** the actual capability. An agent can hand work to a colleague and get an
answer, visibly, within enforced limits, and without unbounded cycles.

## Phase 2 — Full TaskGrant + typed events (≈3–4 weeks)

14. **Grow the Phase-1 grant into `TaskGrant`.** Add what a caller actually
    needs: purpose, allowed tools, allowed recipients, expiry, delegation
    depth/fan-out, budgets, revocation version. **Deliberately excluded:**
    resource-selector DSLs and classification ceilings — brief §6.1 vocabulary
    with no consumer in Nessie. Add them when something reads them.
15. **Attenuation enforcement.** A child grant that widens *anything* is rejected
    at issue time, with a test that asserts it. Depth may now rise above 1.
16. **`agent_task_events`** (Option B, slimmed) as the backbone, with the
    delegation-tree and grant-history UI on the task screen — reusing the same
    parameterised hand-off component as Phase 0 item 5.
17. **Grant-aware tool authorization** — `authorizeToolCall` consults the active
    grant, not only the static `Agent.toolPolicy`.
18. **Tree cancellation and revocation propagation (G16).** Cancelling a parent
    cancels mailbox-spawned descendants; revoking a grant voids its queued mail.
    Define and test revocation-to-stop latency.
19. **Capability addressing**, if Open Decision 3 lands that way — resolving to
    an (agent, channel) pair.

**Ships:** authority bounded per task rather than per agent, an inter-agent audit
you can walk, and delegation trees that stop when told to.

## Phase 3 — Hardening (deferred, scoped)

20. Parameter-bound approvals (normalized-action hash on `ApprovalRequest`).
21. Channel-abuse detection over KB / attachments / file roots — **structural
    signals only**, alerting rather than blocking (see Part 4). Needs a named
    owning surface and doorway before it is built.
22. Postgres RLS as defence-in-depth (G7) — its own project; must not break the
    worker's deliberately global pollers.
23. `TaskEvent` immutability enforced in the database rather than by convention.

## Phase 4 — External agents (deferred)

24. A2A behind a curated gateway; signed Agent Cards; cross-domain policy.
    Explicitly **not** now.

## Deliberately deferred, recorded so it does not become a silent gap

Beyond the brief's own SPIFFE/mTLS/OPA/NATS recommendations (Part 3.3), review
identified further premature generality now cut from Phases 0–2:

| Deferred | Why | Revisit when |
|---|---|---|
| Swappable `AgentEventTransport` interface | One service/repository until a second transport exists | A second transport is actually needed |
| Capability registry (`agent_capabilities`) | Direct (agent, channel) addressing covers Phase 1 | Phase 2, per Open Decision 3 |
| Data classification ceilings | Nessie has no classification system to have a ceiling *of* | A classification system exists |
| Resource-selector DSL | No consumer; grant tool-ID intersection suffices | A resource server needs one |
| Gap-free per-task sequencing | Needs write serialization the plan rejects | Never, most likely |
| Payload content hashing | Redundant with the `AuditLog` chain in the same DB | Audit moves to a separate trust boundary (Option C) |

---
