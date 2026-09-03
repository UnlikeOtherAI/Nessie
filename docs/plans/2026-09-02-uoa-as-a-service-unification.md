# UOA as a service: unifying organisation, workspace, team and project

Status: proposal v3, 2026-09-03. Partly implemented — see "Shipped" below.
v1 was reviewed by two independent reviewers who converged on six findings, all
folded in. v2 then went through a six-lens review with three refuters per
finding; **that run degraded** — 140 of its 235 agents died on a session usage
limit, so its "74 refuted" figure conflates genuine refutation with
infrastructure failure and only the two findings in §3a can be treated as
adjudicated. The rest are unadjudicated, not cleared, and a re-run is owed
before the remaining work is trusted.

### Shipped already

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

Everything after §4.1 is still unbuilt.

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

Webhooks are the primary path, the sweep is the backstop, and neither is trusted
alone: at-least-once delivery plus a periodic delta is the standard shape and it
degrades correctly when one half fails.

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

The consequence is not a stale cache. The sweep *succeeds*, so §4.4 refreshes
the checked-at stamp and the organisation stays inside its staleness horizon,
while a removed member keeps full access indefinitely and every surface reports
the cache as fresh. That is a silent fail-**open** of exactly the revocation
this plan exists to deliver, hitting any multi-replica deployment or any removal
whose transaction spans a sweep tick — routinely, from the day it ships.

**So the delta must not be ordered by wall clock.** UOA gains a transactional
outbox (`org_change_events`) written in the same transaction as every
org/team/member mutation, with a `bigserial` id as the cursor — and visibility
ordered at *commit*, not at insert, either through a single serialized publisher
stamping a published sequence or by only reading up to
`min(pg_snapshot_xmin(pg_current_snapshot()))`, so an id is never handed out
while an earlier transaction is still in flight. Every entity row gains a
`revision bigint` bumped from that same write, giving §4.4's per-row revision a
real source. The cheaper fallback — a DB-side `clock_timestamp()` trigger plus a
mandatory overlap window and an inclusive bound — is acceptable only if written
into the plan as a stated bound rather than left implicit.

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

**The schema has this inverted.** `Team.projectId` makes Project the *parent* of
Team, so the database reads Organisation → Project → Workspace. That single
inverted foreign key is the common cause of defects v1 and v2 treated as
separate:

- `createWorkspaceEnvironment` fabricates a Project for every workspace because
  a Team cannot exist without a Project parent — forced, not chosen.
- The fabricated project takes the workspace's name, so one upstream name lands
  on two rows and both need healing.
- `CreateProjectDialog` does the mirror image, silently creating `"{Name} Team"`.
- Several workspaces can hang off one project, a state the model forbids.

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

| Concept | UOA term | Our word |
|---|---|---|
| UOA Organisation ⇒ local `Organization` | Organisation | **organisation** |
| UOA Team ⇒ local `Team` + its Project | Team | **workspace** |
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

### 4.4 Membership becomes a cache with a real invalidator

This replaces v1's loophole. For a UOA-bound organisation:

- Local membership rows are a **cache**, written only from UOA responses and
  webhook events, never from a Nessie mutation. No local route may grant a role
  or a membership.
- **Webhook events apply immediately** — a removal or downgrade lands without
  waiting for the affected person to do anything, which is precisely what v1
  could not promise.
- **Every row carries the `revision` it was written from and a checked-at
  stamp.** Past a bounded staleness horizon with no webhook and no successful
  sweep, authorization **fails closed** for that organisation rather than
  trusting an old row. Fail-closed is what makes it a cache rather than an
  authority.
- **A Nessie-only suspension stays available as a deny-only overlay.** It may
  refuse access; it may never grant membership or a role.

The cost is stated rather than hidden: UOA joins the availability path for
authorization at the horizon boundary. That is the price of one authority, and
the webhook plus sweep is what keeps the horizon from being hit in normal
operation.

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
3. **Nessie**: consume them — membership becomes a fail-closed cache (§4.4).
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
