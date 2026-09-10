# The team model: organisation, team, project

Authoritative standard for what an organisation, a team, a project and a
channel are, and which of them the SSO owns. `AGENTS.md` carries the one-line
invariant and points here; **this file is the rule**. It exists because four
documents each restated the hierarchy in their own words and all four ended up
with it backwards, as `Organisation → Project → Team → Channel`.

**The schema currently contradicts this document** (§"What the schema does
today"). Write code and copy for the model below, not for the foreign key.

The inversion is now in its **expand phase**: `Project.teamId` is written for
new person-created projects, while `Team.projectId` remains only to read rows
that have not passed the audited backfill. The backfill must run
`scripts/inspect-team-shape.sql` first and halt for orphaned, multi-team, or
inconsistent rows; it may never infer an owner from a name, current session,
or creation time.

An operation that places something in a project takes both the selected
`projectId` and `teamId` and resolves them through `Project.teamId`; it never
defaults to a team's old anchor project. Team-only homes and system surfaces
have no caller-selected project, so they retain that anchor as their temporary
default until the audited backfill removes it. Do not use the latter exception
to weaken an explicit placement check.

## The model

UnlikeOtherAI (UOA), the SSO, owns two levels, and people are members of the
lower one:

```text
UOA Organisation
  └── UOA Team        (people are members; one person is in many teams)
```

Nessie mirrors both, one for one, and adds its own constructs inside them:

```text
Organisation      = UOA organisation     the tenant
  Team       = UOA team             a person is in many
    Project       (no UOA counterpart)   a body of work, in exactly one team
      Channel     (no UOA counterpart)   a room in a project
      boards, knowledge, tasks, approvals — project-scoped
    agents — team-scoped
```

Read the right column as *is the same thing as*, not *is derived from*: a
team does not mirror a UOA team, it **is** one.

Three facts, each load-bearing:

1. **A team IS a UOA team.** Not a copy of one, not a container for one —
   the same thing, named differently. The product says *team*; the SSO says
   *team*.
2. **A project is a construct within Nessie.** UOA has never heard of it. It is
   a body of work — boards, tasks, plans, approvals, knowledge — living inside
   one team.
3. **A project belongs to exactly one team.** "Which team does this
   project belong to?" must always have exactly one answer.

### Reading guide: the names are crossed

This is the part that trips everyone, so read it once and it will stop biting:

- In **Nessie's** schema and routes, `Team`, `teamId`, `TeamMember` all mean
  **team**. The local Prisma model still wears the SSO's word.
- On the **UOA wire**, `teamId`, `teamRole` and `/org/organisations/:orgId/teams`
  are the same object under UOA's own word.
- `Team.externalTeamId` is where the two words meet — the local column
  wears *our* word and holds *their* id, which is the exact reverse of the model
  name it sits on.
- Older docs and comments say "UOA team". That means UOA team. Same thing.

**The exceptions**, which are Team and Project rows that are not user
teams or user projects, and which fact 3's absolute does not cover: the
`channelRoot` Project that holds organisation-wide channels, and
`systemManaged` Teams (the Personal Assistant and external-agent surfaces).

## Vocabulary

| Concept | UOA calls it | We call it, everywhere |
|---|---|---|
| The tenant | Organisation | **organisation** |
| The group of people you work in | Team | **team** |
| A body of work inside a team | — | **project** |
| A room inside a project | — | **channel** |

Do not say "team" to a person for the thing UOA calls a team. The reason is not
tidiness: two words for one group of people is how two rows came to carry one
name. `CreateProjectDialog` asks for a project name and silently creates a
`"{Name} Team"` beside it, and the team switcher labels rows
`team.teamName ?? project.projectName` — so whichever row was written first is
what a person sees, and renaming the other one changes nothing.

**The admin does not fully obey this yet.** Roughly two dozen strings still say
"team" — the budget scope picker offers "Team" and "Team" as *sibling*
scopes, agent ownership says "Team-owned", `CreateSpaceDialog` says "Everyone on
your team". Those are the copy equivalent of `Team.projectId`: known, wrong, and
scheduled with the vocabulary pass in the plan below. Do not add more; do not
take an existing one as licence.

## What the schema does today, and why it is wrong

**Write for the model above, not for the foreign key.** Concretely, that means:
name new identifiers and all copy *team* and *project*; add no new
dependency on `Team.projectId`; add no feature or constraint that assumes a
project can hold several teams; and treat "which team is this project
in" as a question with one answer even where the join could currently return
several. Existing queries still have to traverse the FK as it is — that is
expected, and does not make the current direction the model.

**The foreign key is inverted.** `Team.projectId` makes a Project the *parent*
of a Team, so the schema reads Organisation → Project → Team — the opposite
of the model above.

**What the inversion actually causes**, kept separate from what merely travels
with it — the tidy version of this list said one foreign key explained all four,
and two of them have their own causes:

- **Caused by the FK.** `createTeamEnvironment` must fabricate a Project
  for every UOA team, because `Team.projectId` is non-nullable and a Team
  cannot commit without a Project to hang from. The phantom project is forced,
  not chosen. (`Channel.projectId` is non-nullable too, so a channel compels one
  independently.)
- **Half caused by the FK.** That fabricated project *exists* because of the FK,
  but it *shares the team's name* because `createTeamEnvironment`
  computes one `name` and hands it to both rows. The duplicate that
  `syncExternalTeamNames` then has to heal twice is that convention, not
  the FK.

Two more defects are commonly filed with these and do **not** follow from the
direction, though inverting it happens to resolve both:

- `CreateProjectDialog` asking for a project name and silently creating a
  `"{Name} Team"` is caused by there being **no way to create a project inside
  an existing team** — `createTeamForUser` requires a `projectId`, so the
  dialog manufactures a team to hold the project. Under the inverted schema it
  would have to manufacture a team instead. The shape of the creation API
  is the bug.
- Several teams hanging off one project is a **missing `@unique` on
  `Team.projectId`**, not a direction problem. Adding that constraint would fix
  it while leaving the direction wrong — which is precisely why the fix below is
  the inversion and not the constraint.

**The fix is to invert the relationship**, not to constrain it: a project
carries the team it belongs to (`Project.teamId`), rather than a team
carrying its project. Adding a unique constraint to the current direction would
freeze the wrong shape permanently. The migration touches `Channel` (which
carries `organizationId`, `projectId` and `teamId` today, with nothing
forbidding an inconsistent triple), `ProjectMember`, and everything
project-scoped; it is scoped — not yet fully specified — in
[docs/plans/2026-09-02-uoa-as-a-service-unification.md](../plans/2026-09-02-uoa-as-a-service-unification.md),
and `scripts/inspect-team-shape.sql` sizes it against real data.

## Channel names, and what an archived channel keeps

A channel's name is its slug and its label at once — one name, and it is the
addressable one (`validateChannelLabel` is the single chokepoint every write
goes through). The name is unique **within the container the person is looking
at**, which under the model above is one team's body of work:

- A channel inside a project is unique across that project. A project holds one
  team, so per-project and per-team are the same rule stated at the row that
  exists today; do not add a second constraint that assumes otherwise.
- A shared (standalone) channel is unique across the organisation's
  `channelRoot` project — the one container all shared channels live in.
- The two namespaces are independent. `#general` may exist as a shared channel
  *and* in every project; twice inside one of them, never.

**An archived channel does not hold its name.** `DELETE /api/channels/:id`
archives rather than hard-deletes, and every list a person can see hides
archived channels — so before this, deleting `#random` left no trace except the
refusal to create a new one, naming a channel nobody could see, open, or
rename. Both halves of the rule carry the condition: the partial unique index
`channels_project_slug_standard_key` is `WHERE type = 'standard' AND archived_at
IS NULL`, and `ensureChannelSlugAvailable` filters `archivedAt: null`. Never
change one without the other — a check looser than the index is a 500, and a
check tighter than the index is an invisible conflict again.

The cost is paid at the other end: unarchiving can now collide, so
`setChannelArchived` re-checks the name on the way back and refuses in a
sentence that says which channel to rename (409 `CHANNEL_SLUG_CONFLICT`), rather
than failing on the constraint.

### Placing a channel in a team requires standing in it

A team id arrives in the request body, so it is the one fact that has to be
earned before a channel lands there — an organisation membership names no
team. `canPlaceChannelInTeam`
([packages/team-admin/src/channel-create.ts](../../packages/team-admin/src/channel-create.ts))
allows exactly: a `TeamMember` row on the team; a `ProjectMember` row on the
team's project, which is how someone working a project reaches its rooms; an
organisation owner or admin; or a `systemManaged` team, one of the two
exceptions named above (the standalone-channel root, the Personal Assistant's
team), which has no members by construction. A missing team context is a 400
`CHANNEL_TEAM_CONTEXT_REQUIRED` — never a default team id filled in on the
caller's behalf.

The same shape governs minting a call link for a named team: a link for a
*named team* (`POST /api/meetings/links`, the PA's `meeting_link_create`)
requires `TeamMember` (`entitlement: 'team_member'`), because the caller named
the team directly, while a call started from a channel
(`call_start`/`startCallForUser`) is entitled by channel membership
(`entitlement: 'channel_member'`) instead — a public channel's members are not
necessarily in its team, so requiring `TeamMember` there would refuse calls the
channel route allows. `createCallLinkForTeamUser` takes the caller's own
`organizationId` and refuses a team outside it the same way a missing team
does: see [docs/standards/calls.md](calls.md).

## Changing what UOA owns, from inside Nessie

"UOA is the authority" is a rule about **where the value is stored**, not about
where a person is allowed to stand when they change it. Refusing the edit was
never the invariant; writing a second copy was. So a team's name and its
company picture are both changed from `/settings/team` → Profile, and both
writes are relayed to UOA and then mirrored from the record UOA echoes back —
never written locally and hoped for. Two consequences, both load-bearing:

- **The mirror is written from UOA's response, not from the request.** UOA
  normalizes what it accepted, so mirroring the echoed value is what makes the
  two agree by construction. A refusal or an outage upstream must change
  nothing locally, or the next `syncExternalTeamNames` silently reverts it
  and the rename looks like it worked for one page load.
- **Both rows carry the label.** `createTeamEnvironment` names the Team and
  the Project it fabricates identically, so a rename heals both through
  `mirrorExternalTeamName` — the same function the directory sync uses.

### Creation, renames, and the unbound install

**Creating** an organisation or team happens in-app against UOA's org API
rather than by redirecting a person into its chooser for a second interactive
login; the local rows are still born only in `materializeUoaTeam`, from what
the silent switch grant proved
([docs/plans/2026-09-02-in-app-organisation-creation.md](../plans/2026-09-02-in-app-organisation-creation.md)).
The org name is UOA's mirror, so a **rename is a relayed
`PUT /org/organisations/:orgId` write**. An install with no IdP keeps one
unbound organisation (`externalOrgId` null). Budgets, policies, audit, the
member directory, and org settings all scope per UOA organisation
([docs/plans/2026-08-15-uoa-org-tenancy.md](../plans/2026-08-15-uoa-org-tenancy.md)).
The standing gap between this and "no duplicated data at all" — three local
membership tables against UOA's two, a Project level UOA has no concept of,
and the delta/revocation machinery UOA still lacks — is mapped in
[docs/plans/2026-09-02-uoa-as-a-service-unification.md](../plans/2026-09-02-uoa-as-a-service-unification.md).

### Which UOA route family, and why it is not a detail

UOA exposes two, and picking the wrong one fails for exactly the tenants who
matter most:

- **`/domain/*`** — domain-hash bearer alone, no acting person. It is scoped to
  organisations that were **created on** the calling product's domain, so an
  organisation founded on another UOA-integrated domain answers the generic
  `404` for every method. This is why the team avatar rendered as initials
  in settings while the sidebar showed the team's real SSO icon (the
  sidebar falls back to UOA's public, unscoped team image), and why an upload
  could not override that icon at all.
- **`/org/*`** — the same domain hash plus a short-lived product-signed
  assertion of the signed-in person (`withUoaRosterSubjectAssertion`). UOA
  re-resolves that person's live membership and capability, and the
  organisation's origin domain is deliberately not a predicate. This is the path
  for anything about the team the session is standing in.

An assertion is pinned to the **organisation** it names, not the team.
`withUoaRosterSubjectAssertion`
([packages/team-admin/src/uoa-org-roster.ts](../../packages/team-admin/src/uoa-org-roster.ts))
compares `active.orgId` to the route's `:orgId`, and
separately requires `active.teamId` to be one of the caller's *live* teams in
that organisation; the route's own `:teamId` is deliberately not compared, and
UOA's contract says why — "the active team is caller provenance, not authority
for a requested team". So `/org/*` **can** reach another team in the same
organisation, and a service handling one must resolve the actor's capability
for that exact target rather than trusting the provenance field.

*(This paragraph previously said the opposite — that an assertion was pinned to
the team it names and `/org/*` could only ever reach the current team. That was
never true of the code, and reading it as true is what would push a
same-organisation read onto `/domain/*` unnecessarily.)*

Reads of a team in *another organisation* still stay on `/domain/*`, backstopped
by UOA's public team image. `/domain/*` keeps its local owner/admin backstop
because it has no acting-person assertion. The
**Organization** section is different: Nessie declares
`nessie.organisation.manage` in its signed UOA config, gives that capability to
the configured organisation-admin role, and reads the caller's fresh
`GET /org/me` role before showing or serving that section. UOA's `owner` role
holds every declared capability structurally. A local `OrganizationMember` row
is intended to retain only Nessie-owned linkage or extension data. The current
authentication path still reads its role and activation fields, so those fields
remain a migration gap and a second authority until the live boundary below
replaces them. A failed live role read answers retryably and fails closed.

### Who may ask, and who authorizes it

The relay admits an authenticated caller with a current UOA subject assertion;
**UOA authorizes the exact target**. It re-resolves the person's live
membership and capability for every write, so a demoted or removed
administrator stops being able to change membership upstream even if a local
row still says otherwise. A team administrator need not have an
organisation-admin role, so `requireOrgAdmin` must not gate team membership
routes. Roster reads remain available to people entitled by UOA to see that
team.

The organisation-wide Members section is distinct: its declared
`nessie.organisation.manage` capability is checked from fresh `GET /org/me`
standing before its roster or mutations run. Neither path may relay with only a
domain-hash bearer, because that would replace UOA's live authorization with a
local membership decision.

### The current durable projection is a migration gap

`OrganizationMember`, `TeamMember` and UOA-derived `ProjectMember` rows currently
copy UOA claims. `authenticateRequest` re-resolves the acting role from the
durable `OrganizationMember` row, making that copy an enforcement authority.
Session-time reconciliation narrows the gap but does not make the copy an
acceptable cache:

- Every session rotation carries a verified team directory, and
  `reconcileUoaMembershipProjection`
  ([api/src/services/uoa-roles.ts](../../api/src/services/uoa-roles.ts)) removes
  each UOA-bound `TeamMember` row that directory no longer asserts, then
  deactivates an `OrganizationMember` for a bound organisation UOA no longer
  places the person in at all. Deactivation keeps the row and its history, and
  `ensureTeamMemberships` clears it again the moment UOA re-asserts a team
  there — in a bound organisation `deactivatedAt` is copied UOA state too.
- In a UOA-bound organisation, a session whose `OrganizationMember` row is gone
  is refused (`ORGANIZATION_MEMBERSHIP_REQUIRED`) rather than passed through:
  every session there was minted from a proven UOA membership, so an absent row
  means the membership was withdrawn. An unbound organisation keeps the
  pass-through, because a local install legitimately holds sessions with no row.
- Rows with no binding are never reconciled: a `Team` with no `externalTeamId`
  and an `Organization` with no `externalOrgId` have no upstream authority to be
  reconciled against.

The target state removes these UOA-owned roles and memberships from durable
authorization. Bound-tenant consumers call one UOA API-backed boundary and may
reuse a result only in bounded process memory with a short freshness deadline,
credential-epoch scoping and prompt invalidation. No webhook, snapshot or delta
materialises a durable member or hierarchy projection. Stable UOA references
and Nessie-owned extension data may remain; the no-IdP organisation keeps its
local membership model.

### Live entitlement readers

Disclosure, memory recall and agent-edit checks resolve one fresh `GET /org/me`
response through `@nessie/runtime` at their boundary. The response's exact
`org_id`, active `teams` and role are translated to existing local IDs only for
that decision; `team_directory`, retained membership rows and session context
are not authority. A UOA-bound read without a current request identity fails
closed, except for an intentional background recheck of the same user's linked
subject and epoch. The result is bound to that local user and organisation and
is never a reusable authorization token or a roster/profile write.

### Which door creates a team, and who may write membership locally

"Is UOA the authority here?" is answered by **the acting tenant's binding** —
`Organization.externalOrgId`, and `Team.externalTeamId` for a team write — never
by the deployment's `config.mode`. A `mode: 'local'` install with an enabled
`uoa` provider is a full UOA deployment, and a `selfHosted` install with no
providers is the unbound org-tenant that keeps local control; the mode says
neither. `requireUnboundMembershipManagement`
([api/src/routes/membership-mode-gate.ts](../../api/src/routes/membership-mode-gate.ts))
is that predicate, and local role changes, deactivation, local account creation
and local team-member writes all sit behind it.

The same rule decides who may create a team. `POST /api/teams` and the
`team_create` agent tool write a purely local `Team`, so inside a UOA-bound
organisation they refuse with `403 TEAM_CREATION_OWNED_BY_IDP` and name the door
that relays, `POST /api/teams/teams`. A team is a UOA team; a locally created
one there would be a level of the hierarchy UOA has never heard of, holding
`TeamMember` rows nothing upstream authorized.

## What Nessie must not store

UOA owns identity and the organisation/team hierarchy, so Nessie keeps no second
copy of it: no local authority over an organisation's or team's name and
no second authority over who is in which team. That is the target, not a
description of today — `OrganizationMember`, `TeamMember` and `ProjectMember`
all still exist and are re-projected from UOA's claims rather than derived live,
and profile and team names are still mirrored locally. The binding keys (`Organization.externalOrgId`,
`Team.externalTeamId`, `User.uoaSub`) are not duplication — they are what
makes asking UOA possible. That rule, and the outstanding gaps against it, are
in the plan linked above.

The first identity-read migration slice is deliberately narrower than that
target. In a UOA-bound organisation, legacy `GET /api/users` now reads the live
ACTIVE UOA organisation roster through the current actor's subject assertion,
paginates it to completion, and joins only product-owned fields by
`User.uoaSub`. Its 30-second in-memory display cache is scoped by organisation,
actor, active team and credential epoch; it has entry and total-member bounds,
coalesces same-key misses under a bounded in-flight set, prevents invalidated
loads from refilling it, never serves expired data after an upstream failure,
and is never an authorization input. A missing legacy subject binding is a migration error,
never an email/name join. The unbound organisation retains the local route.
Other renderers and authorization checks still read the mirrors/projections
named above, so this slice does not complete the authority migration; the
audited sequence and upstream blockers are recorded in the unification plan.

### Nessie policy may decide placement; UOA still authorizes it

There is exactly one place where a Nessie-side rule causes someone to join a
team: **automatic team access by DNS-verified email domain**
([docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md](../plans/2026-09-04-automatic-team-membership-by-verified-domain.md)).
It does not contradict the rule above, and the distinction is the whole reason
it is allowed to exist:

- Nessie holds the **policy** — which domain, proven how, placing people into
  which teams, audited here.
- UOA holds the **membership and its authorization**. Every grant is a relay to
  `addTeamMember` carrying a fresh, 60-second org-scoped subject assertion for
  the administrator who authorized the rule, so UOA re-resolves that person's
  live organisation membership and role before every write. A demoted or removed
  administrator's rule stops granting upstream, without Nessie noticing first.

Two consequences bind any future change here. **Backend mode is not an option**:
the subject assertion is the *entire* authorization of `POST /api/team/members`
— the local owner/admin gate in front of it (§"Who may ask, and who authorizes
it") is a consistency check on who may ask, not a substitute — so relaying with
the domain-hash bearer alone would remove the real check and rebuild a weaker
one on the durable `TeamMember` copy this document requires the migration to
remove.
The automatic-membership grants do not pass through that route at all: they call
`addTeamMember` directly with the authorizing administrator's own assertion.
And **no automatic path may name a role or remove a membership**: membership is
read first and the add is skipped when the person is already there, so a team
owner is never demoted, and narrowing or disabling a rule stops future grants
and nothing else.
