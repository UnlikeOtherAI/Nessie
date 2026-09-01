# Identity, belonging, and workspace switching — audit (2026-08-31)

> **Status:** audit complete; F1 landed on 2026-08-31. Three independent passes over the
> tree at `0f8d9c41` (main): this document's author, a Kimix run, and a Codex
> Sol run, each auditing the same brief; every external claim was re-verified
> against the code before being folded in (§6). Builds on
> [2026-08-14-uoa-sso-gap-analysis.md](2026-08-14-uoa-sso-gap-analysis.md) and
> [2026-08-15-uoa-org-tenancy.md](2026-08-15-uoa-org-tenancy.md) — settled
> findings from those documents are referenced, not repeated. Unlike those
> documents, this audit also reads the **UOA side** (the
> `UnlikeOtherAuthenticator` checkout at commit `705e0b8`, 2026-08-20), because
> the reported bug cannot be diagnosed from Nessie alone. UOA citations are
> prefixed `UOA:`.

## The brief

UOA is the sole authority for identity and membership. One UOA organisation =
one Nessie `Organization` (`externalOrgId`, unique); one UOA workspace (= team)
= one Nessie `Team` (`externalWorkspaceId`, unique). Audit how belonging is
represented, established at login, enumerated by the workspace switcher, and
changed by join/invite/switch — and diagnose a concrete reported bug:

> **The reported bug.** User A (the owner) sees workspace W in their switcher.
> User B's email address is "in" W as far as A can see — yet when B signs in
> via SSO, B cannot see W at all.

## 1. How belonging actually works today

### 1.1 The data model

| Fact | Where | Authority |
|---|---|---|
| Person | `User.uoaSub` unique nullable ([schema.prisma:853](../../api/prisma/schema.prisma)) — the principal key on the UOA path; `email` unique, adoption bridge only | UOA |
| Organisation | `Organization.externalOrgId` unique nullable ([schema.prisma:1039](../../api/prisma/schema.prisma)); `name` a non-authoritative mirror healed by `syncExternalOrganizationNames` | UOA |
| Workspace | `Team.externalWorkspaceId` unique + `externalOrgId` ([schema.prisma:1379-1380](../../api/prisma/schema.prisma)); one workspace = Project + Team + `#general` | UOA |
| Membership | `OrganizationMember` / `ProjectMember` / `TeamMember` rows — a **create-only projection** of the verified `org.org_role` / `org.team_roles[workspaceId]` claims ([workspace-principal.ts:146-175](../../api/src/services/workspace-principal.ts), [uoa-roles.ts:170-198](../../api/src/services/uoa-roles.ts)) | UOA (projected) |
| Credential | `UoaSessionCredential` (encrypted refresh material), `ProductAccountLink` per org with `uoaSub`/`uoaTokenVersion`/`activeOrgId`/`activeTeamId` | Nessie (permitted retention) |

### 1.2 Login establishes exactly one workspace

`POST /api/auth/session` → `exchangeUoaSession`
([uoa-session.ts:257-305](../../api/src/services/uoa-session.ts)) decodes the
UOA access token's `org` claim (single org: `org_id`, `org_role`, `teams[]`,
`team_roles{}`) and `active {orgId, teamId}`
([uoa-session.ts:104-139](../../api/src/services/uoa-session.ts)).
`resolveExternalWorkspaceSelection` picks `active.teamId`, falling back to the
sole team when UOA skipped the chooser
([identity-display.ts:42-50](../../api/src/services/identity-display.ts)). A
token with no resolvable org+team is **refused** — "incomplete session proof"
([uoa-session.ts:193-203](../../api/src/services/uoa-session.ts)), surfaced as
`EXTERNAL_AUTH_FAILED` ([auth-login.ts:151](../../api/src/routes/auth-login.ts)).

`resolveUoaWorkspaceContext`
([workspace-context.ts:286-325](../../api/src/services/workspace-context.ts))
then materializes **only that one workspace**: the per-UOA-org `Organization`
under an advisory lock, the Team by `externalWorkspaceId`, and the caller's
membership rows via `ensureWorkspacePrincipal` (subject-first, one-time email
adoption, `409 UOA_IDENTITY_CONFLICT` on a bound row —
[workspace-principal.ts:71-123](../../api/src/services/workspace-principal.ts)).
Every other workspace the person belongs to exists locally only after they
first enter it (login or switch). That is by design: local rows are a
projection, not a directory.

### 1.3 The switcher is fed by UOA's `/org/me` — and only opportunistically

There is no `/api/workspaces` route. The switcher list is
`GET /api/auth/me` → `loadUoaWorkspaceDirectory`
([auth.ts:240-253](../../api/src/services/auth.ts)):

1. **Primary:** a per-process in-memory LRU (30-min TTL, 10k users —
   [uoa-directory-cache.ts:22-26](../../api/src/services/uoa-directory-cache.ts)),
   written wherever `fetchUoaWorkspaceDirectory` succeeds: login
   ([integrations.ts:153](../../api/src/services/integrations.ts)) and every
   token rotation
   ([uoa-session-context.ts:292](../../api/src/services/uoa-session-context.ts)).
   The fetch itself is `GET /org/me` with the fresh access token and returns
   `undefined` on **any** failure — non-OK, timeout, parse error — with no log
   and no caller escalation
   ([uoa-workspace-directory.ts:96-120](../../api/src/services/uoa-workspace-directory.ts)).
2. **Fallback (cold cache):** `deriveUoaWorkspaceDirectoryFromTeams` — the
   user's own local `TeamMember` rows joined to the Team↔UOA mapping
   ([uoa-directory-cache.ts:93-120](../../api/src/services/uoa-directory-cache.ts)).
   Its own docblock names the consequence: a workspace never opened in Nessie
   has no local row and disappears.
3. **Client fallback:** if `uoaWorkspaces` comes back empty/undefined, the
   client silently renders the local membership tree instead
   ([workspaces.ts:22-57](../../admin/src/lib/workspaces.ts)) — entries that
   are not UOA-switchable (selecting one calls the local
   `POST /api/auth/switch-context`, which correctly refuses any team not
   matching the session's proven UOA workspace,
   `409 SSO_WORKSPACE_REAUTH_REQUIRED` —
   [auth-security.ts:224-239](../../api/src/routes/auth-security.ts)).

**What UOA actually returns.** `/org/me` builds `org.workspaces` from the
user's **ACTIVE `TeamMember` rows** — nothing else — scoped to orgs whose
origin domain is the product's (plus cross-product orgs when the domain's
workspace policy is `all_active_memberships`)
(UOA: `workspace-directory.service.ts:83-138` `buildSidebarWorkspaces`;
route `org/me.ts:113-121`). It **also** returns `pending_invites[]` — the
caller's eligible unaccepted invitations, added expressly for product sidebars
(UOA design §11.4). **Nessie parses only `org.workspaces` and silently drops
`pending_invites`**
([uoa-workspace-directory.ts:56-82](../../api/src/services/uoa-workspace-directory.ts)).

So the complete answer to "which workspaces can this user see":
**the workspaces where UOA holds an ACTIVE team-membership row for that user's
UOA account — as of the last successful, silently-optional `/org/me` read on
this process.** An email address appearing in a workspace's invitation list is
*not* membership and produces nothing in B's directory.

### 1.4 Switching

Selecting a UOA workspace calls `POST /api/auth/uoa/workspace`
([auth-uoa-workspace.ts:48-161](../../api/src/routes/auth-uoa-workspace.ts)):
pre-flight exact-target entitlement confirm against UOA
([uoa-workspace-switch.ts:52-74](../../api/src/services/uoa-workspace-switch.ts)),
the `workspace-switch` refresh grant with exact-target response validation
([uoa-session.ts:335-445](../../api/src/services/uoa-session.ts)), then
materialization of the target org/team/memberships identical to a login
([uoa-workspace-switch.ts:86-200](../../api/src/services/uoa-workspace-switch.ts)).
A refused switch classifies to a `teamHint`-targeted SSO reauthorization
without touching the session
([WorkspaceSwitcher.tsx:246-316](../../admin/src/layouts/admin-shell/WorkspaceSwitcher.tsx)).
This machinery matches the gap analysis rows 2a–2d and is **not** implicated
in the bug — notably, it never consults the directory, so a workspace that
*rendered* would switch fine.

### 1.5 Join / invite / roster

Rosters and invitations are live UOA relays, nothing persisted
([workspace-members.ts](../../api/src/routes/workspace-members.ts),
[uoa-org-roster.ts](../../packages/workspace-admin/src/uoa-org-roster.ts)): the
roster is the join of the UOA team-member list (subjects + team roles) with
the org-member list (identity), so it shows **actual team members only**; the
Members page additionally renders a "Pending invitations" section with status,
approval state, and expiry
([WorkspaceMembersSection.tsx:186-211,469](../../admin/src/pages/settings/WorkspaceMembersSection.tsx)).
There is no join endpoint: joining *is* logging in or switching into the
workspace, after UOA acceptance. Acceptance itself is hosted by UOA; Nessie
mints no invitation tokens. Known leftovers from gap-analysis phase 5 stand:
`GET /api/users` still answers from local rows, and the local membership
mutators are mode-gated rather than removed.

## 2. The reported bug — root cause

### 2.1 The structural cause chain

The bug is exactly what §1.3's closing sentence predicts: **B's UOA account
has no ACTIVE team-membership row in W. His email is in W only as an
invitation (or as a stale local row from the pre-SSO era), and neither of
those ever reaches his switcher.** Three independently verified facts complete
the chain — the first two are UOA-side, the third is Nessie's:

1. **UOA enforces one active organisation per user per *origin domain*.**
   Both invitation-acceptance paths refuse — with a bare, unexplained
   `400 BAD_REQUEST` — when the accepting user already holds an org membership
   in a *different* organisation whose origin domain matches the invite's
   (UOA: `team-invite.service.acceptance.ts:119-134`;
   `team-invite-link.service.ts:382-395` names it: *"one-org-per-ORIGIN-domain"*;
   invariant reaffirmed in UOA commit `b747660`, 2026-08-17).
2. **Nessie's SSO config invites users to create their own organisation.**
   The config JWT sets `allow_user_create_org: true` and
   `workspace_selection: 'auto'`
   ([uoa-auth.ts:244-271](../../api/src/services/uoa-auth.ts)); `user_needs_team`
   auto-placement is *not* enabled, so the trap needs one user action: a person
   who signs in without going through their invite (or before it existed) is
   offered "create workspace" by UOA's chooser and naturally takes it.
3. **Nessie renders no trace of a pending invitation.** `/org/me` delivers
   `pending_invites` precisely so the product can surface them; Nessie's
   parser drops the field (§1.3), and no other surface reads UOA invitations
   from the invitee's side. After login, the only doorway back to UOA's
   chooser — the one place an eligible invite is offered — is the switcher's
   "Add workspace" button
   ([WorkspaceSwitcher.tsx:318](../../admin/src/layouts/admin-shell/WorkspaceSwitcher.tsx)),
   which nothing prompts B to press.

Put together, the most probable concrete sequence for B:

- B signs in at the Nessie login page (not via the invite email). UOA's
  chooser shows "create workspace" (and the invite, if it was already sent and
  eligible — see §2.2). B creates or already owns **his own organisation on
  the Nessie origin domain**.
- From that moment, **acceptance of A's invitation is structurally impossible**
  — the one-org-per-origin-domain refusal fires on the invite email link and
  on the chooser alike, as a bare 400 with no error code.
- B's `/org/me` truthfully lists only his own workspace. Nessie shows him no
  pending invite, no error, no explanation. A, meanwhile, sees W (they are an
  ACTIVE member) and sees B's email under "Pending invitations" — or in an
  even older variant, in local rows from before the SSO migration.

The bug is therefore **not** in Nessie's switch/session plumbing (verified
correct, §1.4), and Kimix's refuted-suspects list is confirmed: provisioning
is not first-login-only, roles are claim-projected, the org/team claim is
persisted. It is a *belonging* fact plus a *visibility* hole: UOA never made B
a member, and Nessie never told anyone.

### 2.2 Sub-variants the production data will distinguish

All of these produce the identical symptom; distinguishing them is one query
each against the UOA database:

| Check (UOA DB) | Variant it confirms |
|---|---|
| `team_invites` rows for B's email in W: `accepted_at`/`declined_at`/`revoked_at`+`revoked_reason`/`approval_status`/`expires_at` | Pending vs expired (30-day TTL) vs revoked/superseded vs awaiting member-invite approval (`PENDING` is invisible to the invitee — UOA: `first-login.service.ts:32-45`) |
| `org_members` for B's user id where `org.domain` = Nessie's origin domain | The one-org-per-origin-domain trap (B owns his own org) — the primary suspect |
| `team_members` for (B's user id, W's team id) + `status` | B actually *is* a member → the bug is instead Nessie's silent directory degradation (§3, F3) — then check `/org/me` live for B's token |
| B's `users.email` vs the invited address | Email-mismatch: acceptance requires exact (case-insensitive) equality (UOA: `team-invite.service.acceptance.ts:98-100`) |
| Nessie `users.uoa_sub` for B's email; `team_members` locally | Pre-SSO local row variant: A "sees" B via legacy local data, UOA never involved |
| Nessie `organization_members.deactivated_at` for B in W's local org | Legacy local deactivation: issuance refuses a session in that org even for a valid UOA member, and nothing ever clears the flag (F4) |

One diagnostic fork settles it: **if B reaches `/channels` at all, he holds
*some* workspace** (login refuses tokens without one, §1.2) — and if that
workspace is his own org on the Nessie domain, the trap is confirmed without
further evidence.

### 2.3 Why the cache theory is secondary

The Kimix pass (§6) pinned the root cause on the directory cache: per-process,
30-minute TTL, silent-failure fetch, and a local-rows fallback that only knows
workspaces the user already opened. Those defects are real (F3 below) and
produce this *symptom class* — but for this bug they require `/org/me` to have
failed for B on the very process that just logged him in (login writes the
cache in the same request path,
[integrations.ts:153](../../api/src/services/integrations.ts)), and production
runs a single API container
([docker-compose.prod.yml](../../infrastructure/compose/docker-compose.prod.yml)),
so there is no other-replica window. More decisively: the cache can only hide
a workspace UOA *would have listed* — and UOA lists only ACTIVE members, which
an invited-but-never-accepted email is not. The membership fact explains the
asymmetry with no failure assumption; the cache explains it only with one.

## 3. Findings — ranked

**F1 — Pending invitations are invisible in Nessie (high; the bug's visibility
half).** UOA hands the invitee's eligible invitations to Nessie on every
`/org/me` read; the parser drops them
([uoa-workspace-directory.ts:56-82](../../api/src/services/uoa-workspace-directory.ts)).
No surface renders "you have been invited to W" and no in-product path leads
to acceptance (rule zero: the capability exists upstream, no person can reach
it from here). The invitee's only doorways are the invite email and the
unprompted "Add workspace" button.

**Fixed 2026-08-31.** Nessie now parses verified `pending_invites`, reconciles
them into durable user alerts, and exposes acceptance from both the workspace
switcher and alert surfaces. Acceptance is relayed to UOA's new backend-mode
endpoint and, on success, uses the existing UOA workspace switch path. UOA's
named `ORG_CONFLICT_ON_DOMAIN` refusal is surfaced as an actionable conflict.

**F2 — Invitation acceptance can be structurally impossible (high; the bug's
belonging half; UOA-side, product decision needed).**
The one-org-per-origin-domain invariant makes an invite to a second
Nessie-domain org permanently unacceptable — refused as a bare 400 with no
code — for anyone who already runs their own org on the domain, which Nessie's
own `allow_user_create_org: true` encourages (UOA:
`team-invite.service.acceptance.ts:119-134`,
`team-invite-link.service.ts:382-395`;
[uoa-auth.ts:244-271](../../api/src/services/uoa-auth.ts)). The inviter is
never told either — the invitation just sits "pending" forever in the Members
page. Whether the invariant should bend (multi-org membership per domain) or
the refusal should become a first-class, named, surfaced state is a UOA
product decision. The 2026-08-31 acceptance relay mitigates the invitee-side
"fails mute" half: UOA now names this refusal `ORG_CONFLICT_ON_DOMAIN`, and
Nessie explains it in place. The inviter-side pending row still carries no
terminal reason, so the underlying product decision remains open.

**F3 — The switcher degrades silently, in both directions (medium-high).**
Four compounding behaviours, all invisible to the user:
(a) the `/org/me` fetch is "opportunistic" — any failure returns `undefined`
with no log ([uoa-workspace-directory.ts:114-120](../../api/src/services/uoa-workspace-directory.ts));
(b) on failure the last verified copy is served for up to the process
lifetime, and a cold cache falls back to local `TeamMember` rows, which
*understate* (workspaces never opened here are missing) and *overstate*
(rows are never deleted — see F4 — so removed workspaces linger)
([uoa-directory-cache.ts:40-47,93-120](../../api/src/services/uoa-directory-cache.ts));
(c) a verified-*empty* directory and a context-less `{ok:true}` response both
parse to `[]`, are cached as truth for 30 minutes, and cause the client to
silently swap in the local membership tree
([auth.ts:246-252](../../api/src/services/auth.ts),
[workspaces.ts:22](../../admin/src/lib/workspaces.ts));
(d) there is no on-demand refresh — a directory staler than the last rotation
cannot be corrected by the user. No stale/degraded marker exists anywhere.

**F4 — UOA membership removals and deactivations never reach the local
projection (medium-high; known-open).** Membership upserts are create-only and
role projection only updates roles
([workspace-principal.ts:146-175](../../api/src/services/workspace-principal.ts));
`removeWorkspaceMember`/`setWorkspaceMemberActivation` mutate UOA only
([uoa-org-roster.ts:338-368](../../packages/workspace-admin/src/uoa-org-roster.ts));
the sole writer of `OrganizationMember.deactivatedAt` is the local-mode
mutator ([users.ts:174](../../api/src/services/users.ts)). Consequences: the
fallback directory and `me.memberships` show workspaces the person was removed
from (rescued only by UOA's refusal at switch time); every local read that
gates on `deactivatedAt: null` (agent ownership, comms-sync owner gate, PA
`resolveActingMember`) treats a UOA-deactivated person as active until their
session dies; and a locally-deactivated row can contradict UOA with no repair
surface. The tenancy doc lists this as an open follow-up
([2026-08-15-uoa-org-tenancy.md](2026-08-15-uoa-org-tenancy.md) → "Deactivation
across organisations"); it is the "second local copy of membership" class.

Two verified corollaries from the Sol pass sharpen the impact:

- **The inverse block.** Session issuance requires a live local membership
  (`deactivatedAt: null`) in the login's organisation
  ([refresh-token-issuance.ts:77-96](../../api/src/services/refresh-token-issuance.ts)),
  and nothing on the UOA path ever *clears* `deactivatedAt` (upserts are
  `update: {}`; the projection touches roles only). A row deactivated in the
  local era therefore blocks a perfectly valid UOA member from ever entering
  that organisation again — silently, and with no repair surface outside
  `local` mode. This is a data-dependent alternative diagnosis for the
  reported bug (§2.2, last row).
- **The revocation lag.** A UOA removal/deactivation initiated through
  Nessie's own Members page relays to UOA and returns — it invalidates no
  local session, cache entry, or membership row. The removed person's access
  token keeps authorizing (the local `deactivatedAt` gate never fires for a
  UOA-side deactivation) until it expires and the UOA refresh refuses on the
  bumped credential epoch — bounded, but a window in which Nessie-local
  authority outlives UOA's decision. Backend-mode roster mutations make this
  sharper: UOA applies no acting-user check of its own there, so the local
  owner/admin gate — read from the possibly-stale local row — is the only
  authorization on the mutation
  ([uoa-org-roster.ts:26-44](../../packages/workspace-admin/src/uoa-org-roster.ts)).

**F5 — `ProductAccountLink.metadata` durably persists UOA claim data
(medium).** Every login writes `teamIds`, `teamRoles`, and `orgRole` into the
link's JSON ([integrations.ts:36-48](../../api/src/services/integrations.ts)),
and the switch-recovery path writes the whole `workspaceDirectory` back into
metadata ([uoa-recovery-link.ts:115-118,143-146](../../api/src/services/uoa-recovery-link.ts))
— re-persisting exactly what migration
`20260815120000_drop_uoa_workspace_directory_mirror` deleted. Nothing reads
these keys (roles project from the live token); they are a dormant durable
mirror of UOA-owned membership data, violating the phase-6 decision.

**F6 — A multi-workspace token without an `active` claim is refused with a
generic error (low-medium, edge).** If UOA ever returns a token with ≥2
`org.teams` and no `active.teamId`, selection resolves null and login fails as
`EXTERNAL_AUTH_FAILED` ([identity-display.ts:42-50](../../api/src/services/identity-display.ts),
[uoa-session.ts:193-203](../../api/src/services/uoa-session.ts)). Under
`workspace_selection: 'auto'` UOA presents the chooser for 2+ teams, so this
should not occur — but if it does, the remedy (re-enter SSO with the chooser)
is not what the error says or does.

**F7 — Workspace/organisation display names heal asymmetrically (low).**
Materialized teams are named `Workspace <id8>` and never renamed from the
directory label; only org names heal
([workspace-target.ts:24-25,78-90](../../api/src/services/workspace-target.ts),
[external-organization.ts:75](../../api/src/services/external-organization.ts)).
Visible wherever the local name renders — the fallback directory and every
local team surface.

**F8 — Owner-facing belonging reads still local (low-medium, known-open).**
`GET /api/users` lists local `OrganizationMember` rows — under UOA an
incomplete projection (only people who have logged in) that disagrees with the
roster for the same workspace; project-member reads and `me.memberships` are
the same class ([users.ts:45-57](../../api/src/routes/users.ts),
[projects.ts:101](../../api/src/routes/projects.ts),
[auth.ts:92-139](../../api/src/services/auth.ts) — no `deactivatedAt` filter).
Gap-analysis phase 5 leftover, restated here because it is specifically a
*belonging* read.

**F9 — Local org/workspace structure can be forked beside UOA's
(medium-high).** The membership mutators are mode-gated, but the *structural*
ones are not: `POST /api/projects` and `POST /api/teams` (owner-gated only)
create local projects and unbound local teams inside a UOA-bound organisation
([projects.ts:136-139](../../api/src/routes/projects.ts),
[teams.ts:66-69](../../api/src/routes/teams.ts)), and
`PATCH /api/organizations/current` can overwrite the mirrored org name
([organizations.ts:51](../../api/src/routes/organizations.ts)). Every unbound
team is a workspace UOA does not know — a second hierarchy of exactly the kind
the tenancy invariant forbids, and each one pollutes the fallback directory
and `me.memberships`.

**F10 — `GET /api/teams` enumerates every workspace in the organisation to any
member (medium).** The list is filtered only by
`project.organizationId` + `systemManaged: false` — no per-team membership or
entitlement condition — and returns names plus member counts
([teams.ts:34-51](../../api/src/routes/teams.ts)). Under per-UOA-org tenancy
that means any member of any workspace can enumerate the organisation's other
workspaces, a visibility UOA's own directory (your ACTIVE memberships only)
does not grant. Rule-zero check 2: scope by entitlement, not ambient org.

**F11 — An absent `OrganizationMember` row fails open (medium, latent).**
Request authentication rejects a *present-and-deactivated* membership, but an
absent one passes through — deliberately, for system actors — and the actor
then keeps the roles baked into the (possibly stale) JWT
([server-context.ts:220-245](../../api/src/lib/server-context.ts)). A deleted
or never-created membership row therefore does not end a live session, and an
owner token retains owner gates until expiry. Latent today (no normal path
deletes the row in UOA mode), but it inverts the fail-closed direction every
other membership check takes.

**F12 — `User.email` is never re-synced from UOA (low-medium).** The profile
mirror re-syncs display name and avatar only
([uoa-profile-mirror.ts](../../api/src/services/uoa-profile-mirror.ts));
`email` stays unique, durable, and frozen at provisioning. When UOA reassigns
or changes an address, the stale local row keeps it — and a *new* UOA subject
later asserting that address fails login closed with `UOA_IDENTITY_CONFLICT`
([workspace-principal.ts:97-104](../../api/src/services/workspace-principal.ts)),
an operator-only dead end caused purely by the retained mirror.

**Ambiguity A1 — cross-product workspace policy.** `/org/me`'s directory is
origin-domain-scoped unless the domain's server-side policy is
`all_active_memberships` (UOA:
`workspace-directory.service.ts:110-137`). Whether Nessie's domain has that
policy is deployment data this audit cannot see; if it does not, workspaces in
orgs created via a *different* UOA product never appear in anyone's Nessie
switcher (symmetrically, so not the reported bug). Worth confirming with the
UOA deployment.

**Ambiguity A2 — main-checkout drift.** UOA facts were verified against the
`UnlikeOtherAuthenticator` main checkout (`705e0b8`, 2026-08-20), which is
ahead of what production may run; the invite worktrees beside it suggest
active movement in exactly this area. The one-org-per-origin-domain invariant
is reaffirmed as deliberate in commit `b747660` (2026-08-17), so it is treated
as current.

## 4. Recommended fixes

Ordered so the reported bug dies first. Landed recommendations are marked.

1. **Landed 2026-08-31 — parse and surface `pending_invites` (fixes F1, half
   of the bug).** `parseWorkspaceDirectory` carries verified invites through
   the cache and reconciles durable alerts. The switcher and alerts bell/page
   are two doorways into one shared acceptance action, which relays to UOA and
   then uses Nessie's existing UOA workspace switch. Rule zero check 1: the
   invitee's owning surface is the switcher; the bell and alerts page are the
   in-context attention doorways.
2. **Resolve the acceptance dead end with UOA (fixes F2, the other half).**
   Decision needed on the UOA side: either permit accepting into a second
   organisation on the same origin domain, or return a *named* refusal
   (`ORG_CONFLICT_ON_DOMAIN` or similar) that (a) UOA's chooser and acceptance
   page can explain, and (b) Nessie's invitation list can relay to the
   inviter ("cannot be accepted: invitee already belongs to another
   organisation"). Until then, document the constraint on the invite form.
3. **Make the directory read fail-visible and on-demand (fixes F3).** Model
   three states distinctly — verified non-empty, verified empty, unavailable —
   and never let a malformed 200 parse as verified-empty. Log `/org/me`
   failures; badge a stale/degraded switcher instead of silently swapping
   sources; add an on-demand refresh path. A backend-mode per-user directory
   read (the domain-hash-bearer pattern the roster already uses) would
   decouple this from token rotation — needs the UOA contract confirmed, as
   with gap-analysis ambiguity 2. Add the decisive regression: A and B share
   one UOA workspace, only A has local rows, and B's `/api/auth/me` still
   lists it across process restart, UOA 500, malformed 200, and verified
   empty.
4. **Reconcile removals and deactivation, both directions (fixes F4).** On
   every verified directory/claims arrival, remove (or tombstone) local
   `TeamMember` rows for UOA-linked teams the directory no longer lists;
   drive `deactivatedAt` for UOA orgs from the relayed deactivate/reactivate
   calls plus roster status on read — or stop consulting the local flag for
   UOA orgs entirely, mirroring the mode-gate pattern — and let a verified
   ACTIVE claim *clear* a legacy `deactivatedAt` so a valid UOA member is
   never permanently locked out by a local-era flag. A roster mutation made
   through Nessie should also invalidate the target's local sessions and
   cache entries rather than waiting out the token TTL.
5. **Purge claim data from link metadata (fixes F5).** Drop
   `teamIds`/`teamRoles`/`orgRole` from `uoaLinkMetadata`, delete the
   `workspaceDirectory` writes in `uoa-recovery-link.ts`, and extend the
   phase-6 migration to strip surviving keys.
6. **Heal team names from the directory** alongside org names (fixes F7).
7. **Name the multi-workspace refusal** (fixes F6): classify the no-`active`
   multi-team case into a response that relaunches SSO with the chooser
   forced, or at least says that is the remedy.
8. **Re-point `GET /api/users`** (and project-member reads) at the roster
   seam on UOA sessions (fixes F8; completes gap-analysis phase 5).
9. **Mode-gate structural mutations (fixes F9).** In UOA mode, refuse local
   creation/rename/deletion of `Organization`/`Project`/`Team` structure the
   way the membership mutators already refuse
   (`membership-mode-gate.ts` pattern), directing supported changes upstream.
10. **Entitlement-filter `GET /api/teams` (fixes F10)** to the caller's own
    memberships unless the caller is an owner/admin asking for the org view.
11. **Fail closed on an absent membership row for human bearers (fixes
    F11)** — keep the pass-through for system actors only, keyed on actor
    type rather than row absence.
12. **Decide `User.email`'s lifecycle (fixes F12):** either re-sync it from
    the verified claims like the rest of the mirror (keeping the conflict
    check on the subject), or drop its uniqueness once nothing keys on it —
    a written decision either way.

## 5. What is already right (verified, don't re-litigate)

- Subject-first principal keying with fail-closed conflicts; create-only
  membership upserts; claim-projected roles including the unrecognised-role
  refusal ([uoa-roles.ts:39-50](../../api/src/services/uoa-roles.ts)).
- Per-UOA-org tenancy resolution under advisory locks, first-materializer
  owner rules, default-policy seeding
  ([workspace-context.ts](../../api/src/services/workspace-context.ts)).
- The switch flow's layered exact-target validation and safe-refusal
  classification (§1.4), and `switch-context`'s UOA fence
  ([auth-security.ts:224-239](../../api/src/routes/auth-security.ts)).
- Rosters/invitations as live backend-mode relays keyed on the UOA subject,
  nothing persisted, owner/admin-gated locally (§1.5).

## 6. Multi-model reconciliation

Three independent audits of the same brief: this author (with UOA source
access), **Kimix**, and **Codex Sol** (both confined to the Nessie tree).
Every folded claim was re-verified against the code.

**Kimix** produced a well-grounded Nessie-side map that agrees with §1 in all
mechanics. Divergence: it pinned the root cause on the directory
cache/fallback asymmetry (F3) — the strongest conclusion available *without
the UOA source*, since `/org/me` is a black box from Nessie. Adjudication
(§2.3): F3 is real and folded as a finding, but demoted from root cause — it
presumes a fetch failure the single-container deployment makes unlikely, and
it cannot explain a workspace UOA itself does not list for B. Kimix's
refuted-suspects list (provisioning is not owner-only; claims are persisted;
roles are projections) was verified and adopted; its distinctive findings F5
(link-metadata claim persistence, including the recovery-path
`workspaceDirectory` re-write), F6 (no-`active` refusal), and F7 (frozen team
names) were verified line-by-line and folded; its fix list underlies
recommendations 3–8. Its observation that the switch machinery never consults
the directory ("B is blocked purely because the entry is never rendered") is
confirmed and load-bearing for recommendation 1.

**Codex Sol** reached the same root-cause theory as Kimix (the
cache/fallback path) — and, to its credit, stated the limit of that theory
itself: *"There is one runtime fact the repository cannot establish … or UOA
omitting B's entitlement"*, and *"if a valid `/org/me` response containing the
workspace reached Nessie, the switcher would list it."* The UOA-side reading
in §2 resolves exactly that unknown: UOA omits B's entitlement because an
invited email is not an ACTIVE membership — so Sol's root cause is demoted to
the F3 finding on the same grounds as Kimix's (§2.3). Its suspect-disposition
table otherwise matches Kimix and §1. Sol's distinctive contributions, each
re-verified line-by-line before folding: the issuance-side deactivation block
and the revocation lag (both now in F4), the structural-fork routes (F9), the
`/api/teams` enumeration (F10), the fail-open absent-membership check (F11),
the frozen `User.email` conflict path (F12), and the three-state directory
model plus the A/B regression flow (folded into recommendation 3). Two Sol
claims were adjusted in the folding: its "Critical" ranking for the
revocation lag is tempered to F4's medium-high because the exposure is
bounded by the access-token TTL and the UOA-epoch-checked refresh; and its
observation that the gap analysis "overstates completion" is recorded here as
the F4/F5 tension (a durable projection is still a durable copy) rather than
as a finding of its own.

**Where the three audits ended up.** All three agree on the mechanics of §1,
on the refuted suspects, and on the switcher's silent-degradation defects.
The disagreement was confined to which link in the chain is *the* root cause
of the reported bug: both externals, working from Nessie alone, chose the
cache/fallback path; this document, with the UOA source in evidence, pins the
membership/invitation trap (§2.1) and keeps the cache path as the co-factor
that removes every chance of the truth surfacing. The production checks in
§2.2 decide between them with one query.
