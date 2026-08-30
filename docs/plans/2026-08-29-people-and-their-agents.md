# People and their agents

**Status:** phases 1–2 **implemented** (2026-08-29). Phase 3 blocked on an
entitlement decision; phase 4 not scheduled — see "What is missing".
**Date:** 2026-08-29
**Supersedes:** [docs/done/2026-08-29-org-chain-of-command-superseded.md](../done/2026-08-29-org-chain-of-command-superseded.md)
(the rejected "chain of command" plan and its invented manager edge)
**Reviewed:** two rounds of cross-model review (Codex Sol + kimix), plus a
five-way code-grounding sweep and adversarial synthesis. Round 2 on this plan:
Sol "sound direction, four blockers"; kimix "fundamentally sound, approve after
S1/S3/realtime". All findings verified against code before applying; where the
two disagreed (the composite FK) the adjudication is recorded in-line.
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
Agent.ownerUserId  String?  @db.Uuid
@@index([organizationId, ownerUserId])

-- tenancy enforced at the storage boundary, not by service discipline.
-- The column list on SET NULL is REQUIRED (PG 15+; production is pg17):
-- a bare ON DELETE SET NULL on a composite FK nulls EVERY referencing
-- column, which would blank the agent's organization_id.
FOREIGN KEY (organization_id, owner_user_id)
  REFERENCES organization_members(organization_id, user_id)
  ON DELETE SET NULL (owner_user_id)

CHECK (owner_user_id IS NULL
       OR (system_managed = false AND organization_id IS NOT NULL))
```

**The two reviewers disagreed here, so the reasoning is recorded.** Sol asked for
a composite FK plus live re-derivation; kimix argued the composite FK is
over-cautious and gives "false confidence", because `OrganizationMember` rows are
**deliberately retained after deactivation** for audit history
(`packages/runtime/src/disclosure-access.ts:28-31`), so the FK is satisfied even
by a deactivated member.

**Both invariants are real and they are different, so keep both.**

- **Tenancy** — the owner is a member of *this agent's* organisation. A bare
  `User` FK cannot express this at all; the composite FK does. This matters
  because one writer, `spawn_subtask`, is a raw `tx.agent.create` **outside the
  shared creation chokepoint** (`worker/src/run/subtask-tools.ts:85-106`), so
  cross-org ownership must be impossible at the storage boundary rather than
  merely unlikely in the intended service path.
- **Liveness** — that membership is not deactivated. **No FK can express this**,
  which is kimix's real point and it is correct. Only the read-time
  re-derivation below provides it.

So the FK is a *tenancy* constraint and must never be read as a liveness
guarantee. It does not create a second hierarchy; it stops an authorization
pointer crossing its tenant. In practice `organization_members` rows are **never
deleted** (verified: no `delete`/`deleteMany` call anywhere in production code —
deactivation is a reversible flag), so the `ON DELETE` clause is a safety net
rather than a live code path.

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

**The owner is a pointer whose meaning is re-derived on every read.** The
composite FK proves the membership row exists in the right org; it cannot prove
that membership is still live, since a deactivated row is retained and still
satisfies it. So *recorded owner* and *effective, entitled owner* are two
concepts, and **every authorization, visibility, transfer and escalation path
uses the second**, resolved through one shared predicate that fails closed —
the same live `deactivatedAt: null` org-membership read `resolveDisclosureViewer`
already performs before trusting any retained channel/team/project row
(`packages/runtime/src/disclosure-access.ts:28-37`).

**The visibility branch is not exempt from this**, and saying so is the
difference between the safety claim being true and being aspirational. The new
OR-branch widens by *pointer equality to a user id*, so on its own a member
deactivated in org A — who still holds a local `User` row and is still
`ownerUserId` on agents in A — would keep seeing those agents. The branch is
therefore `{ ownerUserId: userId, parentAgentId: null }` **ANDed with the live
membership predicate**, not the pointer alone. Cost: one extra join on a query
that already joins.

### Write paths

| Path | Owner stamped |
|---|---|
| `POST /api/agents` (member-level) | the creating user |
| PA `agent_create` tool | `resolveActingMember`'s live id — mirroring the route exactly |
| `cloneAgentRecord` | **the cloner**, not the source's owner |
| `spawn_subtask` | inherits `parentAgent.ownerUserId` (raw `tx.agent.create`, bypasses the chokepoint — must be edited directly) |
| PA / Librarian / external-agent bootstraps | stay `NULL` by CHECK |

**Transfer ships in phase 2, not phase 1**, for a reason that is a house rule
rather than a preference: *a write that takes an id ships with the entitled read
that resolves it*. In phase 1 a non-org-owner has no target picker at all —
`GET /api/users` is owner-only, and the roster record carries `uoaSub` but not
the local `userId` the write needs. Transfer therefore lands with
`WorkspaceMemberRecord.userId`.

Two design constraints on it when it does land:

- **Body-sensitive authorization.** `PUT /api/agents/:agentId` is `requireOwner`
  today and its body already mutates system prompt, tool policy, provider/model,
  effort and run limits. Widening the whole route so an agent's own steward can
  transfer it would hand that steward **every configuration mutation** as a side
  effect. Either accept that explicitly as a product decision, or authorize per
  field so transfer and configuration do not inherit each other's gate.
- **Transfer is itself a disclosure, and a coercion vector.** `AgentRecord`
  carries the system prompt, tool policy and run limits, so assigning a
  private-channel agent to someone exposes at least its configuration to them.
  Worse, ownership is escalation rung 1: transferring a noisy agent to a person
  floods them with notifications they did not ask for. The pointer-not-content
  invariant caps the *content* blast radius, not the notification one. So
  transfer **requires the target's acceptance** — a pending-transfer state, with
  no escalation delivery to a target who has not accepted.

### The display projection — without it the doorway cannot render

`ownerUserId` alone is not enough to show an owner, because **there is no
member-readable endpoint mapping a local user id to a display name**:
`GET /api/users` is owner-only, presence returns no name, and the roster is
keyed by `uoaSub` and scoped to one team. So `AgentRecord` also carries:

```
owner: { userId, displayName, avatarAttachmentId, ownerState } | null
```

resolved by adding `ownerUser: { select: … }` to the existing
`agentRecordInclude` — one relation load on a query that already runs, no N+1.
The `User.displayName`/`avatarUrl` mirror exists for exactly this; its schema
comment says so ("these columns exist only so a name and a picture can be
rendered without a round trip per row", `api/prisma/schema.prisma:815-819`).

**`uoaSub` is deliberately not in this projection.** `UserAvatar` already
prefers the organisation-scoped user-id relay, so the subject buys nothing an
avatar needs — and an agent can be visible across teams through any public
channel, so inlining a UOA subject would be a contextual cross-team identity
disclosure decided before the org-wide directory entitlement has been.

**`ownerState` is phased, not resolved "for free".** The three-state value
cannot come from one relation load: the live roster is team-keyed and costs two
UOA reads, `listAgentsForUser` does not even receive the session team, and the
local `displayName` mirror is refreshed at login/switch/refresh rather than live.
So the honest contract per phase is:

| Phase | `ownerState` can say |
|---|---|
| 1 | `active` / `deactivated` for a locally-known member, else `unknown` |
| 2 | `+ in_this_workspace` — joined against the live team roster |
| 3 | `+ active_elsewhere` vs `removed_upstream` — needs the org-wide read |

Phase 1 can honestly say `deactivated` for anyone with a local membership row,
because `OrganizationMember.deactivatedAt` is read live — the same signal
`resolveDisclosureViewer` trusts. What phase 1 *cannot* distinguish is
"deactivated locally" from "removed upstream and never materialised here"; that
is what phase 3 adds.

It must reach the fuller set *eventually* because the roster is team-keyed: an
agent owned by an **active colleague in another team** is client-side
indistinguishable from one owned by someone UOA removed, and collapsing them
would **libel active colleagues as departed**.

**A cross-org owner renders as Unowned.** Because `uoaSub` is globally unique, a
person can hold memberships in two organisations on one instance. Live
re-derivation makes such an owner *invalid for this agent's org*, so the agent
falls into the Unowned bucket rather than displaying a name the viewer has no
entitlement to.

## The tree

**Root — Organisation.** One header line, name labelled as a non-authoritative
mirror. Org switching stays the existing `WorkspaceSwitcher`.

**Level 1 — the Team, labelled as the team.** Not "the organisation". The
workspace comes from `actorContext.tenant.teamId` and presenting a
session-derived scope as org scope is precisely the Rule zero #2 mistake. When
phase 3 widens it, the honest label is "Workspaces active in Nessie" — a fact
about Nessie, not a claim about UOA's shape.

**Level 2 — People, from whichever source is *authoritative for that
deployment*.** On a UOA deployment that is the live roster, never local
`OrganizationMember`/`TeamMember` rows. But `/settings/members` already has two
deliberate modes — `isUoaSession` renders the workspace roster, and a local
install renders its own authoritative `User` rows
(`admin/src/pages/settings/SettingsMembersPage.tsx:127,142,191`) — and a local
install with no IdP *is* the authority for its people. So the tree takes its
people source as a parameter: one renderer, two authoritative sources. Saying
"never local rows" without that qualifier would leave the local install with no
tree and risk replacing its existing member management.

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
`ChannelMembersPopup` — noting that this last one crosses a scope boundary
(the popup lists *channel* members while a person's agents are org-scoped), so
it takes the same entitlement intersection as the tree rather than listing
whatever that person owns.

**People render even without a local row; agents require one.** The `uoaSub →
User.id` join necessarily passes through local `User`/`OrganizationMember` rows,
so someone who exists in UOA but has never signed in appears in the tree as a
person with **zero** agents. That is correct — they cannot own a local agent
without a local row — but it means the tree is not purely UOA-shaped, and the
copy should not imply otherwise.

**Cost, stated because it is the obvious objection.** The tree read is one agent
query plus four batched relation loads, one `uoaSub → User` join, and two UOA
HTTP calls — about **seven queries and two HTTP calls regardless of headcount**.
Avatars are the exception and need a budget: the relay does one upstream fetch
per subject and only the *subject set* is cached, not the image, so a 60-person
tree is 60 UOA image fetches on first paint. **This bites phase 1 before the
tree exists** — the owner cell on `AgentListRow` puts the same fan-out on the
agents list, a higher-traffic surface. Lazy-render avatars below the fold or cap
first-paint fan-out before phase 1 ships. Phase 3's multi-team view multiplies
the roster read per team with no cross-team cache.

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

## Three leaks this design must not open

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
never as an identity claim. The existing PA people lookup
(`worker/src/run/pa-tools/people.ts:91-100`) resolves `uoaSub` globally today
and is the first caller the shared presenter should replace.

**The children endpoint must take the viewer's scope — in phase 1, not later.**
`GET /api/agents/:agentId/children` authorizes only the **parent**
(`isAgentAccessibleToActor`) and then calls `loadAgentChildren` with no
visibility scope, returning every child in the organisation with name, status
and purpose (`api/src/routes/agents.ts:586-604`,
`api/src/services/agent-read-model.ts:295-324`) — unlike its sibling
status/activity/messages/tools reads, which all pass
`createAgentVisibilityScope`. That is a pre-existing looseness, but the
ownership branch **activates** it: a member who newly reaches a parent through
ownership can enumerate all of its children, which is exactly the enumeration
`parentAgentId: null` was added to prevent. Having decided that inherited
ownership is *not* sufficient for child visibility in the list, it cannot be
sufficient here either. Phase 1 passes the scope through and defines what a
child must satisfy to be listed.

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

**Escalation is a disclosure act, not a neutral one.** Delivering model-authored
text to a new person *is* disclosure, and being on the ladder proves
organisational relation, not entitlement to the source channel, DM, project, or
memory. The model may decide it wants to escalate and may draft wording; **it is
never the security gate.**

**The gate is two independent checks, and disclosure basis alone is not enough.**
This is the correction that matters most, and the first draft of this plan got
it wrong. `computeReplyBasis` deliberately subtracts the destination's own chain
— including `channel:${destinationChannelId}` — from the basis
(`worker/src/run/execute/disclosure-basis.ts:61-72`), because a source the room
already implies is not privileged *there*. So **a reply produced in a private
channel, drawing only on that conversation, has an empty basis**, and
`viewerSatisfiesBasis` returns `true` unconditionally for an empty basis
(`packages/runtime/src/disclosure-predicate.ts:39-46`). A rule of "carry a
pointer whenever the basis is non-empty" therefore does nothing in precisely the
case that matters most.

The existing push path is safe because it does not rely on the basis alone: it
checks **source-channel membership first**, then applies basis gating
(`worker/src/control/push-dispatch.ts:90-105`, `:138-149`). Escalation must do
the same. Every recipient must independently satisfy:

1. **live access to the originating artifact** — the channel or thread the run
   was working in; and
2. **the run's disclosure basis**, via the existing predicate.

Neither check subsumes the other. If the product later wants to notify someone
who fails check 1, that artifact carries *defined non-sensitive metadata only*
and its dereference route re-runs both checks — it is not a shortcut around them.

Two further invariants:

- **If no rung yields a recipient passing both checks, record it and do not
  deliver.** Never widen the search to find an audience.
- **Pointer-not-content is a structural invariant, not a guideline.**
  `UserAlert` rows carry no basis stamp the way messages do, so an alert body is
  an unchecked disclosure channel *by construction*. "Prefer a pointer" is
  therefore not good enough: the escalation artifact writer must be
  **structurally incapable** of embedding run content — a fixed server-authored
  template with no model-supplied free-text field. This plan insists elsewhere
  that the model is never the security gate; the same standard applies here, so
  the constraint lives in code, not in a prompt.

**Recipient freshness is its own prerequisite.** `canManageChannel` is a
predicate over one supplied user and its membership reads **do not filter
`deactivatedAt`** (`api/src/services/channels.ts:137-171`), and the UOA member
remove/deactivate routes relay upstream **without updating local rows**
(`api/src/routes/workspace-members.ts:258-294`). So a UOA-removed manager stays
a local candidate. This matters more for push than for page reads, because a
push recipient need not hold a session that would re-derive authority. Escalation
delivery therefore depends on a live org-wide authority read or another
revocation contract — not merely on a new alert kind.

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

The register distinguishes three things that are not the same: **buildable now**,
**deferred** (nothing external stops it; it is unbuilt or expensive), and
**blocked** (waiting on an authority decision or an external contract). Treating
all unfinished work as "blocked" makes the register useless for sequencing.

**Buildable now**

- `Agent.ownerUserId` column, composite FK, CHECK, index; writers at all four
  paths; owner projection; the `parentAgentId: null` OR-branch mirrored into
  `isAgentVisibleToUser`; the `loadAgentChildren` visibility-scope fix; audit.
- `WorkspaceMemberRecord.userId`, org-scoped, in a shared presenter that also
  replaces the ad-hoc join in `worker/src/run/pa-tools/people.ts:91-115`.
- The tree at `/settings/members` (one team, honestly labelled) + four doorways.
**Adjacent defects — fix separately, do not bundle into these phases**

Bundling unrelated fixes into an ownership phase makes verification and rollback
harder, so these get their own changes even though this work found them:
`presence.ts` list reads have **no `orderBy`**, and `date_range` schedules ignore
their stored timezone.

**One of them is a prerequisite, not a drive-by.** Message-scoped
`DisclosureGrant` computes `expiresAt` and **omits it from both the create and
the update** (`api/src/routes/disclosure-grants.ts:107-134`), with the duration
cap checked only on the `scope` branch — so a re-grant silently resurrects a
never-expiring grant even when the granter picked 10 minutes. Escalation's
content gate leans on exactly this system, so **this must be fixed before
escalation delivery ships**, not filed alongside the cosmetic defects.

**Deferred — unbuilt or expensive, but nothing external stops it**

- **A fourth `UserAlertKind` for escalation** — an `ALTER TYPE` migration plus
  ~nine coordinated edit sites, with two silent-failure modes: omit it from
  `visibleUserAlertWhere`'s exhaustive `OR`
  (`packages/db/src/user-alerts.ts:20-71`) and the alert is invisible in every
  list, count, read and delivery path; omit it from `resolveAttention` and the
  job returns `null`, enqueued and never delivered.
- **A user-private realtime scope** — `WsScope` is `organization | channel |
  agent` only, so a recipient outside the originating channel gets a durable row
  and a bell but no live update.
- **Run suspension** — six independent missing pieces, not wiring: no writer of
  `waiting_approval`, no resume column, no `run.resume` topic, no consumer of
  `continuationToken`, no writer of `actorContext.approval`, no `ask_human`
  tool. Nothing is scheduled to build it; the plan this was previously sequenced
  behind is itself superseded and explicitly needs no suspension.
- **Agent reaping/archival** — no delete route, no `archivedAt`, no sweep, so
  `spawn_subtask` children accumulate permanently.

**Blocked — waiting on a decision or an external contract**

- **Escalation delivery**, on three prerequisites — these are the real blockers
  rather than the alert plumbing above: **source entitlement** (the two-check
  gate), **recipient freshness** (a UOA-removed manager stays a local
  candidate), and **the message-grant `expiresAt` fix**, since the content gate
  leans on a grant system that currently cannot expire.
  `[blocked-on-design + one bug fix]`
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
- **A shared agent addressing a specific person** — `send_message` is
  `personalAssistantOnly`. `[blocked-by-design — do not relax]`

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

> **Status (2026-08-29): phases 1 and 2 landed** on `feat/people-and-their-agents`.
> Migration `20260829170000_agent_owner_stewardship`; `Agent.ownerUserId` with
> the composite tenancy FK and the CHECK; all four writers; the owner projection
> on `AgentRecord`; `buildOwnedAgentWhere` shared by `listAgentsForUser` and
> `isAgentVisibleToUser`; the `loadAgentChildren` visibility scope;
> `agent.created` / `agent.owner_changed` audit plus the `agent.updated`
> realtime event; org-scoped `WorkspaceMemberRecord.userId`; owner-gated
> transfer on the existing `PUT`; the owner cell on `/agents`; and the tree on
> `/settings/members`.
>
> Two deviations from the text below, both deliberate:
> **transfer is org-owner-only and has no acceptance step**, because the route's
> existing `requireOwner` was not widened (widening it would hand every steward
> the config mutations that share the endpoint) and because ownership currently
> decides visibility and attribution only — the coercion vector it guards
> against arrives with escalation delivery, which is not built. Acceptance
> becomes mandatory at that point, not before.

1. **Ownership exists** — migration (column, composite FK, CHECK, index), the
   four writers, the owner projection with a phase-1-honest `ownerState`, the
   `{ownerUserId, parentAgentId: null}` OR-branch mirrored into
   `isAgentAccessibleToActor`, **the `loadAgentChildren` scope fix**, and
   `agent.created` / `agent.owner_changed` audit. Surface: owner cell on
   `/agents`, "Owned by" on agent detail. Ships alone and closes the
   member-loses-their-own-unbound-agent hole. **No transfer** — see phase 2.
2. **The tree, and transfer** — `WorkspaceMemberRecord.userId` (org-scoped) in a
   shared presenter, `buildPeopleAgentsTree`, one renderer at
   `/settings/members` parameterised by people source (UOA roster / local
   users), buckets and labels as above. Transfer lands here because this is
   where the picker that resolves its id exists.
3. **Org-wide people** — expose the org member list already being fetched, as an
   explicit `?scope=organization`, behind a real entitlement gate. Unlocks the
   honest "owner has left" signal and `ownerState`'s third value.
4. **Not scheduled** — escalation delivery, coverage, run suspension.

Each phase ships with its surface in the same change, additive migrations only.

## Open questions

1. **Who may transfer an agent?** Proposed: the current owner *or* an org
   owner/admin, target must be an active member of the agent's org, both parties
   audited. (The *acceptance* half is now settled — see "Transfer" above: it is
   required, because ownership is escalation rung 1.)
2. **Who may read the org-wide people list** (phase 3)? UOA applies no
   authorization of its own, so Nessie must decide. Proposed: any active member,
   matching the existing per-team roster's `{ admin: false }`.
3. **What must a child satisfy to be listed** once `loadAgentChildren` takes the
   viewer's scope (phase 1)? An accessible run/thread, a channel binding, or
   ownership of the child itself? Inherited ownership of the *parent* is
   explicitly not sufficient — that is the decision that makes the fix
   necessary — but the positive rule still needs choosing.
4. **Should `spawn_subtask` inherit the owner at all?** Inheriting keeps
   attribution honest; not inheriting keeps the roster clean. The
   `parentAgentId: null` filter makes the leak moot either way, so this is now a
   question about audit attribution rather than visibility.
5. ~~**Realtime on transfer.**~~ **Settled: yes, emit.** An ownership change
   alters *who can see the agent at all*, so leaving a newly-owned agent
   invisible until refetch-on-focus is the "capability exists but nobody can
   reach it" failure rule zero exists to catch. `WsScope` already has an `agent`
   kind, so this is cheap: emit on transfer and invalidate both `['agents']` and
   `['agents','all']` plus the tree.
