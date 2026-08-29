# People and their agents

**Status:** design — approved direction, not yet started
**Date:** 2026-08-29
**Supersedes:** [docs/done/2026-08-29-org-chain-of-command-superseded.md](../done/2026-08-29-org-chain-of-command-superseded.md)
(the rejected "chain of command" plan and its invented manager edge)
**Reviewed:** Codex Sol + kimix (design review of the superseded plan, both
blocking); a five-way code-grounding sweep and adversarial synthesis for this one
**Related:** [2026-08-15-uoa-org-tenancy.md](2026-08-15-uoa-org-tenancy.md)
(the authority split), [2026-08-29-approvals-in-chat.md](2026-08-29-approvals-in-chat.md)
(itself superseded in approach; the disclosure system is the real substrate),
[2026-07-20-chief-of-staff.md](2026-07-20-chief-of-staff.md) (hard rule 3: no
manager-visible individual analytics)

## The idea

Agents are **virtual employees**. A developer runs ten agents of their own; a
CTO has some published for the team and some kept private. So the screen a
person wants is their organisation rendered as **people, each with the agents
they own** — Marek and his six, Priya and her three, the four nobody owns.

That is the whole feature. It is deliberately *not* a chain of command.

## The one idea that makes this safe

> **The tree is a JOIN computed at read time, not a hierarchy stored anywhere.**

People, their names, their roles, their teams and their lifecycle come from UOA,
live, on every read. The only thing Nessie stores is **which person is
responsible for which agent** — a fact about a Nessie object, which UOA neither
has nor wants.

This is what dissolves the problem that killed the previous plan. There is no
second org hierarchy because there is no stored hierarchy at all: no membership
table gains a column, nothing local can drift from UOA, and a person removed
upstream simply stops appearing on the next read. The identity invariant
(`docs/brief.md` → "Current SSO identity invariant") is satisfied structurally
rather than by promising to keep a mirror fresh.

### What was rejected, and why it matters

The superseded plan added `OrganizationMember.managerUserId` and called it
"Nessie-operational chain of command". Both reviewers independently rejected it,
and the product owner rejected the framing outright. The argument that settles
it, from Sol:

> Moving the same manager fact to a separate table does not cure the authority
> violation; changing its semantics does.

A manager edge is org structure not because of where it is stored but because of
what it *does* — it decides who holds approval authority and who receives
escalations, and it would keep routing work after UOA changed or revoked the
real relationship. And there is nothing upstream to mirror: the UOA roster
contract carries `{uoaSub, displayName, email, teamRole, orgRole, status}` and
**no manager, deputy, or title field anywhere**
(`packages/schemas/src/uoa-roster.ts:11-22`).

Where the old plan needed a chain, this one uses **real edges that already
exist**: agent ownership, channel/team/org management rights, and org owners.

## What exists today

Verified against `main`; every claim below was checked in code.

**Structure comes from UOA and is already 1:1.** One UOA organisation is one
`Organization` (`externalOrgId`, unique); one UOA workspace is one `Project` +
`Team` + `#general`, created together (`api/src/services/workspace-target.ts:71-103`).
A `Team` row exists only for a workspace somebody has actually entered — nothing
pre-materialises the rest, so **local `Team` rows under-report the org by
construction**.

**Local membership rows are a projection, not an authority.** All four
membership tables are written create-only (`update: {}`,
`api/src/services/workspace-principal.ts:125-175`); role changes come from
exactly one place, `projectUoaRoles`, re-applied on every login, refresh and
team switch (`api/src/services/uoa-roles.ts:170-199`). An unrecognised UOA role
**refuses the login** rather than downgrading, so `viewer` is unreachable over
SSO and means exactly what `member` means.

**The live roster is the real people list.** `listWorkspaceMembers` makes two
UOA calls and stores nothing (`packages/workspace-admin/src/uoa-org-roster.ts:293-320`).
It is keyed off **team** membership, using the org list only as an identity
lookup — so a person in the org but not in this team **does not appear at all**.
That single fact drives the bucket design in §"The tree".

**Agents have no owner.** `Agent` has no user FK of any kind. Consequences that
shape the design:

- The **Personal Assistant is one row per organisation** shared by everyone,
  associated to a person only through the DM key `pa:{orgId}:{userId}` and
  `effectiveUserId` at runtime. An `ownerUserId` on it would be a lie.
- **`spawn_subtask` mints permanent `Agent` rows** (`worker/src/run/subtask-tools.ts:86-106`)
  with `parentAgentId` set, and **nothing reaps them** — there is no delete
  route, no `archivedAt`, no sweep.
- A **DB CHECK** locks `(systemManaged, agentKind, surfacePolicy, delegationMode)`
  to three combinations; user-authored agents are forced to
  `(false, shared, shared, none)`.
- Visibility is entitlement through channels (`listAgentsForUser`), and the new
  Agents page derives Personal/Team/Global from `agentKind`/`systemManaged`
  rather than storing a scope.

**A real defect this fixes.** Today a member who creates an agent and has not
yet bound it to a channel **immediately loses sight of it** — `includeUnbound`
is true only for org owners (`packages/workspace-admin/src/agent-list.ts:49-54`).
Ownership closes that hole as a side effect.

## The data model — one column

```
Agent.ownerUserId  String?  @db.Uuid   → User(id) ON DELETE SET NULL
@@index([organizationId, ownerUserId])

CHECK (owner_user_id IS NULL
       OR (system_managed = false AND organization_id IS NOT NULL))
```

- **The CHECK carries `organization_id IS NOT NULL`** because `Agent.organizationId`
  is nullable by explicit design (system/global agents), and ownership is only
  ever evaluated against an organisation's membership — an owned org-less agent
  would be unresolvable. It does not conflict with
  `agents_system_managed_invariants_chk`, which constrains only
  kind/surface/delegation/system-managed.
- **`NULL` means unowned**, and is a rendered category, not an error.
- **No backfill, and no inference.** Nothing records who created an agent:
  `agent.created` exists in `AuditActionSchema` but is emitted by no production
  path, and `AgentBinding` stores no user. Guessing an owner from the first
  binder would be fabrication. Phase 1 starts emitting `agent.created` so this
  stops being true going forward.
- The name collides with `Task.ownerUserId`, which means *assignment*. This one
  means *stewardship*. Worth a column comment.

**Ownership is attribution and visibility — never lifecycle.** An agent owned by
someone who leaves **keeps executing**: its triggers keep firing and its
bindings keep it in channels. Verified: `setOrganizationMemberDeactivated`
touches the membership row, refresh families and push presence, and nothing
else; UOA-side removal writes nothing locally; there is no sweep and no
`agent.orphaned` event. This is deliberate and unchanged here. Changing it is a
separate piece of work with its own trigger and surface.

**The owner is a pointer whose meaning is re-derived on every read.** The FK is
org-agnostic but the invariant is "owner is an active `OrganizationMember` of
*the agent's* org" — a person in orgs A and B, deactivated in A only, is a valid
owner in B and an invalid one in A. This follows the existing precedent in
`resolveGrantedDisclosureScopeKeys` (`packages/runtime/src/disclosure-access.ts:117-139`):
a stored pointer, live authority.

### Write paths

| Path | Owner stamped |
|---|---|
| `POST /api/agents` (member-level) | the creating user |
| PA `agent_create` tool | `resolveActingMember`'s live id — mirroring the route exactly |
| `cloneAgentRecord` | **the cloner**, not the source's owner |
| `spawn_subtask` | inherits `parentAgent.ownerUserId` (raw `tx.agent.create`, bypasses the chokepoint — must be edited directly) |
| PA / Librarian / external-agent bootstraps | stay `NULL` by CHECK |

**Transfer** extends the existing owner-gated `PUT /api/agents/:agentId` rather
than adding a second write path into the same row with a second gate to keep in
sync. Server-validates that the target is an `OrganizationMember` of **the
agent's** organisation with `deactivatedAt: null`, and audits
`agent.owner_changed` with old and new values.

### The display projection — without it the doorway cannot render

`ownerUserId` alone is not enough to show an owner, because **there is no
member-readable endpoint mapping a local user id to a display name**:
`GET /api/users` is owner-only, presence returns no name, and the roster is
keyed by `uoaSub` and scoped to one team. So `AgentRecord` also carries:

```
owner: { userId, displayName, avatarAttachmentId, uoaSub, ownerState } | null
```

resolved by adding `ownerUser: { select: … }` to the existing
`agentRecordInclude` — one relation load on a query that already runs, no N+1.
The `User.displayName`/`avatarUrl` mirror exists for exactly this; its schema
comment says so ("these columns exist only so a name and a picture can be
rendered without a round trip per row", `api/prisma/schema.prisma:815-819`).

`ownerState` is `active | deactivated | outside_workspace`, resolved
server-side. It must be three values and not two, because the roster is
team-keyed: an agent owned by an **active colleague in another team** produces
exactly the same client-side observation as one owned by someone UOA removed.
Collapsing them would **libel active colleagues as departed**. The `deactivated`
arm needs the org-wide roster read and is therefore honest only from phase 3 —
say so in the UI rather than guessing.

## The tree

**Root — Organisation.** One header line, name labelled as a non-authoritative
mirror. Org switching stays the existing `WorkspaceSwitcher`.

**Level 1 — the Team, labelled as the team.** Not "the organisation". The
workspace comes from `actorContext.tenant.teamId` and presenting a
session-derived scope as org scope is precisely the Rule zero #2 mistake. When
phase 3 widens it, the honest label is "Workspaces active in Nessie" — a fact
about Nessie, not a claim about UOA's shape.

**Level 2 — People, from the live roster only.** Never from local
`OrganizationMember`/`TeamMember` rows.

**Level 3 — that person's agents**, `ownerUserId = person.userId` **intersected
with the viewer's own `listAgentsForUser` result**, so entitlement is inherited
rather than re-implemented. **No hidden counts** — "3 more you cannot see" leaks
the shape of private channels.

**Buckets at team level:** *Unowned*; *System* (collapsed, read-only); *Owner
not in this workspace*; *Owner deactivated* (phase 3).

**Each person's own row shows their Personal Assistant** as a projection of
their PA DM — never a per-person agent row, never asserted for anyone else, and
**never a link**: `isAgentVisibleToUser` hard-codes `systemManaged: false`, so
every agent detail route 404s on the PA.

**What the row is worth opening for.** `AgentRecord` already carries `status`,
`currentRunId`, `currentToolName`, `currentToolStartedAt`, `lastActivityAt` and
`channelIds`, and every one is computed under the viewer's own channel filter
(`agent-list.ts:62-99`). So "what is this person's agent doing right now, and
where" is entitlement-scoped **for free**, with no new reads.

**Cut, on Rule zero #3 and the Chief-of-Staff hard rule:** per-person run
counts, spend, and latency. The tree shows structure and current activity, never
per-report performance.

**Surface:** `/settings/members`, reframed — not a new page.
`admin/test/members-nav-doorway.test.ts:38-48` asserts the UOA nav set
`deepEqual`s exactly `['/settings/members']`, which is itself the argument.
**Doorways:** owner cell on `AgentListRow`; "Owned by" on the agent detail page;
owner field in the Agent Designer; person → their agents from
`ChannelMembersPopup`.

**Cost, stated because it is the obvious objection.** The tree read is one agent
query plus four batched relation loads, one `uoaSub → User` join, and two UOA
HTTP calls — about **seven queries and two HTTP calls regardless of headcount**.
Two adjacent things are *not* clean and need a budget or lazy rendering:
avatars fan out one upstream fetch per person (a 60-person tree is 60 UOA image
fetches on first paint; only the *subject set* is cached, not the image), and
phase 3's multi-team view multiplies the roster read per team with no
cross-team cache.

## One correction worth recording

Three independent designers all planned to "collapse five forked agent mappers"
before adding the field. That work is **unnecessary and rests on a misreading**:
`updateAgentRecord` ends in `mapAgentRecord`, and both include blocks are Prisma
`include` blocks — relations only, scalars returned by default — so
`ownerUserId` reaches the update response automatically. The four
`agent-read-model.ts` shapes are different contracts entirely
(`AgentStatusResponse`, `AgentActivity`, `AgentChild`, `ToolCallEntry`), not
`AgentRecord`. Only `api/src/lib/request-helpers.ts:212-238` is a genuine
hand-rolled fork, and its owner is `null` by CHECK. Do not gate ownership on a
refactor that buys nothing.

## Two leaks this design must not open

**The ownership branch must exclude subtask children.** Widening
`listAgentsForUser` with `{ ownerUserId: userId }` and having `spawn_subtask`
inherit its parent's owner combine into a real leak: a member who owns one agent
starts receiving **every subtask child it has ever spawned**, forever, because
nothing reaps them. The branch is therefore
`{ ownerUserId: userId, parentAgentId: null }`, mirrored in
`isAgentVisibleToUser`. Cost: a user-authored sub-agent created through the
Designer's `?parentId=` path is not reachable *via the ownership branch* — it
stays reachable through bindings, and that path has no in-app link today.

**The `uoaSub → User.id` lookup must be org-scoped.** `User.uoaSub` is unique
**globally**, so a naive `findMany({ where: { uoaSub: { in: subs } } })` returns
a local principal id for someone who has signed into a *different* organisation
on the same instance and has no membership here. Scope it with
`organizationMemberships: { some: { organizationId: sessionOrgId } }`, and
describe `userId` as "the local row in this organisation, when one exists" —
never as an identity claim.

## Escalation — a ladder over real edges, notify-and-continue

**Nothing waits.** No run suspends, because suspension does not exist (see the
register below). An escalation notifies a person and the run carries on.

The ladder, first non-empty rung wins, over edges that already exist:

1. **`Agent.ownerUserId`** — the agent's steward.
2. **`canManageChannel`** (`api/src/services/channels.ts:157-171`) — the one
   place channel, team and org admin rights already compose. Reuse it; do not
   restate it.
3. **Org owners** — as `worker/src/control/budget-alert-dispatch.ts:45-64`
   already resolves them.

**There is no rung 4 and no manager chain.** Extract one
`resolveEscalationRecipients` rather than a fourth restatement of the same walk.

Two invariants, both from the synthesis:

- **If no rung yields an entitled recipient, record it and do not deliver.**
  Never widen the search to find an audience.
- **The artifact carries a pointer, not content**, whenever the run's basis is
  non-empty. `UserAlert` rows are not basis-stamped the way messages are, so an
  alert body is an unchecked disclosure channel.

**Escalation is a disclosure act, not a neutral one.** Sol's finding, which the
superseded plan got wrong: delivering model-authored text to a new person *is*
disclosure, and being on the ladder proves organisational relation, not
entitlement to the source channel, DM, project, or memory. So escalation content
runs through the existing disclosure-basis system — the run already accumulates
its consumed source scopes (`worker/src/run/execute/disclosure-basis.ts:13-58`)
and delivery already revalidates a viewer's live reach
(`packages/runtime/src/disclosure-access.ts:17-64`). The model may decide it
wants to escalate and may draft wording; **it is never the security gate.**

**Prompt hygiene.** Feed the model opaque candidate handles and the structural
capability needed to choose — not names, away dates, or deputy facts. Chain
facts in a model's context are reproducible in any later reply, which turns
"who is on holiday" into channel-visible gossip. The server resolves identity
after the model picks.

## Coverage — deliberately cut from this plan

Absence-and-stand-in was in the superseded plan as `CoverageDelegation` plus a
`UserStatus.availability` flag. Cut, for reasons that are worth recording so it
is not re-proposed casually:

- A deputy is a **person→person authority edge** — the rejected decision
  re-litigated on smaller ground. It must argue its own case.
- **It has nowhere to route to.** Escalation delivery does not exist yet, so a
  coverage column would ship as data nobody reads — the same defect as
  `UserStatusRule.agentEnabled`, which is persisted and never consumed.
- The first consumer of `UserStatus` inherits three verified defects:
  `resolveActiveStatus` prefers any manually-active status before consulting
  schedules (so a manual "available" masks a scheduled "away"), `date_range`
  schedules ignore their stored timezone, and **no route lets one person read
  another person's statuses at all**.
- `UserStatusRule` has no `organizationId` — tenancy reaches it only through
  `statusId → UserStatus` — so a cross-org check there needs a join the table
  cannot express.

**What ships instead:** the roster's own `status` badge (already fetched, since
`listWorkspaceMembers` requests `?status=all`) and the existing presence read.
Coverage, when it comes, is the ladder **skipping a rung** — and it never widens
entitlement.

## New vs reused

| Need | New | Reused |
|---|---|---|
| Agent stewardship | `Agent.ownerUserId` + CHECK + index | `createAgentRecord` chokepoint; `PUT /api/agents/:agentId` and its owner gate |
| Owner display | `owner` projection on `AgentRecord` | `agentRecordInclude`; the `User.displayName`/`avatarUrl` mirror; `UserAvatar` |
| People | — | the live UOA roster relay (`listWorkspaceMembers`), unchanged |
| The tree | one pure `buildPeopleAgentsTree` + one renderer | `/settings/members`; `listAgentsForUser` entitlement; TabBar; existing avatars |
| Ownership visibility | one OR-branch (`parentAgentId: null`) | `listAgentsForUser` / `isAgentVisibleToUser` |
| Escalation targets | one `resolveEscalationRecipients` | `canManageChannel`; org-owner resolution; disclosure-basis |
| Audit | `agent.created`, `agent.owner_changed` | `emitAuditEvent` + the hash chain |

**Not built:** any membership column, any manager or deputy edge, a second
visibility system, a parallel absence system, an org-chart page separate from
members, per-person analytics.

## What is missing — the honest register

**Buildable now**

- `Agent.ownerUserId` column, CHECK, index; writers at all four paths; owner
  projection; the `parentAgentId: null` OR-branch mirrored into
  `isAgentVisibleToUser`; transfer + audit.
- `WorkspaceMemberRecord.userId`, org-scoped, in a shared presenter that also
  replaces the ad-hoc join in `worker/src/run/pa-tools/people.ts:91-115`.
- The tree at `/settings/members` (one team, honestly labelled) + four doorways.
- Independent bug fixes this touches: `presence.ts` list reads have **no
  `orderBy`**; `date_range` schedules ignore their timezone; message-scoped
  `DisclosureGrant` computes `expiresAt` and then **omits it from the create**
  (`api/src/routes/disclosure-grants.ts:112` vs `:124-130`), and the duration
  cap is checked only on the `scope` branch — a prerequisite for any story that
  calls grants time-bounded.

**Blocked, and named as such**

- **Escalation delivery** — needs a fourth `UserAlertKind`: an `ALTER TYPE`
  migration plus ~nine coordinated edit sites, with two silent-failure modes.
  Omit it from `visibleUserAlertWhere`'s exhaustive `OR`
  (`packages/db/src/user-alerts.ts:20-71`) and the alert is invisible in every
  list, count, read and delivery path; omit it from `resolveAttention` and the
  job returns `null`, enqueued and never delivered. `[buildable-but-expensive]`
- **Reaching a person outside the originating channel, live** — `WsScope` is
  `organization | channel | agent` only; there is **no user-private realtime
  scope**. `[blocked-on-new-scope]`
- **A shared agent addressing a specific person** — `send_message` is
  `personalAssistantOnly`. `[blocked-by-design — do not relax]`
- **Run suspension** ("the agent waits for its owner") — four independent
  missing pieces, not wiring: no writer of `waiting_approval`, no resume column,
  no `run.resume` topic, no consumer of `continuationToken`, no writer of
  `actorContext.approval`, no `ask_human` tool. Nothing is scheduled to build
  it: the plan this was previously sequenced behind is itself superseded and
  explicitly needs no suspension. `[blocked-on-unbuilt-mechanism]`
- **Org-wide people / multiple teams** — the org member list is already fetched
  and discarded (`uoa-org-roster.ts:299-320`, `parseOrgMembers` is
  module-private); what is missing is a decision about who may read it, since
  UOA backend mode applies no authorization of its own.
  `[blocked-on-entitlement-decision]`
- **Enumerating a UOA org's teams** — no relay exists; `/org/me` is
  per-acting-user and local `Team` rows under-report.
  `[blocked-on-UOA-contract]`
- **"Owner has left" as a reliable signal** — needs the org-wide roster read.
  `[blocked-on-org-wide-roster-read]`
- **Agent reaping/archival** — no delete route, no `archivedAt`, no sweep;
  `spawn_subtask` children accumulate permanently. `[blocked-on-unbuilt-mechanism]`

**Pre-existing defects found on the way, tracked separately**

- **No-self-approval is broken.** `kb_publish_request` writes
  `requesterId: context.agentId` (an *agent* id) while the guard compares it to
  `actorContext.actor.actorId` (a *user* id), so the human who triggered a run
  can approve their own agent's request.
- **`continuationToken` is handed to every approval viewer.** The record mapper
  emits it and the response schema requires it, so any member the visibility
  gate admits receives it. Inert today because nothing consumes it — a
  privilege-escalation primitive the moment suspension makes it a resume proof.
  Any future suspension work must redesign the proof as a server-only,
  single-use value bound to the exact tool invocation, never present in a DTO.
- **Approval expiry spans 336×** — the service default is 30 minutes, the only
  live creator uses 7 days, and the superseded approvals plan proposed 24 hours.
- **`loadAgentChildren` takes no visibility scope**, unlike every sibling read.
- **`external-agent.ts` writes an agent shape and an `extagent:` DM key that two
  committed CHECK constraints forbid** — verified live; the `dm_key LIKE 'pa:%'`
  constraint spans lines 57-63 of the 20260415110000 migration.

## Phases

1. **Ownership exists** — migration, four writers, owner projection, the
   `parentAgentId: null` OR-branch, transfer on the existing PUT, and
   `agent.created`/`agent.owner_changed` audit. Surface: owner cell on
   `/agents`, "Owned by" on agent detail. Ships alone and closes the
   member-loses-their-own-unbound-agent hole.
2. **The tree** — `WorkspaceMemberRecord.userId` (org-scoped),
   `buildPeopleAgentsTree`, one renderer at `/settings/members`, buckets and
   labels as above.
3. **Org-wide people** — expose the org member list already being fetched, as an
   explicit `?scope=organization`, behind a real entitlement gate. Unlocks the
   honest "owner has left" signal.
4. **Blocked, not scheduled** — escalation delivery, coverage, run suspension.

Each phase ships with its surface in the same change, additive migrations only.

## Open questions

1. **Who may transfer an agent?** Proposed: the current owner *or* an org
   owner/admin, target must be an active member of the agent's org, both parties
   audited. Open: does a transfer *to* someone need their acceptance? A transfer
   hands them escalations carrying context about that agent's work.
2. **Who may read the org-wide people list** (phase 3)? UOA applies no
   authorization of its own, so Nessie must decide. Proposed: any active member,
   matching the existing per-team roster's `{ admin: false }`.
3. **Does the ownership branch widen `isAgentAccessibleToActor` too far?**
   `loadAgentChildren` takes no visibility scope, so an owner could enumerate
   every child of their agent org-wide. Defensible — they would own those
   children — but it should be a stated decision, and the missing scope is a
   pre-existing looseness worth fixing regardless.
4. **Should `spawn_subtask` inherit the owner at all?** Inheriting keeps
   attribution honest; not inheriting keeps the roster clean. The
   `parentAgentId: null` filter makes the leak moot either way, so this is now a
   question about audit attribution rather than visibility.
5. **Realtime on transfer.** `useAgents` splits `['agents']` and
   `['agents','all']` deliberately; an owner change must invalidate both plus
   the tree. `WsScope` has an `agent` kind, so an event is available — is it
   worth one, or is refetch-on-focus enough?
