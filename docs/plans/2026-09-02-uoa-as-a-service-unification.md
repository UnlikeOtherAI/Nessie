# UOA as a service: unifying organisation, workspace, team and project

Status: proposal, 2026-09-02. Not implemented.

The owner's instruction: **treat UOA as a service.** Store no duplicated data
locally; when we need to know something UOA owns, ask its API. This document
maps what we actually have, then proposes the smallest set of changes that gets
there without pretending the network is free.

## 1. The shape of the problem

UOA has **two** levels: Organisation → Team. Nessie has **four**: Organization →
Project → Team → Channel, and the admin calls a Team a "workspace". So three
local levels mirror two upstream ones, and the extra level has no owner.

`Project` exists only because `Team.projectId` is a non-nullable foreign key
(`api/prisma/schema.prisma`). Every UOA workspace materialises a Project *and* a
Team (`api/src/services/workspace-target.ts` `createWorkspaceEnvironment`), and
the UOA team's single name is then mirrored onto **both** rows and healed on both
(`syncExternalWorkspaceNames`). One upstream fact, two local copies, two heal
paths.

It leaks to users. `admin/src/components/shared/CreateProjectDialog.tsx` asks for
one name — "project" — and then silently creates a Team called
`"{ProjectName} Team"`. `EditProjectDialog` renames only the Project, so the Team
keeps the stale name forever; and because `workspacesFromMe` labels each switcher
row `team.teamName ?? project.projectName`, the **stale auto-generated name is
what the "Workspaces" menu shows**. A user who never typed the word "team" ends
up navigating by it.

## 2. What is genuinely duplicated today

Verified against the schema and the call sites, worst first.

1. **A local rename of an SSO-owned name is accepted and persisted.**
   `PATCH /api/organizations/current` and `PATCH /api/projects/:projectId` both
   write `name` with **no check** that the row is UOA-bound. The design rule says
   this "is not a supported operation"; in practice the value sticks until the
   next login/refresh sync silently reverts it. `Team.name` has no local write
   path and is clean — proving the intended shape already exists.
2. **`User.email`, `displayName`, `avatarUrl`** are mirrors of UOA profile data.
   `displayName`/`avatarUrl` are re-synced every login/refresh and are honestly
   labelled non-authoritative; `email` is worse, because it is still a login
   match key and the CLI super-admin key.
3. **Two answers to "who is in this org."** `GET /api/users` reads local rows;
   `api/src/routes/workspace-members.ts` reads UOA live. They can disagree.
4. **`OrganizationMember.deactivatedAt`** is a local access kill-switch that
   nothing propagates to from a UOA-side removal.
5. **`Organization.name` / `Team.name` / `Project.name`** as stored values at all
   — three rows carrying two upstream names.

Deliberately **not** duplication, and staying: `externalOrgId`,
`Team.externalWorkspaceId`, `User.uoaSub` (binding keys — they are what make API
calls possible), audit rows, and Nessie-only config (logo, brand, budgets).

## 3. What UOA can and cannot answer

It can serve the whole hierarchy: org CRUD, members, teams, team members,
invitations, invite links, and `GET /org/me` (workspaces + pending invites + the
caller's org context, roles included).

Four gaps decide the design:

- **No webhooks or event stream.** Everything is pull. Nothing can tell Nessie
  "this person was removed" — so any local access decision derived from UOA state
  is stale until something asks again.
- **No bulk/aggregate read.** "Every team and its members for this org" is
  `1 + N` calls. There is no `?include=teams` on the member list.
- **No delta/sync endpoint, no ETags, no cache-control.** A consumer that wants
  to avoid refetching must diff `updatedAt` itself.
- **Avatars are separate authenticated fetches**, one per identity rendered.

These are why "ask the API for everything, every time" cannot be taken literally
for per-request authorization: a chat product renders dozens of identities per
screen and authorises every request. The honest reading of the instruction is
**UOA is the only authority and the only writer; Nessie keeps no second
authority — only bounded, revalidated caches that may be thrown away at any
time.**

## 4. Proposal

### 4.1 Collapse the extra level: a workspace is a Team, and Project is plumbing

Keep `Project` as a schema-internal parent (ripping out a non-nullable FK across
Channel/ProjectMember/BoardColumn is a large migration for no user-visible gain),
but stop treating it as a concept:

- **Nothing user-facing names a Project.** Remove "Create a project" as a
  doorway; the thing a person creates is a **workspace**, and it provisions the
  Project + Team pair as one unit under one name — which is exactly what
  `createWorkspaceEnvironment` already does for UOA workspaces. The local
  (no-IdP) path adopts the same call instead of `CreateProjectDialog`'s two-step.
- **One name, one row.** The workspace's display name lives on `Team` only.
  `Project.name` becomes a derived, non-user-visible label, or is dropped from
  every read path. That deletes one of the two heal targets in
  `syncExternalWorkspaceNames`.
- This kills the `"{ProjectName} Team"` artefact and the rename-drift, and makes
  the switcher's label a single fact rather than a `??` chain.

### 4.2 One word per concept

| Concept | UOA term | The word we use, everywhere |
|---|---|---|
| UOA Organisation ⇒ local `Organization` | Organisation | **organisation** |
| UOA Team ⇒ local `Team` (+ its Project) | Team | **workspace** |
| A room inside a workspace | — | **channel** |

Consequences, each a concrete edit: the Budgets scope picker stops offering
"Team"; the Integrations panel stops saying "Team access" beside "UOA workspace"
for the same id; the UOA billing panels say "workspace credits"/"workspace
members"; `Settings → Organization → Members` is retitled **Workspace members**,
because in UOA mode it *is* the team roster; and the pre-login screens stop
calling the whole deployment a "workspace" (they mean Nessie).

`Project` disappears from the vocabulary entirely, along with the sidebar
"Projects" section as a user-facing hierarchy level.

### 4.3 Stop being a second authority

- **Refuse local writes to UOA-owned fields.** `PATCH /api/organizations/current`
  and `PATCH /api/projects/:projectId` reject a `name` change when the row is
  UOA-bound (`externalOrgId` / `externalWorkspaceId` non-null), with a message
  pointing at where UOA owns it. This is a refusal, not a silent drop.
- **Renaming an organisation or workspace goes to UOA** via
  `PUT /org/organisations/:orgId` and `PUT .../teams/:teamId`, exactly as
  creation now goes to `POST /org/organisations`. Same pattern, same seam.
- **One roster.** `GET /api/users` is retired in UOA mode in favour of the UOA
  roster the Members page already uses; nothing answers a membership question
  from local rows.
- **Profile mirror retires** (the outstanding Phase 3 step 2): `displayName` /
  `avatarUrl` move behind a request-scoped identity directory fed from UOA, and
  `email` stops being a login match key.

### 4.4 One read model, with an explicit freshness contract

Because UOA offers no events, generalise the existing
`api/src/services/uoa-directory-cache.ts` into a single UOA read seam that every
surface uses, with the contract stated once: bounded, per-process, TTL'd,
never durable, never an authority, revalidated on every session event
(login, refresh, switch), and dropped on any UOA refusal. Nothing else may hold
UOA-derived data.

**The one deliberate exception, stated plainly:** `OrganizationMember.role` and
`deactivatedAt` stay local, because every API request authorises against them
and a per-request UOA round trip would put UOA in the latency and availability
path of every action in the product. They are a **projection with a revocation
path**, not an authority: re-derived from verified claims on every session
event, and — the missing piece — a UOA-side removal must drive `deactivatedAt`,
which nothing does today.

### 4.5 Two upstream bugs this depends on

Found while building in-app creation, verified in UOA source:

1. **The founder is not the owner of their own first team.** `createOrganisation`
   writes the owner's `TeamMember` with no role, and `teamRole` defaults to
   `member`. They are org `owner` but team `member`.
2. **`createTeam` never adds the creator to the team.** It writes the Team row
   and nothing else — while the workspace switch calls
   `service-access/confirm`, which requires an **active `TeamMember`**. So
   "create a workspace" creates it upstream and then cannot enter it. UOA's own
   hosted chooser works around this by calling `addTeamMember` afterwards, which
   the `/org/*` API cannot do atomically.

Both are fixed in UOA: set the founder's default-team role to `owner`, and give
`POST /org/organisations/:orgId/teams` an opt-in that adds the acting user as an
ACTIVE owner in the same transaction.

## 5. Order of work

1. UOA: the two fixes in §4.5 (unblocks workspace creation, which is otherwise
   broken on every attempt).
2. Nessie: refuse local writes to UOA-owned names; route renames to UOA (§4.3).
3. Nessie: collapse the Project doorway; one name on `Team` (§4.1).
4. Nessie: vocabulary pass (§4.2) — mechanical, wide, low risk.
5. Nessie: retire `GET /api/users` and the profile mirror behind the read seam
   (§4.3, §4.4).
6. Nessie: propagate UOA removal to `deactivatedAt` (§4.4).

## 6. Open questions

- Does any deployment rely on Projects as a *user-visible* grouping today? §4.1
  assumes not.
- Should renaming a workspace be offered at all in Nessie, or should it link out
  to UOA? Routing it through `PUT /org/*` keeps one authority either way.
