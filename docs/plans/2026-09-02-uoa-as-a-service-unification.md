# UOA as a service: unifying organisation, workspace, team and project

Status: audited migration track v5, 2026-09-10. Partly implemented — see
"Audited current state" and "Shipped" below. Completion still depends on new
UOA contracts; no local mirror is an acceptable substitute.
v1 was reviewed by two independent reviewers who converged on six findings, all
folded in. v2 then went through a six-lens review with three refuters per
finding; **that run degraded** — 140 of its 235 agents died on a session usage
limit, so its "74 refuted" figure conflates genuine refutation with
infrastructure failure and only the two findings in §3a can be treated as
adjudicated. The rest are unadjudicated, not cleared, and a re-run is owed
before the remaining work is trusted.

## Audited current state (2026-09-10)

This inventory was verified against Nessie `355d67b62` and
UnlikeOtherAuthenticator `00fe760`. File references below name the source that
exists at those revisions, rather than a proposed API document.

### UOA operations Nessie can call today

| Area | Available `/org/*` operations | Verified source |
|---|---|---|
| Current standing | `GET /org/me`, including the selected organisation, `team_directory`, roles and pending invitations | UOA `API/src/routes/org/me.ts` |
| Organisation | create/read/update/delete and ownership transfer under a user subject; estate-wide list is backend-only | UOA `API/src/routes/org/organisations.ts`, `API/src/routes/org/organisation-members.ts` |
| Organisation roster | paginated member list, add, role change, remove, deactivate/reactivate, and per-member team access | UOA `API/src/routes/org/organisation-members.ts` |
| Team hierarchy | paginated team list, create/read/update/delete; member list/add/role change/remove and self-join | UOA `API/src/routes/org/teams.ts`, `API/src/routes/org/team-self-join.ts` |
| Invitations | create/list/read/resend/review/revoke, organisation invitation targets/history, invite links, and hosted accept/decline flows | UOA `API/src/routes/org/team-invitations.ts`, `API/src/routes/org/member-invitations.ts`, `API/src/routes/org/team-invite-links.ts`, `API/src/routes/auth/email-team-invite.ts`, `API/src/routes/auth/auth-select-team.ts` |
| Profile pictures | current-user avatar read/write/delete and team avatar read/write/delete | UOA `API/src/routes/avatar/me.ts`, `API/src/routes/org/team-avatar.ts` |

Roster responses already include the stable subject plus display name, avatar
URL, and email when the live UOA permission allows it
(`API/src/services/organisation.service.roster.ts` and
`team.service.roster.ts`). Nessie's existing relay is
`packages/team-admin/src/uoa-org-roster.ts` and `uoa-org-members.ts`; it carries
a short-lived subject assertion and never uses the domain bearer as a roster
authorization substitute.

### Upstream operations that do not exist yet

At `00fe760`, UOA has no shipped `GET/PATCH /profile/me` for a current user's
name or email, no exact member-profile read, no product relying-party credential
for background reconciliation, no organisation snapshot or delta endpoint, no
identity/hierarchy webhook stream, and no transactional org-change outbox or
org/team/member revision columns. `docs/api-2.0-implementation-plan.md` describes
profile routes, but there is no corresponding route or service in `API/src`.
The snapshot, delta and webhook contracts below are likewise required upstream
work, not capabilities Nessie may assume.

These are implementation dependencies, not external blockers: the UOA repository
is available for the work. The [staged handoff](2026-09-10-uoa-authority-next-slices.md)
selects the credential, commit-order and migration boundaries for the next slices.
Complete those contracts before removing their dependent render mirrors and
authorization copies. Nessie must fail closed where a live contract is required; it must
not fill the gap with another copied profile, membership table, background use
of the estate-wide domain credential, or a local-password SSO fallback.

### Nessie storage and call-site audit

The durable bindings that stay are `User.uoaSub`,
`Organization.externalOrgId`, and `Team.externalTeamId`. Product-owned user
extensions such as preferences, statuses and local object references also
stay. The remaining UOA-owned copies are:

- `User.email`, `User.displayName`, and `User.avatarUrl`, written at UOA
  principal materialisation and refreshed by `uoa-profile-mirror.ts`; read by
  `/api/auth/me`, legacy `/api/users`, message/activity/call/alert/DM/push
  projections and several owner selectors.
- `Organization.name`, `Team.name`, and redundant `Team.externalOrgId`.
  Rename routes relay upstream, but login/materialisation and cache fallback
  still persist or read these values.
- `OrganizationMember`, `TeamMember`, and `ProjectMember`. Bound-tenant local
  mutation routes are gated, and login/rotation reconciles the affected user,
  but these rows still authorize ordinary requests between rotations.
- The 30-minute per-process team-directory cache in
  `api/src/services/uoa-directory-cache.ts`. On a cold or expired entry it can
  derive the directory from local Team/TeamMember rows. That is a known
  hierarchy/profile fallback and must retire after the upstream read boundary
  can cover the same use cases.

Live organisation/team Members and invitation surfaces already use UOA. Local
account, membership and team creation are refused according to the acting
organisation's binding, not deployment mode. `Project.teamId` is in the expand
phase (`20260911110000_project_team_inversion_expand`), and new person-created
projects write it; `Team.projectId` remains the required legacy anchor for rows
not yet audited. `systemManaged` teams and the `channelRoot` project are
deliberate Nessie-only containers. An organisation with `externalOrgId = null`
is the explicit no-IdP mode and retains local identity management.

### Deployable migration slices

1. **Active identity directory (this slice).** `GET /api/users` in a UOA-bound
   organisation reads every page of the live ACTIVE UOA organisation roster,
   under the current actor's subject assertion, and joins it to product-owned
   local fields by `User.uoaSub`. Its in-memory display cache is keyed by actor,
   organisation, active team and credential epoch, expires after 30 seconds,
   has entry and total-member bounds, and never serves expired data after an
   upstream error. Same-key misses share one load, at most 20 loads are tracked,
   and invalidation prevents an older load from refilling the cache. It is not
   an authorization cache. Missing subject bindings,
   duplicate subjects and incomplete pagination fail explicitly. The unbound
   `/api/users` behavior is unchanged. Historical records keep stable local
   author references; this active selector does not establish the final
   historical-profile rendering contract.
2. **Upstream revocation substrate.** Add a product relying-party credential,
   transactional change outbox and row revisions in UOA, followed by signed
   webhooks, a complete snapshot and an outbox-ordered delta. Prove the
   credential cannot read organisations that did not grant the product access.
3. **Fail-closed membership consumer.** Route bound-tenant membership and
   hierarchy reads through one UOA API boundary. Reuse a response only in a
   bounded process-memory cache, invalidate it from signed change events and
   credential-epoch changes, and require a live read after its short freshness
   deadline. Events and deltas carry invalidation/version facts; Nessie does not
   materialise their UOA-owned payload into durable rows. Remove the existing
   local membership rows from authorization as this boundary reaches each
   consumer; until then those rows remain a named migration gap, not a cache.
4. **Hierarchy backfill and contract.** Run `scripts/inspect-team-shape.sql`
   against each deployment and halt on orphaned, multi-team, inconsistent or
   cross-tenant rows. Backfill `Project.teamId` only for unambiguous rows,
   handle `systemManaged`/`channelRoot` containers explicitly, add coherence
   constraints, migrate readers, then remove `Team.projectId` and fabricated
   anchor projects. Never infer ownership from name, session or creation time.
5. **Profile and hierarchy contract.** Add the missing exact profile/name reads
   upstream; move `/api/auth/me` and remaining message/activity/call/alert/DM/
   push renderers onto the one directory boundary. Then remove profile/name
   mirrors and `Team.externalOrgId`. Each removal lands only after its caller
   inventory is empty and its upgrade path preserves product-owned data.

### Shipped already before this audit

- **UOA** (`31d0faf`): the founder owns their first workspace, and
  `POST /org/organisations/:orgId/teams` takes `join_creator` to put the creator
  in the team it just made, as an idempotent upsert. Without these, creating a
  workspace produced one its author could not open.
- **Nessie**: requests `join_creator`; invalidates the caller's directory cache
  on creation (closing the failed-switch path); refuses local renames of
  SSO-owned organisation and workspace names at both routes and removes the
  affordance rather than leaving a form that can only 409;
  `OrganizationSummary.nameManagedExternally` with a guard test; and
  `scripts/inspect-workspace-shape.sql` to size the migration below.

The sentence that previously said everything after §4.1 was unbuilt was stale:
live rosters/invitations, bound-tenant mutation gates, the team vocabulary pass,
the split member surfaces, and the relationship expand phase have shipped. The
revocation substrate, audited backfill/contract, and profile/name mirror removal
have not.

The owner's instruction: **treat UOA as a service.** Store no duplicated data
locally; ask its API. And, as of this revision: **UOA may be extended** — if the
model needs webhooks, bulk reads or delta endpoints, add them there.

That last permission is what makes the plan honest. v1 kept local access-control
state and called it a "projection with a revocation path", which both reviewers
correctly called a loophole: with no event stream, nothing could *drive* that
revocation, so the values authorising every request were an authority whatever
they were labelled. The fix is not better wording. It is to build the missing
mechanism upstream.

## 1. The shape of the problem

UOA has **two** levels: Organisation → Team. Nessie's model is Organisation →
Workspace → Project → Channel, where a workspace IS the UOA team and a project
is Nessie's own ([standards/workspace-model.md](../standards/workspace-model.md)).
The SCHEMA, however, reads Organisation → Project → Workspace, because
`Team.projectId` points the wrong way.

`Project` is not the harmless plumbing v1 claimed. Verified in the schema:

- **`Team.projectId` has no unique constraint.** A Project may hold zero, one or
  many Teams. The 1:1 shape exists only by convention in the UOA materialisation
  path (`createWorkspaceEnvironment`); `POST /api/teams` can add more.
- Project owns real product and authorization semantics: `ProjectMember` (with
  its own `role`), board style and columns, tasks, plans, approvals, knowledge
  objects, executors, alerts, and avatars. `listAccessibleProjectIds` gates
  visibility through it.
- `Channel` independently stores `organizationId`, `projectId` and `teamId`,
  with no constraint proving the team belongs to the project.

So hiding Project would leave invisible RBAC and content scopes that users
cannot see or reach — a half-migration. v1 was wrong here, and v2 was wrong in
the other direction: Project is not plumbing to be constrained into a 1:1 with
a workspace, it is a Nessie-only body of work that lives INSIDE one. See §4.1
and [standards/workspace-model.md](../standards/workspace-model.md).

It already leaks. `CreateProjectDialog` asks for one name and silently creates a
Team called `"{Name} Team"`; `EditProjectDialog` renames only the Project, so the
Team keeps the stale name; and `workspacesFromMe` labels switcher rows
`team.teamName ?? project.projectName`, so **the stale auto-generated name is
what the Workspaces menu shows**.

## 2. What is actually duplicated

v1 listed five items and missed the most important ones. Corrected, worst first.

1. **Three local membership tables mirror UOA's two.**
   `OrganizationMember.role`, `TeamMember.role` and `ProjectMember.role` are all
   durable local access state. UOA has `OrgMember.role` and `TeamMember.teamRole`
   and no project concept at all. `resolveDefaultTarget` picks an enterable
   workspace from the local `TeamMember` table — so local membership can select,
   grant or deny differently from UOA, indefinitely.
2. **A local rename of an SSO-owned name is accepted and persisted.**
   `PATCH /api/organizations/current` (`organizations.ts:110`) and
   `PATCH /api/projects/:projectId` (`projects.ts:235`) write `name` with no
   check that the row is UOA-bound. It sticks until a later sync silently
   reverts it. `Team.name` has no local write path and is clean — the intended
   shape already exists.
3. **`User.email`, `displayName`, `avatarUrl`** mirror UOA profile data; `email`
   is still a login match key and the CLI super-admin key.
4. **Two answers to "who is in this org"** — `GET /api/users` from local rows,
   `workspace-members.ts` live from UOA.
5. **`Team.externalOrgId`** is redundant: the owning org is reachable through
   `Team → Project → Organization.externalOrgId`. A redundant copy can drift, and
   drift here surfaces as a binding-conflict failure.
6. **Workspace identity** — UOA supplies `avatarImageUrl` per team while Project
   keeps locally writable avatar fields, so icons can disagree between surfaces.

Staying, and not duplication: `externalOrgId`, `Team.externalWorkspaceId`,
`User.uoaSub` (binding keys), audit rows, Nessie-only config (logo, brand,
budgets, board style).

## 3. What UOA cannot answer today — and what we add

Gaps: no webhooks or event stream; no bulk aggregate read (a full roster is
`1 + N` calls); no delta endpoint, ETags or cache-control; avatars are separate
authenticated fetches.

v1 treated these as fixed constraints and bent the design around them. They are
not fixed. **Three additions to UOA**, which is a parallel project we own:

- **`POST` webhook delivery of org/team/membership events.** Signed per-domain
  (the HMAC pattern already used for product webhooks), at-least-once, carrying
  `{event, orgId, teamId?, userId?, occurredAt, revision}` for member added /
  removed / deactivated / reactivated / role-changed, team created / renamed /
  deleted, and org renamed / deleted. This is the mechanism v1 lacked, and it is
  what makes revocation real rather than aspirational.
- **A bulk org snapshot** — `GET /org/organisations/:orgId/snapshot` returning
  every team with its members and roles in one response, so a reconciliation
  sweep is one call rather than `1 + N`.
- **A delta read** — `?changedSince=` on that snapshot, so the periodic
  safety-net sweep is cheap and a missed webhook self-heals.

Webhooks are the primary cache-invalidation path and a periodic delta detects a
missed invalidation. Nessie may retain only an outbox cursor or last-seen
revision as product integration state; it must not persist the returned member,
profile, role, organisation or team payload. A cache refill always comes from a
UOA API response into bounded process memory.

## 3a. Two findings that change §3, both verified against source

The degraded review still produced two findings worth more than the rest of the
run. Both were checked directly rather than taken on trust.

### The sweep has no principal, and the only credential left reads the estate

Every `/org/*` read Nessie makes today authorises as the signed-in human:
`withUoaRosterSubjectAssertion` refuses unless the live session's UOA subject,
credential epoch, organisation and team all match, and UOA re-verifies. **A
background reconciliation sweep has no such principal by construction.** The
only credential left is the per-domain hash bearer — which is scoped to a
*domain*, not to an organisation, and not to the organisations that installed
Nessie.

Building the sweep on that bearer would silently revert the 2026-09-02 decision
that roster calls authorise as the person, and turn Nessie's client secret into
a read-everything key for every organisation on the domain, including ones that
never installed Nessie. A leak would disclose the estate's rosters, not
Nessie's tenants'.

So the authorization mode is a **first-class deliverable of §3**, not an
afterthought: a dedicated relying-party credential whose reach UOA restricts to
organisations that granted this product access — the same fact
`/billing/v1/service-access/confirm` already evaluates — with the snapshot
refusing any `orgId` outside that set.

### `changedSince` over `updated_at` fails OPEN, which is the one direction that matters

Verified in UOA's own migrations: `org_members.updated_at`,
`team_members.updated_at` and `teams.updated_at` are `TIMESTAMP(3) NOT NULL`
with **no DDL default and no trigger**, so Prisma's `@updatedAt` stamps them
from the API process's own clock. There is no `revision` column on any of those
tables and no sequence anywhere in the schema, so nothing today can produce the
monotonic value §4.4 assumes every cached row carries.

Three separate breakages follow, and they compound:

- **Clock skew.** One replica can stamp a row behind a cursor another replica
  has already advanced past. The row is never returned again.
- **Commit visibility.** The org-member removal path is one long transaction —
  owner reassignment, N team-member updates, group cleanup, the member update,
  then refresh-token revocation. It stamps `now` at the top and commits seconds
  later. A sweep running in between reads a snapshot that excludes the
  uncommitted row, advances its cursor past that timestamp, and **the removal
  becomes invisible forever.**
- **Rounding ties.** `TIMESTAMP(3)` collisions make an exclusive `>` bound drop
  boundary rows, and the plan specified neither bound nor overlap.

The consequence is a missed invalidation. A consumer can advance its cursor and
continue serving an in-memory result until its freshness deadline even though a
removal committed. The short deadline still forces a live read, but an ordered
cursor is required so invalidation remains prompt and deterministic across
instances.

**So the delta must not be ordered by wall clock.** UOA gains a transactional
outbox (`org_change_events`) written in the same transaction as every
org/team/member mutation. The selected contract uses one transaction advisory
lock per organisation, held across mutation, organisation-revision allocation,
outbox insertion and commit. Multi-org changes acquire locks in sorted ID order.
The unique `(orgId, revision)` cursor therefore follows that organisation's
commit order; aborted transactions publish neither a revision nor an event.
Snapshot reads take the corresponding shared lock and return a consistent
high-water revision. Delta pages retain a stable upper bound. An unprotected
serial, transaction-ID watermark or timestamp/overlap fallback is not this
contract. The [next-slices handoff](2026-09-10-uoa-authority-next-slices.md)
specifies the implementation and concurrency acceptance.

## 4. Proposal

### 4.1 Invert the relationship — REPLACES the 1:1 proposal, which was wrong

v2 proposed a unique constraint on `Team.projectId` to force Project and Team
into a genuine 1:1. **That was the wrong fix, and it was wrong because the
premise was wrong.** It came from reading `AGENTS.md`'s "one `Team` (with its
Project and `#general`)" and from `createWorkspaceEnvironment` creating the two
together with one name — and concluded Project was plumbing that existed to
satisfy a foreign key.

The actual model, now stated canonically in
[docs/standards/workspace-model.md](../standards/workspace-model.md):

```text
Organisation → Workspace (= a UOA team) → Project → Channel
```

A **workspace is the SSO's team**. A **project is a Nessie-only construct
inside one workspace** — a body of work, with no UOA counterpart. So a project
belongs to a workspace, and "which workspace does this project belong to?" must
always have one answer.

The inversion forces `createWorkspaceEnvironment` to fabricate a Project for
every workspace — a Team cannot exist without a Project parent — and that
phantom project then takes the workspace's name, so one upstream name lands on
two rows.

Two defects usually filed alongside these do **not** follow from the direction,
and this plan should not claim they do: `CreateProjectDialog`'s `"{Name} Team"`
comes from there being no way to create a project inside an existing workspace,
and multi-workspace-per-project comes from a missing `@unique` on
`Team.projectId`. Inverting the FK resolves both as a side effect — a reason to
prefer the inversion, not evidence that one key caused everything. See
[standards/workspace-model.md](../standards/workspace-model.md).

So the work is to **invert the relationship**: `Project.teamId` (a project
carries the workspace it belongs to) replacing `Team.projectId`. Constraining
the current direction, as v2 proposed, would have frozen the wrong shape
permanently — welding a body of work to a group of people to stop them
multiplying, instead of fixing which contains which.

The migration touches `Channel` (which carries `organizationId`, `projectId`
and `teamId` today, with nothing forbidding an inconsistent triple),
`ProjectMember`, and every project-scoped table.
`scripts/inspect-workspace-shape.sql` sizes it against real data.

Two questions it must answer, neither inferable from the schema: whether a
fresh workspace starts with zero projects or one starter project (today it
always gets exactly one because it must), and what happens to `ProjectMember`
once a project sits inside a workspace whose roster UOA already owns.

### 4.2 One word per concept — with the honest exceptions

> **Superseded on the word 2026-09-03.** The owner overrode this section's
> "workspace" proposal in favour of **"team"** during same-day discussion, and
> the rename shipped that day as commit `4fe11c54` ("refactor: rename the
> workspace concept to team, everywhere", 696 files) — see
> `docs/plans/2026-09-01-team-members-page.md`'s status banner for exactly
> what it touched. It landed as a vocabulary rename only: `Project` did
> **not** leave the hierarchy and the inversion this section's row implies
> (Project as a Nessie-only sub-unit below the UOA-mapped layer) was **not**
> built — the shape stayed `Organisation → Team → Project → Channel` (see
> `docs/standards/team-model.md`, itself renamed from
> `workspace-model.md`), with the local `Team` row simply keeping its name.
> The rest of this section (the split of `Settings → Organization → Members`
> into two rosters) is exactly what shipped the same day, independently, as
> the org-members-page fix referenced above — read it as confirmed, not
> superseded.

| Concept | UOA term | Our word (as proposed here; see note above for what shipped) |
|---|---|---|
| UOA Organisation ⇒ local `Organization` | Organisation | **organisation** |
| UOA Team ⇒ local `Team` + its Project | Team | ~~workspace~~ **team** (2026-09-03) |
| A room inside a workspace | — | **channel** |

Concrete edits: Budgets stops offering "Team" as a scope; Integrations stops
saying "Team access" beside "UOA workspace" for the same id; billing panels say
workspace; the pre-login screens stop calling the whole deployment a "workspace".
`Project` leaves the vocabulary and the sidebar.

**Where the table does not hold, per both reviewers.** UOA has organisation
members *and* team members, and an organisation with several workspaces has
different rosters at the two levels. So `Settings → Organization → Members`
cannot simply be retitled: it must **split** into an organisation roster and a
workspace roster, because an admin has to know whether an invitation, a role
change or a removal applies to the whole organisation or only this workspace.
That is a new surface, not a rename — and it is the honest reading of Rule zero,
since organisation-wide membership currently has no surface at all.

### 4.3 Stop being a second authority

- **Refuse local writes to UOA-owned fields.** Both PATCH routes reject a `name`
  change on a UOA-bound row, in words, and renames go to
  `PUT /org/organisations/:orgId` and `PUT .../teams/:teamId` — the same seam
  creation already uses.
- **One roster.** `GET /api/users` retires in UOA mode.
- **Profile mirror retires**: `displayName`/`avatarUrl` move behind a
  request-scoped identity directory; `email` stops being a login match key.
- **`Team.externalOrgId` is dropped** in favour of the derivable path.

### 4.4 Membership reads move behind one live boundary

This replaces v1's loophole. For a UOA-bound organisation:

- One UOA API-backed boundary answers identity, organisation, team and
  membership questions. No local route may grant a UOA role or membership.
- Reusable results live only in bounded process memory. Cache keys include the
  organisation, actor, selected team where relevant, credential epoch and UOA
  revision. Entries have a short freshness deadline and are never served stale
  after a failed refresh.
- Signed webhook events invalidate affected in-memory entries immediately. The
  ordered delta is a missed-invalidation check, not a source for a durable
  member or hierarchy projection. Nessie may durably retain the opaque cursor
  needed to resume that integration, because it describes product delivery
  progress rather than a person's identity or membership.
- Past the freshness deadline, authorization performs a live UOA read and fails
  closed if UOA cannot answer. No persistent snapshot extends that deadline.
- Existing `OrganizationMember`, `TeamMember` and UOA-derived
  `ProjectMember` rows remain an authority violation until each consumer moves
  to this boundary and the rows are removed. Calling them a projection or cache
  does not bless them.
- A Nessie-only suspension may stay as product-owned deny-only extension data.
  It can refuse access; it can never grant membership or a role.

The cost is stated rather than hidden: UOA is in the availability path whenever
an in-memory entry expires. Prompt invalidation and a short bounded TTL reduce
calls without creating another durable authority.

### 4.5 The upstream bugs, and the third piece

Two bugs, verified in UOA source, block workspace creation outright:

1. **The founder is not the owner of their own first team.**
   `createOrganisation` writes the owner's `TeamMember` with no role and
   `teamRole` defaults to `member`.
2. **`createTeam` never adds the creator.** It writes the Team row and nothing
   else, while the workspace switch calls `service-access/confirm`, which
   requires an **active `TeamMember`**.

Both reviewers flagged that fixing these is necessary but not sufficient, and
they were right about the third piece, though one worry can be retired:

- **Settled:** `confirm` re-reads live `OrgMember`/`TeamMember` rows inside a
  RepeatableRead transaction rather than trusting session claims, so an atomic
  membership insert *is* enough for the confirm step. No claims re-issue needed.
- **Still missing, and Nessie-side:** creating a workspace must invalidate the
  caller's UOA directory cache entry. Otherwise the thing they just made is
  invisible until TTL expiry. Creation must join login/refresh/switch as a
  revalidation event.
- **Still missing, and upstream:** the `createTeam` membership add must be an
  **upsert**, not a plain insert. UOA's own hosted chooser already calls
  `addTeamMember` after `createTeam`; a non-idempotent add turns that existing
  workaround into a 409 the moment the chooser adopts the flag.

## 5. Order of work

Revocation moves to the front: both reviewers noted it is foundational, not
cleanup, and v1 scheduled it last.

1. **UOA**: the two creation bugs (§4.5), with the membership add as an upsert.
   Unblocks workspace creation, which is otherwise broken on every attempt.
2. **UOA**: the relying-party credential, the transactional outbox and its
   `revision` columns, then webhooks, bulk snapshot and the outbox-ordered delta
   (§3, §3a). The credential and the outbox come first: without them the sweep
   is either estate-wide or fails open.
3. **Nessie**: consume them through a live API boundary with bounded in-memory
   reuse, then remove the durable local membership authorities (§4.4).
4. **Nessie**: invert `Team.projectId` into `Project.teamId` (§4.1). This must
   land *before* any rename work, because until it does a project-scoped rename
   has no single workspace to target.
5. **Nessie**: refuse local name writes; route renames to UOA (§4.3).
6. **Nessie**: retire `GET /api/users`, the profile mirror, `Team.externalOrgId`.
7. **Nessie**: vocabulary pass, and split the members surface (§4.2).

Steps 4 and 5 were ordered the other way in v1; both reviewers caught that a
rename cannot be routed while a Project may still hold several Teams.

## 6. Open questions

- Do any deployments have multi-Team Projects today? Step 4's migration needs an
  answer; a query against production settles it.
- Should a Nessie-only suspension exist at all, or is UOA deactivation the only
  way to remove access?
