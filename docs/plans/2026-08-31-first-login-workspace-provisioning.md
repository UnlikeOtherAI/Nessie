# First-login workspace provisioning, self-serve team creation, and the end of local identity mirrors

**Status: DRAFT — pending Kimix + Codex Sol review.**

One sentence: a brand-new SSO user who signs in to Nessie with no UOA
workspaces gets an organisation and a first team (a *workspace*, in product
vocabulary) provisioned **in UOA** and mirrored 1:1 into Nessie; any signed-in
user can then create further teams, choosing whether the new team lives in an
existing organisation they belong to or in a new one; and Nessie stops
persisting the last duplicated identity fields (`users.email`,
`users.display_name`). UOA remains the sole authority for every piece of
this — Nessie only relays, projects, and renders.

## Why now

- Today a UOA access token with no resolvable org+team is **refused** as
  "incomplete session proof" (`uoa-session.ts`, surfaced as
  `EXTERNAL_AUTH_FAILED`) — a brand-new user who has never touched another
  UOA product cannot enter Nessie at all. (Verified in
  [2026-08-31-identity-belonging-audit.md](2026-08-31-identity-belonging-audit.md)
  §1.2.)
- The production databases are a green field being reset (2026-08-31 cleanup:
  all 20 UOA test organisations and all 8 Nessie tenant anchors removed,
  teleprompter users and DeepWater reports untouched). Whatever flow exists
  after the reset **is** the onboarding flow; there is no legacy population
  to migrate.
- UOA enforces **one active org membership per user per origin domain**
  (`team-invite.service.acceptance.ts`, named refusal `ORG_CONFLICT_ON_DOMAIN`
  since UOA `aa14af1`). The requested "create a new team in a NEW
  organisation" capability is impossible while that invariant stands in its
  current shape. Resolving it is a UOA-side design decision this plan owns.
- The identity-belonging audit (same file, §4) already recommends
  mode-gating local structural mutations (rec 9) and deciding `User.email`'s
  lifecycle (rec 12). This plan implements the upstream half those
  recommendations point at.

## Invariants that bound every part of this design

1. **UOA owns the org structure.** Every organisation and team is created in
   UOA first, by a UOA API call carrying the acting user's identity; Nessie
   materializes its 1:1 anchors (`Organization.externalOrgId`,
   `Team.externalWorkspaceId`) only from verified UOA state, exactly as login
   and workspace-switch materialization do today. No Nessie-side write ever
   creates org structure locally first "to be synced later".
2. **No duplicates.** No new mirror columns, no second directory, no cached
   copy promoted to authority. The existing bounded in-memory directory cache
   pattern (`uoa-directory-cache.ts`) is the only permitted retention.
3. **Provisioning is idempotent and race-safe.** Two concurrent first logins
   of the same user must converge on one org + one team, under the same
   advisory-lock discipline `resolveUoaWorkspaceContext` already uses.
4. **A capability is not done until a person can reach it** (rule zero).
   The team-creation flow ships with its admin surface (switcher +
   settings doorways) in the same change.
5. **Vocabulary:** UOA teams are rendered as **workspaces** in Nessie. The
   product never shows "team" and "workspace" as two different concepts.

## Part A — UOA: self-serve organisation + team lifecycle

Current state, verified 2026-08-31 in the UOA repo (file:line refs are UOA):

- **The chooser can already create a first workspace.** `POST
  /auth/create-workspace` (routes/auth/auth-create-workspace.ts:57-248)
  creates org + default "General" team and finalises login in one
  transaction, gated on `workspace_selection === 'auto'` +
  `org_features.allow_user_create_org` — both of which Nessie's config JWT
  already sends. A zero-workspace user signing into Nessie today lands on
  `WorkspaceChooserPage` with `CreateFirstWorkspaceForm` rendered inline.
  `POST /auth/create-team` (auth-create-team.ts:73-289) creates a further
  team in an existing org and adds the creator as team `admin`.
- **Two dormant auto-provisioning services exist**, both off by default
  (config-org-features.schema.ts:42-50): `ensureUserHasRequiredTeam`
  (`user_needs_team`; org named after the person, team "<name>'s team",
  team role `admin` — the service that produced the production "Martin
  Lexa's team" rows) and `placeUserInConfiguredOrganisation`
  (`auto_create_personal_org_on_first_login`; org "<name>'s organisation",
  team "General", team role `member`). Both run inside the auth flow only —
  never on `/org/me`.
- **Backend `/org/*` endpoints exist** behind the per-domain hash bearer:
  `POST /org/organisations` (user + backend modes) and
  `POST /org/organisations/:orgId/teams`. Known defects: the latter creates
  an **orphan team** (no creator membership, team.service.teams.ts:153-190);
  access-token calls are pinned to the token's own org
  (org-role-guard.ts:252-257), so cross-org creation needs re-scoping; and
  the five creation paths write five different role outcomes (§A5).
- **One ACTIVE org membership per (user, origin domain)** is enforced by a
  partial unique DB index (migration 20260730180000), the create service,
  invite acceptance (`ORG_CONFLICT_ON_DOMAIN`), and member-add. The invite
  probe ignores membership status (team-invite.service.acceptance.ts:119-130)
  — a tombstoned membership blocks acceptance forever (bug).
- **`/org/me` returns `{ ok: true }` with no `workspaces`/`pending_invites`
  at all for a zero-workspace user** (routes/org/me.ts:106,124-126) — a
  product cannot render an onboarding state from it.

### A1. First-login default provisioning — decision

Enable **automatic** creation for the Nessie domain rather than the manual
chooser form: the user's requirement is "we create an organisation and the
first team for them", not "we show them a form". Mechanism: turn on
`auto_create_personal_org_on_first_login` for the Nessie domain config
(org "<name>'s organisation", team "General"), keeping
`pending_invites_block_auto_create: true` so an invited user is never
forked into a personal org (the exact trap that motivated
`ORG_CONFLICT_ON_DOMAIN`). The chooser's inline create-first-workspace form
remains as the fallback when auto-create is off. `user_needs_team` stays
off — its silent org-role promotion (`member` → `admin`,
user-team-requirement.service.ts:167-175) is a privilege escalation we do
not want, and its "<name>'s team" naming loses to the standard "General".

### A2. Unify the creation paths' role outcomes

One rule everywhere: the creator of an organisation is org `owner` and
team-role `admin` on its default team; the creator of a team is team
`admin`. Today five paths write five different outcomes (public create
leaves the owner an implicit team `member`; the admin path writes team
`owner`; the two auto-provisioners write `admin`/`member`). Fix in the
services (`createOrganisation`, `createAdminOrganisation`,
`org-placement.service.ts`), not the routes. Also fix the orphan-team
defect: `createTeam` gains a `creatorMembership` option used by every
caller that acts for a person, so `POST /org/organisations/:orgId/teams`
stops minting member-less teams.

### A3. The one-org-per-domain invariant — decision

Keep the invariant as the **default**, make it a per-domain policy knob:
`org_features.max_active_orgs_per_user` (default 1 = today's index
semantics; Nessie sets it to unlimited/N). Rationale: the invariant exists
to stop accidental org sprawl and the invite/create fork, both real; but
the product requirement "create a new team in a new organisation" is
legitimate for a work platform. Implementation notes:
- The DB partial unique index only encodes N=1; for N>1 the enforcement
  moves to the create/accept/add services under the existing advisory
  locks (the index is dropped for domains configured >1 — a migration
  conditional on config is impossible, so the index is replaced by a
  service-layer check plus a domain-scoped constraint trigger, keeping the
  race-safety the index provided; exact mechanism is an implementation
  decision for review).
- Fix the invite-acceptance probe to filter ACTIVE (the tombstone bug)
  in the same change — under N=1 it is a correctness fix on its own.
- `creatable_orgs` / `can_create_org` in `/auth/session-choices` and the
  chooser dialog's "new organisation" branch
  (WorkspaceChooserPage.tsx:170,244) become policy-driven instead of
  hard-wired to "has nothing yet".

### A4. `/org/me` carries the onboarding state

For a zero-workspace user, `/org/me` returns `org` with empty
`workspaces[]`, any `pending_invites[]`, and a `can_create_org` flag,
instead of omitting the block. Nessie (and every product) can then render
a real onboarding state and the pending-invite alerts even before first
placement. Additive, contract-versioned change — existing consumers that
check for `org` presence keep working because the block is only added,
never reshaped.

### A5. Admin organisation lifecycle (shipped with the cleanup)

`DELETE /internal/admin/organisations/:orgId` (superuser-gated, reusing
`deleteOrganisation` with admin provenance, named
`ORG_HAS_PROTECTED_RECORDS` refusal for billing-anchored orgs) + the SPA
delete action. In flight 2026-08-31 (Codex Sol) to unblock the production
cleanup; listed here because it is also the missing admin half of the org
lifecycle this plan builds.

## Part B — Nessie: first-login flow and team creation UX

Current state, verified 2026-08-31 in this repo:

- A zero-workspace UOA token dies at the exchange itself:
  `exchangeUoaSession` refuses any token without a resolvable org **and**
  team (`api/src/services/uoa-session.ts:193-203`), and
  `api/src/routes/auth-login.ts:143-153` repeats the guard. Both surface as
  `401 EXTERNAL_AUTH_FAILED`. The "shared/default org" fallback in
  `workspace-context.ts:327-388` is reachable only by generic-OIDC providers
  and is dead code on the UOA path.
- Materialization is one reusable, race-safe implementation:
  `resolveUoaWorkspaceContext` (`workspace-context.ts:286-325`) under
  exact-tuple advisory locks (`external-organization.ts:28-40`,
  `workspace-target.ts:52-70`), creating Organization → Project + Team +
  `#general` (`workspace-target.ts:112-162`) and then memberships via
  `ensureWorkspacePrincipal` (`workspace-principal.ts:226-294`). Triggers:
  login, explicit switch, drift refresh — never `/org/me`.
- Nessie signals UOA policy via the signed config JWT:
  `login_flow.workspace_selection: 'auto'` and
  `org_features: { allow_user_create_org: true, allow_user_create_team:
  true, backend_org_management: true }` (`api/src/services/uoa-auth.ts:244-271`).
  The chooser — and therefore any create-first-org UX — is UOA-hosted;
  Nessie has **no client** for UOA's create-team/create-org endpoints.
- Local-only creation paths exist and are the F9 fork class:
  `POST /api/teams` (`api/src/routes/teams.ts:66-115`), `POST /api/projects`
  (`api/src/routes/projects.ts:136-178`), and the admin "Create a project"
  dialog (`admin/src/components/shared/CreateProjectDialog.tsx:26-30`) —
  all create UOA-unbacked rows inside UOA-bound organisations.

### B1. Zero-workspace login provisions instead of refusing

The refusal stays — an incomplete session proof must never mint a session.
What changes is that the proof becomes complete *before* the exchange:
first-login provisioning happens **UOA-side**, so the token Nessie receives
already carries the fresh org+team (Part A decides the exact mechanism:
auto-placement at sign-in vs a chooser "create" step). Nessie's only change
on this path is classification: when UOA still returns a zero-workspace
token (feature disabled, partial rollout), `EXTERNAL_AUTH_FAILED` is
replaced by a named refusal (`UOA_NO_WORKSPACE`) whose admin login screen
copy explains the remedy instead of showing a generic failure. No local
provisioning fallback — a purely local "create an Organization for this
user" is exactly the F9 fork.

### B2. "New workspace" surface (existing org / new org choice)

- Owning surface: the workspace switcher menu
  (`admin/src/layouts/admin-shell/WorkspaceMenu.tsx:102-116`), which already
  owns "Add workspace" and pending invitations. "Create workspace" joins it,
  opening a dialog (shared `Dialog.tsx` shell) with: workspace name, and an
  organisation picker — the user's existing organisations (from the UOA
  directory entries' `orgName`/`orgId` grouping keys already rendered by the
  switcher) plus "New organisation…" (name field appears).
- The submit relays to a new Nessie API route (`POST /api/workspace/teams`
  — name final at implementation) that calls the UOA backend-mode
  create-team (and create-org when chosen) endpoints via a new client in
  `packages/workspace-admin/src/uoa-org-roster.ts`'s pattern — domain-hash
  bearer + acting user's UOA subject, mirroring how invitation acceptance
  relays today (`api/src/routes/workspace-invitations.ts:32-128`).
- On success the client immediately performs the existing UOA workspace
  switch into the new team (`switchUoaWorkspace`), which triggers the
  normal materialization — the new local rows are created by the **same**
  switch path that handles invites, not by the create relay.
- Authorization mirrors UOA's own rules for who may create a team in an org
  (Part A4/A6 facts) — Nessie adds no weaker and no stronger gate, and the
  refusals (`ORG_CONFLICT_ON_DOMAIN` successor semantics, quota/policy
  refusals) are relayed in words.

### B3. Materialization reuse (no second provisioning path)

No new materialization code anywhere in Part B. The create relay produces
UOA state; local rows appear only through the existing login/switch
materialization under the exact-tuple locks. The relay's response carries
the new `{orgId, teamId}` tuple purely so the client can aim the switch.

### B4. Retire the local structural mutations (audit rec 9, F9)

In UOA mode, `POST /api/teams`, `POST /api/projects`, and the "Create a
project" dialog are mode-gated off (following the
`membership-mode-gate.ts` pattern) and their UI affordances route to the
new create-workspace flow. The local-mode (no-IdP) install keeps them —
that is the one legitimately local world. System-managed teams (PA,
external agents, standalone channels) are untouched; they are plumbing,
not org structure.

### B5. Purge the remaining claim mirrors while we are here (audit F5/F7)

- Drop `teamIds`/`teamRoles`/`orgRole` from `ProductAccountLink.metadata`
  writes (`api/src/services/integrations.ts:38-49`) and the
  `workspaceDirectory` re-write on the recovery path
  (`api/src/services/uoa-recovery-link.ts:115-120,141-148`), plus a
  migration stripping surviving keys. Nothing reads them.
- Heal `Team.name` from the UOA workspace label the way
  `syncExternalOrganizationNames` heals org names (F7) — display mirror,
  refreshed on every verified read, never authoritative.

## Part C — Remove the last duplicated identity data

Verified in production 2026-08-31: `users.email` and `users.display_name`
are populated for every SSO user. `password_hash` and `avatar_url` are NULL
(the mode-gate and avatar relay already did their jobs). The
`uoa-profile-mirror.ts` docblock keeps `displayName` "so a name and a
picture can be rendered without a round trip per message row" — the perf
rationale this part must satisfy without the column.

### C1. Drop `users.display_name` behind the profile directory

- Extend the existing bounded in-memory directory pattern
  (`uoa-directory-cache.ts`: per-process LRU, TTL, verified-read-primed)
  into a profile directory keyed by local user id → {displayName,
  avatarUrl}, primed from the same verified claim/roster reads that sync
  the mirror today, with **batch hydration** for feed pages (one lookup per
  page of authors, never per row).
- The worker needs the same directory for agent-context author names —
  shared via `@nessie/workspace-admin` (or `@nessie/runtime`), hydrated
  from the run's org roster read; degraded rendering (stable short subject
  or "Member") when UOA is unreachable, never a hard failure.
- Then drop the column. Steady-state render cost: a Map hit replacing an
  indexed JOIN — neutral or better. The costs are cold-start hydration and
  UOA availability coupling; both are handled by degrade-not-fail.

### C2. Drop `users.email` — the harder half

Email is identity data UOA owns; local persistence is the last rule
violation. Known email-keyed edges, each needing an explicit disposition:
- **One-time adoption bridge** (`workspace-principal.ts:71-123`): a legacy
  pre-SSO row is adopted by email match at first subject login. After the
  production cleanup (Part D) there are no unadopted legacy rows left in
  prod; the bridge remains for self-hosted installs — it can read the
  email from the *verified claims* transiently without persisting it, but
  needs a lookup column only as long as legacy local rows exist. Decision:
  keep a nullable `email` only on rows with `uoaSub IS NULL` (local-mode
  users), null it on adoption, drop the uniqueness constraint's role as an
  identity key.
- **CLI super-admin** is still email-keyed (known leftover) — re-key by
  `uoaSub` or an explicit user id argument.
- Any remaining lookups/dedup by email move to the roster relay or the
  directory's by-email transient index.

### C3. `pronouns`

The column is unused identity data. Dropped in the same migration unless a
product decision claims it within this cycle (it is UOA's to own if it
becomes real).

## Part D — Production cleanup (data, not code)

Status 2026-08-31:

- **Nessie side DONE.** All 8 organisation anchors deleted with cascades
  (plus 2 executor private assignments that blocked the cascade, 3 org-less
  "Smith (copy)" debris agents, and 12,205 terminal queue-history rows).
  Post-state: 0 organizations/teams/channels/messages/agents, 4 `users`
  rows kept, empty queue. Pre-cleanup `pg_dump -Fc` snapshot retained. The
  two device-paired executors were org-scoped and cascaded — desktop
  executors re-pair on next use.
- **UOA side pending the A5 endpoint**: all 20 organisations queued for
  deletion via the new admin route, unambiguous test debris first, the
  flagged orgs (KM, Gammad, Oliga, Martin Lexa, priscillia, Katerina ×2)
  last. User accounts are never deleted (99 stay, including the 13
  teleprompter users and 71 VoicePOS users). Orgs refused with
  `ORG_HAS_PROTECTED_RECORDS` stay, deliberately — commercial history
  ("the reports") outlives the cleanup, as do DeepWater's user-keyed
  research reports and the whole `prompter` database.

## Sequencing

1. **A5 + Part D (UOA)** — in flight; unblocks the green field.
2. **A1–A4** (UOA) next — Nessie can only relay what exists upstream.
   A2 and the invite-probe fix are independent of A3 and can land first.
3. **Part B** behind the UOA deploy of A1/A3/A4.
4. **Part C** independent — can run in parallel with A.
5. First login after A1 deploys is the acceptance test: fresh user →
   personal org + "General" team auto-created in UOA → Nessie materializes
   the 1:1 anchors → switcher shows one workspace, zero forms.

## Open questions for review

- Default name of the auto-created first team ("General" — UOA's existing
  default, proposed — vs a Nessie-flavoured "Workspace").
- Exact enforcement mechanism for A3's configurable org limit (service
  check + constraint trigger vs keeping a redesigned partial index).
- Whether `POST /api/workspace/teams` (B2) should relay through backend
  mode (`/org/*` with the domain hash) or reuse the `/auth/create-team`
  login-bridge flow UOA already ships; backend mode is the roster-relay
  precedent, but the auth-flow path already handles creator membership.
