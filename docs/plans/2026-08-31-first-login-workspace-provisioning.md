# First-login workspace provisioning, self-serve team creation, and the end of local identity mirrors

**Status: v2 — revised after two independent adversarial reviews (Kimix,
Codex Sol; both reviewed v1 against both codebases, findings adjudicated
claim-by-claim, convergent findings folded, three spot-verified in source).
Review artifacts:
[review-kimix](2026-08-31-first-login-workspace-provisioning-review-kimix.md),
[review-sol](2026-08-31-first-login-workspace-provisioning-review-sol.md).**

One sentence: a brand-new SSO user who signs in to Nessie with no UOA
workspaces gets an organisation and a first team (a *workspace*, in product
vocabulary) provisioned **in UOA** and mirrored 1:1 into Nessie; any signed-in
user can create further workspaces through UOA's hosted chooser flow —
choosing an organisation they hold `teams.manage` in, or explicitly creating
a **new tenant** (a new organisation); and Nessie stops persisting the last
duplicated identity fields. UOA remains the sole authority for every piece of
this — Nessie only relays, projects, and renders.

## Why now

- Today a UOA access token with no resolvable org+team is refused as
  "incomplete session proof" (`uoa-session.ts:193-203`, surfaced as
  `EXTERNAL_AUTH_FAILED`) — but the refusal is only half the story: UOA's
  chooser **already renders `CreateFirstWorkspaceForm` inline** for a
  zero-workspace user on Nessie's domain (`workspace_selection: 'auto'` +
  `allow_user_create_org: true` are both already in Nessie's config JWT).
  The gaps are automation, safety, and the multi-workspace story — not the
  existence of a flow.
- The production databases were reset 2026-08-31 (Part D). Whatever flow
  exists after the reset **is** onboarding.
- UOA enforces one ACTIVE org membership per (user, origin domain) — DB
  partial unique index `org_members_one_active_org_per_domain` plus three
  service checks. "Create a workspace in a NEW organisation" requires a
  scoped relaxation (A3), which is also the plan's riskiest item.

## Invariants that bound every part of this design

1. **UOA owns the org structure.** Every organisation and team is created in
   UOA first; Nessie materializes its 1:1 anchors only from verified UOA
   state through the existing login/switch materialization. No local-first
   creation, ever.
2. **No duplicates.** No new mirror columns, no second directory, no cached
   copy promoted to authority.
3. **Provisioning is idempotent and race-safe — by a decided mechanism, not
   an aspiration.** Concurrent first logins converge on one org+team under a
   per-user/domain advisory lock (A1); the org-count policy is enforced in
   the database (A3), never by a request-time config value alone.
4. **Rule zero.** Every flow ships with its surface and doorways.
5. **Vocabulary:** UOA teams are rendered as **workspaces** in Nessie. A new
   UOA *organisation* is a new Nessie **tenant** (budgets, policies, audit,
   billing boundary) — the UI says so and treats it as an explicit act, not
   a folder choice (Sol 18).

## Part A — UOA

### A1. First-login auto-provisioning (org + "General" team)

Mechanism: `auto_create_personal_org_on_first_login` for the Nessie domain,
**after** these fixes (Kimix 4, Sol 6, Sol 7, Kimix 19/Sol 21):

- `autoCreatePersonalOrgForUser` takes the canonical per-user/domain
  advisory lock (the one `user-team-requirement.service.ts:34-50` already
  defines), re-reads membership *and* pending invites inside the locked
  transaction (today the invite check sits outside the creation tx), and on
  losing a race returns the winner's exact `{orgId, teamId}` tuple instead
  of `auto_create_failed`. Two concurrent first logins converge; neither is
  refused.
- **Coverage decision (Sol 7):** registration-time placement only fires for
  newly-created users (`createdUser` guards in `auth-verify-email` and
  `social-login`). Existing zero-membership accounts — including every
  account retained by the Part D cleanup — fall through to the chooser's
  inline `CreateFirstWorkspaceForm`, which stays as the universal manual
  path. This is accepted and stated: retained users create their first
  workspace through the form once; only fresh registrations are automatic.
  (If product later wants automation for existing users, that is the
  login-time hook — a separate, explicitly-scoped change; `user_needs_team`
  stays off: its silent org-role promotion is an escalation and its naming
  loses to "General".)
- **Naming:** org name for a user with no asserted name is a neutral
  default ("My organisation"), never derived from the email address — the
  org name is user-visible to future co-members (PII, Kimix 19/Sol 21).
  Named users keep "<name>'s organisation" / team "General".
- `pending_invites_block_auto_create` stays `true`.

### A2. Consolidate the creation paths (not just their outcomes)

Five paths write five role outcomes today. Consolidation (Kimix 29, Sol 11):

- One `createOrganisationWithOwner` service used by the public route, the
  hosted `/auth/create-workspace`, the admin route, and A1's auto-creator.
  Creator becomes org `owner` (structural, always valid) and a member of the
  default team; the *team role* written for creators everywhere comes from a
  validated per-domain `org_features.creator_team_role` setting that must
  name a role in the domain's configured vocabulary — never a hard-coded
  literal `admin`, which a domain may not define (Sol 11).
- `createTeam` gains creator membership (`POST /org/organisations/:orgId/
  teams` stops minting orphan, member-less teams), with the same validated
  creator role, and its `max_teams_per_org` check moves under the org row
  lock the hosted flow already takes (Sol 5).

### A3. One-org-per-domain becomes a per-domain policy — decided mechanism

- Policy: `max_active_orgs_per_user` **stored in UOA's own domain
  configuration** (server-side, admin-managed), never read from the
  request-time config JWT — a caller-supplied value cannot drive a database
  constraint (Sol 1).
- Enforcement stays **in the database**: the partial unique index remains
  for every domain at the default (1). A domain configured above 1 is
  listed in a small `domain_org_policies` table; a constraint trigger on
  `org_members` INSERT/UPDATE consults it and counts ACTIVE rows under the
  existing per-user/domain advisory lock ordering. Check-then-write in
  service code is explicitly not the mechanism — the 20260730 migration
  history records why (the index replaced a racy trigger; the new trigger
  counts under the same lock the writers now hold, which the old one did
  not).
- **Assumption audit ships in the same change** (Kimix 11, Sol 2): every
  consumer in UOA and Nessie that encodes "one membership on this domain ⇒
  the organisation is unambiguous" — `resolveExternalWorkspaceSelection`'s
  sole-team fallback, UOA's session-choices/refresh active-org selection,
  `getUserOrgContext` preference order, Nessie's switch reauthorization —
  is enumerated and either verified N-safe or fixed.
- **Invite tombstone fix (reshaped per Sol 8):** acceptance resolves an
  existing `(orgId, userId)` tombstone by **atomic reactivation** (the
  behaviour `organisation.service.members.ts:143-210` already implements),
  and counts only *other* ACTIVE origin-domain memberships against the
  policy. Filtering the probe to ACTIVE alone would just move the failure
  to the unique constraint.
- Nessie-side copy: `UoaInvitationOrgConflictError` handling and invite UI
  copy revised in the same change (Kimix 18).

### A4. `/org/me` carries onboarding state — as a NEW block

- A separate top-level `onboarding` block (`{ can_create_org,
  pending_invites }`) is returned when the user has no org context; the
  `org` block keeps its exact current meaning — present ⇒ real ACTIVE
  context (Sol 10; "additive" v1 framing was wrong, Kimix 14 concurs).
- Pending invites for a zero-org user cannot be read through the current
  `/org/me` transaction — RLS `team_invites_select` requires `app.org_id`
  (Sol 9). The lookup is a narrowly-scoped SECURITY DEFINER function (or
  admin-transaction read) bound to the verified user's email + domain,
  reviewed against `Docs/Requirements/row-level-security.md`; `team_invites`
  is not widened.
- Consumer audit before ship: grep UOA Admin/Auth/API + every product for
  `/org/me` shape assumptions; the new block is opt-in by its absence.

### A5. Admin organisation lifecycle — SHIPPED 2026-08-31

`DELETE /internal/admin/organisations/:orgId` (superuser-gated, reuses
`deleteOrganisation` with admin provenance via `getAdminPrisma`, named
`ORG_HAS_PROTECTED_RECORDS` refusal) + SPA delete action with typed-name
confirm. Merged to UOA main `2d67bf0`; auto-deploying to Cloud Run. (Sol 20
noted it was unverifiable from the reviewed baseline — it is now in-tree.)

## Part B — Nessie

### B1. Zero-workspace login: named refusal, shipped FIRST

The exchange refusal stays. `EXTERNAL_AUTH_FAILED` for the specific
no-workspace case becomes `UOA_NO_WORKSPACE` with static remedy copy on the
login screen — identical for every zero-workspace cause, revealing nothing
about account existence or invites (Kimix 20). **Ships before A1's flag
flip** (Kimix 13, Sol 12): it is the failure handling for the rollout
window, and A1's placement is self-healing per login attempt so a user who
hits the window is unblocked on retry. Implementation is a structural
classification of the exchange result — never string-matching the upstream
error message.

### B2. "New workspace" — UOA-hosted chooser flow, no Nessie relay

v1's backend-mode relay is **dropped** (Kimix 17 + 1/5/9/12/27, Sol 3/4/5:
backend mode has no acting-user concept — `resolveAndAuthorizeTeamOrg`
returns unchecked with no actor — so the relay was a confused deputy with a
cross-tenant write hole, plus a create/switch propagation race). Instead:

- Nessie's switcher keeps one "Create workspace" doorway that round-trips
  to the UOA chooser (`onAddWorkspace` already exists); UOA's
  `/auth/create-team` + `/auth/create-workspace` do creation, creator
  membership, and session finalisation atomically in the login bridge —
  the finding-12 race and finding-17 authz hole never exist.
- UOA-side UX work this implies: the chooser's create dialog becomes
  reachable for users who already have workspaces (today `creatable_orgs`
  gates team-in-existing-org, but "new organisation" is hard-wired to
  first-workspace only — `WorkspaceChooserPage.tsx:170,244`); under A3 it
  becomes policy-driven, and the "new organisation" branch is presented as
  **create a new tenant** with its consequences named (Sol 18).
- On return, Nessie's normal callback → login materialization creates the
  local anchors; the switcher refreshes from the directory. No new Nessie
  API surface at all.

### B3. Materialization reuse — unchanged (survived both reviews)

No new materialization code. Login/switch materialization under exact-tuple
advisory locks remains the only path local rows appear.

### B4. Retire local structural mutations — widened

In UOA mode, mode-gate off (following `membership-mode-gate.ts`, already
imported by these route files): `POST /api/teams`, `POST /api/projects`,
**and the remaining local project/team mutation routes** (rename/delete —
Sol 13's half-gate point), plus the "Create a project" dialog affordances,
which route to B2's doorway. Local-mode (no-IdP) installs keep them.
System-managed teams (PA, external agents, standalone channels) untouched.

### B5. Purge remaining claim mirrors — with a contract note

- Drop `teamIds`/`teamRoles`/`orgRole` writes (`integrations.ts:38-49`) and
  the recovery-path `workspaceDirectory` write (`uoa-recovery-link.ts`),
  plus a migration stripping surviving keys. In-repo readers: none. The
  keys do surface via `integration-product-rows.ts:114-130` into
  `IntegratedProductResponse` (Sol 19) — they are deprecated in the
  contract note and stripped there in the same change.
- Heal `Team.name` from the UOA workspace label wherever org names heal
  today — **both** the directory read and the switch/login paths (Sol 13) —
  which the Part D green field makes load-bearing on day one (Kimix 15):
  every post-cleanup team name starts as the `Workspace <id8>` placeholder.

## Part C — Remove the last duplicated identity data

The verified consumer inventory (Kimix 21-23, Sol 15-16) reframes this from
"drop two columns" to a staged migration with named hot paths:

### C0. Consumer inventory (the contract of this part)

- **Mention resolution** (`packages/runtime/src/user-alerts.ts:25-46`)
  string-matches `displayName` per channel-member on **every message
  write**, synchronously, in api and worker. A cold directory = silently
  lost mentions/alerts/push.
- **Worker paths with no roster read to prime a cache**: call lifecycle
  missed-call copy, push-dispatch body text, attention-dispatch,
  PA message-destination labels, conversation-search author names,
  mention-alerts, agent-record owner names.
- **Wire contracts**: `MeResponse.user.email`, `UserRecordSchema.email`
  (required, feeds members/people lists), project members' email, message
  author includes; ~40 admin files render these fields.
- **DB-level uses**: sorts/lookups on `displayName`/`email` in list
  queries; the adoption bridge `findUnique({ where: { email } })`; CLI
  super-admin email keying.

### C1. `display_name`: staged, not dropped-first

1. Build the profile directory as a **read-through seam, not a Map in a
   shared package** (Sol 16): one `resolveDisplayProfiles(userIds)`
   interface in `@nessie/workspace-admin`, backed per-process by an LRU
   primed from verified claim/roster reads, with **batch hydration** and a
   DB fallback while the columns still exist.
2. Move every consumer in C0 onto the seam (mention resolution hydrates
   the channel-member candidate set per write; worker dispatchers hydrate
   per notification batch).
3. Only then drop the column, switching the seam's fallback to the roster
   relay. Degraded rendering contract (decided): UOA-roster name when
   reachable, else the last cache value, else the string `Member` — and
   mention resolution in the degraded state falls back to matching against
   the *cached* candidate set, never silently to zero candidates; a
   resolution pass with no candidate source raises a visible worker log
   metric ("a capability that can stop working owns the way a person finds
   out").
4. No-name contract (Kimix 24): for a user whose claims carry no name the
   directory serves UOA's roster-derived label transiently; nothing
   persists it.

### C2. `email`: keyed edges resolved explicitly

- Column becomes nullable; **local-mode (no-IdP) users and not-yet-adopted
  legacy rows keep theirs** — it is their identity key and stays unique
  among non-null values. SSO-adopted rows null it.
- Adoption bridge: unchanged single-shot semantics; a *second* pre-SSO
  account with the same email fails closed with a **named refusal and
  remedy copy** (`LEGACY_ACCOUNT_AMBIGUOUS` — contact the operator), not a
  silent dead end (Kimix 24).
- Wire contracts: each C0 email field gets an explicit decision — `MeResponse`
  hydrates from the session's verified claims; `UserRecord.email` becomes
  optional and hydrates from the roster relay for UOA orgs; project-member
  email drops (the roster page already renders identity from UOA).
- CLI super-admin re-keys by `uoaSub` or explicit user id; the email form
  remains for local-mode installs only.
- **Ordering**: C1 lands before C2 nulls anything — `initialDisplayName`'s
  email fallback for brand-new rows must already be dead code.

### C3. `pronouns` — retained (v1 was wrong)

Verified NOT unused: exposed in `MeResponse` (`auth.ts:299`), written by the
users service, rendered by the admin profile page. It stays until a product
decision moves pronouns into UOA-owned profile data. Removed from this
plan's scope.

## Part D — Production cleanup (data, not code)

- **Nessie side DONE 2026-08-31.** 8 orgs + cascades deleted (plus 2
  executor private assignments, 3 org-less debris agents, 12,205 terminal
  queue rows); 0 organizations/teams/channels/messages/agents; 4 `users`
  rows kept; pre-cleanup `pg_dump -Fc` snapshot retained. Org-scoped
  executors cascaded (desktop executors re-pair).
- **UOA side: in progress** via A5 once deployed — all 20 organisations,
  test debris first, flagged orgs last; accounts never deleted; orgs
  refused `ORG_HAS_PROTECTED_RECORDS` stay (commercial history — "the
  reports" — outlives the cleanup, as do DeepWater's user-keyed reports and
  the whole `prompter` database).
- **Consequence to carry (Sol 7):** every retained account is an *existing*
  user to A1 — their first workspace comes from the chooser form, not
  auto-provisioning. Acceptance testing must cover both the fresh-user and
  retained-user paths.

## Sequencing (revised)

1. **A5 + Part D (UOA)** — deployed/running.
2. **B1** (named refusal) + **A2** (path consolidation + orphan-team fix) +
   the **invite tombstone reactivation** — independent, land first.
3. **A1** (auto-provisioning, behind its lock fix) — flag flips only after
   B1 is live.
4. **A3** (policy knob + DB trigger + assumption audit) + **A4**
   (`onboarding` block) — then the UOA chooser's create-dialog UX for
   existing users (B2's upstream half).
5. **B2** switcher doorway + **B4/B5** — B4/B5 any time after 2.
6. **C1 → C2** — independent of A/B, ordered internally.
7. Acceptance: fresh registration → auto org+General → Nessie materializes
   → switcher shows it; retained user → chooser form once; existing user →
   "Create workspace" → team in entitled org / explicit new tenant.

## Open questions (narrowed)

- A2's `creator_team_role` default when a domain configures no vocabulary
  (proposal: the existing default-table `admin`).
- Whether "new tenant" creation (B2/A3) needs an owner-side approval or
  billing gate before GA — currently: any member may create one, and the
  tenant is theirs.
