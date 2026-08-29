# Chain of command — one org tree for people and agents

**Status:** discovery + design — no code in this change
**Date:** 2026-08-29
**Related:** docs/plans/2026-08-29-approvals-in-chat.md (the card + suspension
machinery this rides), docs/approval-gating-spec.md §9 (which names this work:
"Phase 3+ will add explicit approver assignment, delegation, and escalation"),
docs/plans/2026-08-11-inter-agent-communication/ (governed task bus — the
agents-behave-like-employees premise), docs/plans/2026-08-15-uoa-org-tenancy.md
(identity boundary), docs/plans/2026-07-20-chief-of-staff.md (hard rules this
must not contradict)

## Concept

Agents are **virtual employees**, not infrastructure. A developer runs ten
agents of their own — their direct reports. A CTO has agents they published for
the whole team, plus a few private ones. The organisation is therefore one
tree containing **both kinds of member**: humans and agents, with reporting
lines between them, and that tree is what work follows:

- **Escalation** — an agent (or person) that needs information or a decision
  it cannot make sends the question *up* the chain to the right person.
- **Approval routing** — a request for approval goes to the responsible
  person; if they are on holiday it reroutes to their designated deputy or
  their boss instead of rotting.
- **Coverage** — absence is a first-class state with a window and a stand-in,
  not a silent timeout.

This is not a new direction — it is the corpus's own stated next step.
docs/plans/2026-08-11-inter-agent-communication/ opens with "Nessie's premise
is that agents behave like employees: they take work, hand work to each other,
report back, and leave a trail a human can inspect", and
docs/approval-gating-spec.md §9 ends its role-based v1 resolution with "Phase
3+ will add explicit approver assignment, delegation, and escalation." Nessie
already has most of the *mechanism* this needs (an approvals table with
atomic resolve, user statuses with schedules, task ownership/assignment,
alerts/push, audit, policy — with one honest gap, run suspension, that the
in-flight approvals-in-chat plan closes). What it lacks is the *structure*:
agents have no owner, nobody reports to anybody, and approvals are routed by
visibility, not responsibility. This document designs that structure and
where each piece must live (UOA vs Nessie).

## 1. What exists today (discovery)

Verified against the schema, the services, the migration chain, and the
design-doc corpus (five parallel research sweeps: data model, approvals,
RBAC/policy, delegation/escalation machinery, prior decisions).

### 1.1 Humans — owned by UOA

- `Organization` ↔ UOA organisation 1:1 via `externalOrgId`; `Team` ↔ UOA
  workspace 1:1 (docs/plans/2026-08-15-uoa-org-tenancy.md). UOA is the sole
  authority for identity, profiles, roster, and the *shape* of the org/team
  hierarchy. Nessie persists only the stable UOA subject plus
  product-specific extension data.
- `OrganizationMember` (schema.prisma:1215): `userId`, `role`
  (`owner|admin|member|viewer`), `deactivatedAt` (reversible deactivation,
  enforced at request auth). Roles are flat — there is **no manager
  relationship anywhere**, in Nessie or (as far as Nessie consumes it) in UOA.
- `ProjectMember` exists with its own `role`; teams give containment, not
  reporting.

### 1.2 Agents — owned by Nessie, but nobody owns *an agent*

`Agent` (schema.prisma:1859) has, relevantly:

- **No `ownerUserId` / `createdByUserId` — no user FK of any kind.** "Whose
  agent is this" is not representable. There is no table anywhere that puts a
  person and an agent in the same tree.
- **The Personal Assistant is an org-singleton, not per-user.** One PA agent
  row per organization (partial unique index on
  `agent_kind='personal_assistant' AND system_managed`), bound into every
  user's private DM channel keyed `pa:<orgId>:<userId>`. "Ondrej's assistant"
  is a *runtime projection* — `effectiveUserId` injected when the channel is
  a PA DM — never a row. Any ownership design must treat the PA as excluded,
  not backfillable.
- A DB CHECK locks `(systemManaged, agentKind, surfacePolicy,
  delegationMode)` to exactly three combinations
  (`20260706170500_system_managed_shared_agents`): a user-authored agent is
  forced to `(false, shared, shared, none)`. New agent archetypes mean a
  migration to that CHECK. (Side-finding, flagged separately:
  `external-agent.ts` writes a fourth combination the CHECK does not permit —
  a latent inconsistency to verify outside this design.)
- `parentAgentId` — a self-relation named **`AgentHierarchy`** (SetNull,
  unindexed). Set in exactly two places: `spawn_subtask` (which mints
  **permanent** Agent rows for ephemeral one-run child workers — the roster
  grows forever) and explicit API create/PUT. One level deep by policy
  (`spawn_subtask` refused when `parentAgentId` is set); clones drop it. It
  is a *delegation lineage*, not a reporting line, and any org chart drawn
  from it would be polluted by spawned workers.
- `projectId`/`teamId` are near-dead: bare UUID columns, no FK, no index,
  written from ambient tenant context, read only for trigger-origin
  attribution. **Untrusted until backfilled + FK'd** — nothing should route
  on them.
- Visibility is **entitlement through channels**: `listAgentsForUser`
  (packages/workspace-admin/src/agent-list.ts) — owner sees every non-system
  agent incl. unbound; everyone else sees an agent only through a channel
  they can reach. The brand-new Agents page scope tabs (commit `f8828f3f`,
  2026-08-29) *derive* Personal/Team/Global from
  `agentKind`/`systemManaged` — deliberately not a stored column, and "Team"
  does not consult `Agent.teamId`.

So "personal vs shared" today is really *surface* (DM-only vs channel-bound)
plus the PA special case — not ownership. Every agent read funnels through
the channel predicate; a hierarchy read ("who reports to me") would be the
first non-channel-derived agent visibility rule in the codebase.

### 1.3 Approvals

- `ApprovalRequest` (schema.prisma:3513): `agentId`, `requesterId`, `action`,
  `reason`, `context`, `status` (`pending|approved|rejected|expired`),
  `resolverId`, **`requiredApproverRole`** (the only routing mechanism:
  resolver's *live* `OrganizationMember.role` must equal it —
  api/src/services/approvals.ts:188), `continuationToken`, `expiresAt`
  (default 30 min, hardcoded). Resolution already enforces: visibility gate,
  **no self-approval**, live-role recheck, atomic claim (first resolver
  wins), effect-after-claim. But three sober facts bound what "exists":
  - **The suspend half is not built.** `waiting_approval` is a `RunStatus`
    written by *nothing*: the worker's tool gate turns `approval_required`
    into a denied tool result and the model carries on
    (`tool-authorization.ts:140-166`); `continuationToken` is minted and
    never consumed; `approvalProof` is set by nothing. The enterprise
    roadmap names this (item 8): "the gate denies and the agent barrels on;
    the resolve-half machinery is correct but orphaned." The approvals-in-
    chat plan's phase 3 is where suspend/resume actually lands — **this
    design's approval routing is sequenced behind it** (the buzz comparison
    records exactly this trap: approval UI shipped before the executor
    could suspend/resume, so gated runs just fail).
  - `requiredApproverRole` is a **dangling hook**: its writer
    (`createApprovalRequest`) has zero production callers — the one live
    approval creator (`kb_publish_request` in
    `worker/src/run/pa-tools/knowledge-write.ts`) inserts directly, sets no
    role, and doesn't suspend either.
  - The effective approver set is **owners ∪ members of the approval's
    channel** (the visibility gate doubles as the authorization gate), minus
    the requester. Nobody is *notified* — approvals appear only if someone
    opens the (soon to be deleted) `/approvals` page. "Routing" today is
    visibility, not responsibility.
- One genuine named-single-human precedent exists: `ExecutorContinuation` —
  an approval-shaped record naming exactly one required person
  (`actorUserId`), with expiry, a confirmation token, and fresh re-auth.
  `approverUserId` (§4.1) generalises that shape onto `ApprovalRequest`.
- The **approvals-in-chat plan** (docs/plans/2026-08-29-approvals-in-chat.md,
  merged decisions) moves all approvals into chat cards, removes the
  `/approvals` page, adds `ownerId` (consent-to-disclose), humane timeouts
  (expiry → polite non-answer), withdraw, snooze, and a standalone card view
  reachable from the alert for approvers who aren't channel members. **This
  design builds directly on that plan** — routing decides *who* gets the card
  and the alert; the card itself is that plan's component.
- Two routing models therefore already coexist and must be reconciled here:
  docs/approval-gating-spec.md §2/§9's **role-based** resolution (org owners /
  scope admins, requester never self-approves, TTL default 1h, expiry
  auto-rejects with `APPROVAL_EXPIRED`) and approvals-in-chat's **structural
  owner-id** class (`disclose_information`, explicitly "independent of
  `requiredApproverRole`"). §4.1 below states the reconciliation.
- **Human work distribution already exists** (docs/corporate-usability-
  assessment.md, resolved 2026-05-30): `Task.ownerUserId` + `Task.assigneeUserId`,
  assign/hand-off/route-to-approver flows on `/api/tasks`, and the admin
  **Work** page. Tasks can already be routed to a named human — approvals and
  escalation are the parts still routed only by role.

### 1.4 Availability already half-exists

`UserStatus` / `UserStatusSchedule` / `UserStatusRule`
(schema.prisma:1610–1674): per-user statuses ("On holiday 🏖️") with
**date-range and weekly schedules** (timezone-aware) and per-scope
agent-facing instructions (`agentEnabled`, `instructions`, priority, scoped
by channel/project/agent). This is a real coverage-window substrate — a
`date_range` schedule with `agentInstructions` *is* "I'm on holiday, my
agent covers for me" in all but name. But it is currently **data-only**:
docs/functionality.md records "contact-rule dispatch not wired — inbound
message dispatch does not yet evaluate them", and nothing anywhere queries
`UserStatus` to decide routing. What it lacks for this design: (a) a
machine-readable **availability semantic** (a status is only a freeform
label — code cannot know "holiday" means "don't route approvals here", and
string-matching the label is forbidden by the model-judged rule, so it must
be a structural flag), (b) a **deputy**, and (c) its first consumer — which
§4 makes the approval router. (`UserPresence` is the other candidate and is
wrong: minutes-scale liveness for avatar badges, not days-scale absence.)

### 1.5 Movement machinery (reused, not rebuilt)

- `delegate` builtin: bounded ephemeral sub-agent fan-out within a run;
  `spawn_subtask`: durable one-level child agents. Neither can ask a human
  anything — **no `ask_human`/`request_approval` builtin exists**; the only
  agent-raises-a-question path is `kb_publish_request`, and it doesn't wait.
- Engagement orchestrator: model-judged reply/acknowledge/decline, with one
  load-bearing structural invariant — **only human messages engage agents**
  (`orchestrator.ts`: `if (!input.triggerIsHuman) return []`). This is the
  anti-cascade guard; escalation must deliver to *people* (alerts, DMs) and
  never depend on an agent-authored message waking another agent.
- `AgentMailboxMessage`: a durable, idempotent, backoff-retrying agent inbox
  with a per-message `visibleAt` timer — well built and currently
  **unreachable from agent runs** (only the owner-gated `POST /api/mailbox`
  and workflow steps write it), with no reply path. Noted as future fabric;
  this design does not depend on it.
- `UserAlert` + bell + web push: durable, deduped (`eventKey`), muting
  suppresses push never the row; the model comment invites new kinds, and
  `approval_requested` arrives with the approvals-in-chat work.
  `attention.dispatch` is the working template for kind-specific push with
  liveness re-checks. One catch: non-interactive runs never fire the
  targeted reply push, so escalations must alert explicitly, not rely on
  reply notification.
- `AgentTrigger` (interval/scheduled) + `schedule_task` + queue: the timer
  fabric escalation timeouts and reroute sweeps can ride (the worker already
  runs 5–30 s sweep loops to add one more to).
- `AuditLog`: hash-chained, org-scoped, single write chokepoint
  (`writeAuditEntry`). Caveat: the convenience emitter (`emitAuditEvent`)
  swallows errors by design — routing decisions that must be *provable*
  write through `writeAuditEntry` inside the mutation transaction. The
  closed `AuditActionSchema` has no hierarchy vocabulary yet
  (`escalation.*`, `coverage.*`, `approval.rerouted` are new enum values).
- PolicyRule/PolicyBinding + `checkPolicy` (deny-overrides, one shared
  evaluator in `packages/workspace-admin/src/policy-check.ts`): resource/
  action gates. Two engine facts shape this design: **a deny is
  unoverridable** (first matching deny in scope order wins — "manager may do
  X despite a deny" is inexpressible and stays that way), and `actor.roles`
  is a single live org-membership role per request, so "is a manager of X"
  is resolved as *data* by the chain resolver, never injected as a role.
  `PolicyScope`/`PolicyBinding.actorType` are extensible by design if later
  phases want hierarchy-targeted rules; not needed for v1.

## 2. Design — the org tree

### 2.1 One tree, two node types, one new fact each

The tree is: **humans report to humans** (management chain), **agents report
to a principal** (their owner by default). Concretely, two data additions:

**(a) Agent ownership — `Agent.ownerUserId String? @db.Uuid` (SetNull).**

- Set at creation to the creator, for every non-system agent, via
  `createAgentRecord` in `@nessie/workspace-admin` (one chokepoint — API
  route, PA `agent_create`, Agent Designer all flow through it already).
- Transferable (owner/admin action, audited). Nullable because legacy agents
  and org-utility agents can be unowned; unowned agents appear in an
  "Unassigned" pool on the org chart so backfill is a visible task, not a
  migration guess.
- **The PA is excluded, not backfilled.** It is one org-singleton row serving
  every user through per-user DM keys, so an `ownerUserId` on it would be a
  lie. The org chart renders "your assistant" under each person as a
  *projection* of their PA DM — same trick the runtime already uses
  (`effectiveUserId`), no schema change. Spawned subtask children
  (`parentAgentId` set) are likewise excluded from the chart — they are run
  workers, not employees.
- **Ownership is management, not visibility.** The existing scope work keeps
  answering "who can *see/use* this agent" (bindings + entitlement +
  `surfacePolicy`); `ownerUserId` answers "who is *responsible* for it, whose
  report is it, where do its escalations start". Publishing an agent to the
  team (binding it into shared channels) does not change its owner.

**(b) Human reporting line — `managerUserId` per member.**

New nullable column on `OrganizationMember`: `managerUserId String? @db.Uuid`
(FK to `users`, SetNull), plus a guard against self-reference and a
service-level cycle check on write (walk-up with a visited set — org sizes
make this trivial). Roots (no manager) are typically the owner(s). This is
safe against UOA re-projection by construction: membership upserts are
create-only and role changes flow through `projectUoaRoles`, which touches
only `role` — a local extension column on the same row survives every
login/refresh/switch untouched.

Why on `OrganizationMember` and not a new edge table: the relationship is
per-organisation (the same human can report to different people in different
orgs), exactly one manager per member (a tree, not a DAG — deliberately; a
matrix org is out of scope, flagged in §7), and the row already carries the
org-scoped lifecycle (`deactivatedAt`) the routing logic must consult.

**Agent→agent reporting is out of phase 1.** `parentAgentId` already exists
with lineage semantics (clones/subtask children); overloading it with
reporting-line meaning would silently change what the existing
hierarchy/status reads render. If "team-lead agents" (an agent whose reports
are other agents) prove wanted, add a *distinct* `reportsToAgentId` then,
with the invariant that every chain still tops out at a human. For now: an
agent's superior is its owner (or, unowned, the team's fallback below).

### 2.2 Resolving "up the chain" — one shared resolver

One function in `@nessie/workspace-admin` (shared API/worker, like
`listAgentsForUser`), the **only** place chain-walking logic lives:

```
resolveChain(principal) →
  agent   : owner (ownerUserId) | else fallback: org admins/owners
  human   : managerUserId → … → root (org owners as implicit final root)
```

Rules:

- Skips **structurally unavailable** people: `deactivatedAt` set, or an
  active away-window (§4). Bounded depth (visited set), deterministic order.
- **Fallback** for unowned agents: nothing new — org admins/owners resolved
  by existing role data. Deliberately *not* keyed on `Agent.teamId`, which
  is a bare untrusted column today (§1.2); if a team-shaped fallback is
  wanted later it comes from the agent's bound channels' teams, which are
  real FKs. No new "team lead" concept until someone asks for one.
- The resolver returns *structural facts only* (an ordered list of candidate
  people + why each was included/skipped). Choosing whether/whom to actually
  contact is either deterministic (approval routing, §4) or model-judged
  within that candidate set (escalation, §3) — never a keyword decision.

### 2.3 Personal vs published agents, restated on top of ownership

| | personal | published (team-shared) |
|---|---|---|
| `ownerUserId` | the person | still the person (or transferred to a lead) |
| visibility | existing entitlement: DM / channels the owner binds | existing entitlement: shared channel bindings |
| org chart | under the owner, "private" badge for non-owner viewers (existence only where the viewer's entitlement already reveals it) | under the owner, marked shared, listing where it serves |
| escalation start | owner | owner |

No new visibility machinery: **the org chart must render only agents the
viewer could already see via `listAgentsForUser`** (rule 2 — entitlement,
never ambient context). A member's private agents simply don't appear in a
colleague's view of the chart; the *human* tree is fully visible to all
active members (an org chart you can't see your boss on is useless — flagged
in §7 in case org policy wants this gated to `member`+ vs `viewer`).

### 2.4 Where UOA must own it vs where Nessie can

- **UOA owns**: humans, profiles, roles, membership lifecycle, and the org →
  team *shape*. Nothing here duplicates any of that; all new columns key on
  ids Nessie already legitimately holds.
- **The human manager edge is the boundary case.** By the letter of the
  identity invariant ("UOA owns the org structure, not just the people in
  it") a human↔human reporting line is org structure, and if UOA ever grows a
  manager/`reports_to` attribute, Nessie's copy becomes exactly the forbidden
  duplicate. Recommendation: treat `managerUserId` as **Nessie-operational
  chain of command** (who unblocks approvals *in this product*), explicitly
  documented as such — *and raise the question with UOA before building
  phase 2*. If UOA takes it, Nessie mirrors it read-only through the roster
  API exactly as the org name is mirrored today, and the column becomes the
  bounded cache. The design keeps that migration to one column + one
  read-path swap. **This is the top open question (§7.1) — do not start
  phase 2 until it is decided.**
- **Nessie owns outright**: agents, agent ownership, coverage windows,
  deputies, approval routing, escalation, and their audit. None of that is
  identity.

### 2.5 Surfaces (rule zero — named now, shipped with their phases)

- **Owning surface**: an **Org chart** page (people tree with each person's
  agents nested under them; unassigned-agents pool for owners). Likely home:
  the existing members/directory area rather than a new top-level item.
- **In-context doorways**: (1) member directory row → "Reports to X · manages
  N people, M agents"; (2) Agent Designer + agent page header → owner, with
  owner/admin transfer control; (3) the approval card (approvals-in-chat
  component) → a routing line: "Sent to Priya (Marek is away until Mon —
  deputy)"; (4) `/settings` → "Availability & coverage" (extends the existing
  statuses UI) where a person sets away windows and their deputy.
- **A hard boundary from a written decision**: the Chief-of-Staff spec's
  rule 3 forbids manager-visible individual performance analytics. The org
  chart shows **structure** (who reports to whom, who owns which agents,
  who's away, who's covering) and never per-report workload, speed, or
  activity metrics. Any future "team load" view must confront that decision
  explicitly, not slide in through this surface.

## 3. Escalation — questions and decisions travel up

### 3.1 Shape

"Escalation" already means three unrelated things in the corpus — the legacy
review-failure threshold (3 strikes → `awaiting_approval`), privilege
escalation in security docs, and the watcher's quarantine controls. This
design means a fourth, and says so: **routing a question or decision up the
reporting chain to a person.**

Escalation is **a question delivered to the right person, plus an alert** —
not a new work-object. Delivery is structural and human-facing, which keeps
the orchestrator's only-humans-engage-agents invariant untouched: the
escalation lands as a `UserAlert` (new kind `escalation_raised`, pushed via
the `attention.dispatch` template) whose card opens a focused view — the
same standalone-card mount the approvals-in-chat plan already requires for
non-member approvers — plus a visible line in the originating thread ("I've
asked Marek about X"). The target answers where the question lives; for
information escalations the answer returns as a normal human reply that
re-engages the agent through the ordinary conversational loop. A shared
agent deliberately gets **no** general message-a-person power out of this
(that stays PA-only, `send_message`); the escalation card is the doorway.
Two flavours:

- **Information escalation**: "I need to know X to proceed." The run either
  ends its turn having asked (the reply triggers a follow-up run — the
  normal conversational loop), or for scheduled/unattended work simply posts
  the question up-chain and reports "escalated to \<person\>" in its own
  thread status line.
- **Decision escalation**: "May I do X?" — this **is** an `ApprovalRequest`
  (§4). One machinery, not two: an agent escalating a decision raises an
  approval whose approver is resolved by the chain.

### 3.2 Choosing the target — structural candidates, model judgement

Per the model-judged rule, code never decides *whether* something warrants
escalation from message content. The split:

- **Structural**: the worker computes the allowed target set via
  `resolveChain` (owner → their manager → …, deputies substituted for away
  people) and injects it into the run's prompt as facts ("your owner is
  Marek; Marek is away until Mon 1 Sep, his deputy is Priya; Marek's manager
  is Jana"). A new builtin `escalate` takes `{ targetUserId, question,
  urgency? }`; the worker **validates targetUserId ∈ allowed set** and
  refuses in words otherwise. Default target = first available person in the
  chain; skipping levels is allowed only within the returned set (the set
  includes the chain, not the whole org).
- **Model-judged**: whether to escalate at all, which candidate fits the
  question, and the wording — in any language, no keywords.

### 3.3 Guardrails

- **Never a rights-widener**: escalation delivers a question; it grants
  nothing. Whatever the recipient then does is gated by their own
  role/policy as always (deny-overrides untouched).
- **Anti-nag / loops**: per (agent, target) cooldown; escalation depth cap
  per originating run; a decline visible in the transcript short-circuits
  re-asks (same anti-nag stance as the disclosure plan). Cycles are
  impossible by construction (tree + visited set).
- **Disclosure composition**: escalating must not leak private context — the
  escalation message is subject to the same consent-to-disclose judgement as
  any other agent output; the chain never bypasses it. Consent requests
  themselves are **never rerouted or escalated** — only the information's
  owner can consent (carve-out stated in §4.3).
- Every escalation writes `AuditLog` + a `TaskEvent`
  (`run.escalated { targetUserId, reason-class }`).

## 4. Approval routing + coverage — holiday-proof approvals

### 4.1 Route to a person, not only a role

Additive columns on `ApprovalRequest` (composing with the approvals-in-chat
migration, not competing with it):

- `approverUserId String?` — the person this request is currently waiting
  on. Complements the existing mechanisms rather than replacing them:
  `requiredApproverRole` stays as a *qualification* check (the resolved
  person must still satisfy it — and this design finally gives that dangling
  hook its writer), and disclosure `ownerId` stays absolute. One caveat from
  the role audit: `admin`/`viewer` are stored but semantically inert today
  (only `canManageChannel` honours `admin`), so role qualifications should
  be written in terms of `owner`/`member` until the admin tier means
  something.
- `routing Json?` — the routing trail: ordered hops
  `[{ userId, reason: 'chain'|'deputy'|'away_skip'|'timeout_escalation'|'deactivated_skip', at }]`.
  Renders the card's routing line and makes reroutes auditable; the same
  facts go to `AuditLog`.

Resolution at raise time (deterministic, in the shared resolver):

1. Determine the *responsible person*: for an agent-raised approval, the
   agent's owner; walk up if the action's `requiredApproverRole` demands a
   role the owner lacks (e.g. an org-level action a member can't approve).
2. Availability check (§4.2): away or deactivated → active deputy for that
   window if one is set and qualified, else the person's manager, walking up
   and skipping unavailable people; final fallback org owners.
3. Stamp `approverUserId`, write the trail, create the alert/card for that
   person (the approvals-in-chat standalone card view already covers
   approvers who aren't in the channel).

### 4.2 Coverage windows — extend `UserStatus`, add the deputy

Reuse the existing substrate instead of a parallel absence system:

- `UserStatus.availability` enum `available | away` (default `available`) —
  the machine-readable semantic a label can't carry. The statuses UI gains
  one toggle: "While this status is active, I'm away (route my approvals to
  my deputy)". Active window = existing `UserStatusSchedule` mechanics
  (one-off ranges *and* recurring weekly ones — evenings/weekends coverage
  falls out for free).
- New small table `CoverageDelegation`: `{ organizationId, userId,
  deputyUserId, startsAt?, endsAt?, note?, createdAt }` — who stands in when
  I'm away. Windowless row = standing deputy. Kept separate from
  `UserStatus` because a deputy outlives any one status, needs its own audit
  trail, and (open question §7.4) may need an acceptance step. Guards:
  deputy ≠ self, deputy must be an active member, no chains of deputies
  (a deputy's own away-ness falls through to the *delegator's manager*, not
  to the deputy's deputy — one hop keeps reasoning and audit sane).

### 4.3 Behaviour over time

- **Raise while away** → routed per §4.1; the card's routing line says so in
  neutral copy ("Marek is away — sent to Priya"). The away person still gets
  a low-priority durable alert (they can see what was decided for them —
  push suppressed, row kept, consistent with the mute contract).
- **Goes away mid-pending** → a sweep (existing trigger/queue fabric)
  re-resolves pending requests whose approver just became unavailable and
  reroutes, appending to the trail and re-alerting.
- **Timeout escalation** — the humane-timeout refinement: before the
  approvals-in-chat expiry fires its polite non-answer, a pending request at
  T/2 (tunable) escalates one hop up the chain (`timeout_escalation`),
  re-alerting there. Final expiry keeps the existing behaviour. At most N=2
  hops so approvals cannot ping-pong across a whole org.
- **Carve-out**: `disclose_information` consent **never reroutes** — privacy
  consent is personal; absence means the existing expiry path, full stop.
- **Leavers**: deactivation already stops sync/triggers; add to the same
  gate: reroute their pending approvals (as above) and surface their owned
  agents in the unassigned pool for reassignment (suggested default: their
  manager). No silent auto-transfer of agents — an owner action, one click,
  audited.

## 5. New vs reused

| Need | New | Reused |
|---|---|---|
| Agent ownership | `Agent.ownerUserId` (PA excluded — projection; unassigned pool) | creation chokepoint `createAgentRecord`; entitlement scoping unchanged |
| Human reporting line | `OrganizationMember.managerUserId` (pending UOA decision §7.1) | UOA roster/roles/lifecycle; org name-mirror precedent |
| Chain resolver | one function in `@nessie/workspace-admin` | the shared-package pattern (`listAgentsForUser` precedent) |
| Org chart | one page + 4 doorways (§2.5) | member directory, Agent Designer, TabBar, avatar components |
| Escalation | `escalate` builtin + validation | messages, reply threads, `UserAlert`+push, orchestrator, TaskEvent, AuditLog |
| Approval routing | `ApprovalRequest.approverUserId` + `routing` | `ApprovalRequest`, `waiting_approval`/continuation, approvals-in-chat card + standalone view, `requiredApproverRole` as qualification |
| Coverage windows | `UserStatus.availability` flag | `UserStatus` + `UserStatusSchedule` (dates, recurrence, timezones) |
| Deputies | `CoverageDelegation` table | alerts, audit |
| Reroute sweeps / timeout hops | sweep job + T/2 hop | queue `visible_at` timers, expiry machinery |

Explicitly **not** built: a second visibility system (bindings/entitlement
stay), a new approvals table or card, a parallel absence system, agent→agent
reporting (deferred), any UOA-owned data copied locally beyond the flagged
manager edge.

## 6. Phased path

0. **Decide §7.1 with UOA** (manager edge ownership) — blocks phase 2 only.
1. **Agent ownership**: column, chokepoint write, PA-exclusion projection,
   transfer action + audit, owner shown in Agent Designer/agent page,
   unassigned pool listing. (Independent of UOA; immediately useful — "whose agent is this"
   is answerable at last.)
2. **Reporting lines + org chart**: `managerUserId` (or UOA mirror), cycle
   guard, chart page + doorways, entitlement-scoped agent nesting.
3. **Escalation**: `resolveChain`, prompt facts, `escalate` builtin +
   validation + guardrails, TaskEvent/audit, status-line copy for unattended
   runs.
4. **Approval routing + coverage**: `approverUserId` + trail,
   `availability` flag + statuses-UI toggle, `CoverageDelegation` + settings
   surface, raise-time resolution, mid-pending reroute sweep, T/2 timeout
   hop, leaver handling. **Hard dependency:** the approvals-in-chat build —
   specifically its phase 3, which is what finally makes `waiting_approval`
   suspension + continuation-token resume real. Routing requests nobody can
   suspend on is the buzz failure mode (approval UI before the executor
   could suspend/resume); do not start phase 4 before that lands.
5. **Later / on demand**: agent→agent reporting (`reportsToAgentId`,
   human-topped invariant), matrix/second-manager, team-lead concept,
   escalation analytics on `/ops/usage`.

Each phase lands with its surface (rule zero), docs updated in the same
turn, additive migrations only.

## 7. Open questions (flagged, not guessed)

1. **Does UOA take the human manager edge?** (§2.4). If yes: roster API
   extension + read-only mirror; if no: Nessie-operational column with the
   written decision recorded here. Blocks phase 2.
2. **Spawned-worker roster growth** — `spawn_subtask` mints permanent Agent
   rows per delegation (no reaping). The org chart excludes them
   (`parentAgentId` set), but should they be reaped/archived so `/agents`
   and the roster stay honest? Adjacent cleanup, not a blocker.
3. **Org-chart visibility floor** — full human tree for every active member,
   or gated for `viewer` role? Default proposed: visible to `member`+,
   `viewer` sees only their own chain.
4. **Deputy acceptance** — does a deputy have to accept the designation
   (alert + accept), or is designation unilateral? Proposed: unilateral +
   informational alert, revisit if abused.
5. **Multiple org owners as root** — chain walks ending at "org owners"
   (plural): alert all, or eldest/first? Proposed: all owners alerted, first
   resolve wins (existing approval resolve semantics).
6. **Should `requiredApproverRole` ever override the chain entirely** (e.g.
   compliance actions that must reach an `owner` regardless of chain)?
   Proposed: yes — role remains a hard qualification the walk must satisfy.
7. **Escalation for humans** — phase 3 gives agents the tool; do humans get
   a UI affordance ("escalate this thread to my manager") in the same phase
   or later? Proposed: later, once the agent path proves the routing.
8. **Richer escalation semantics later?** The buzz study's strongest
   agent-to-agent finding (216-episode experiment) was decline /
   counter-offer / conditions-of-satisfaction instead of accept-only
   delegation. The `escalate` builtin's answer path is free-form human
   reply, so this costs nothing now — but if escalation ever goes
   agent→agent (phase 5's `reportsToAgentId`), that vocabulary is the prior
   art to adopt.
9. **Discovered in passing, tracked separately** (not this design's scope):
   `external-agent.ts` writes an agent-archetype combination the
   `agents_system_managed_invariants_chk` DB CHECK does not permit, and an
   `extagent:` dmKey shape the PA-channel CHECK appears to forbid — a latent
   inconsistency to verify and fix on its own branch.
