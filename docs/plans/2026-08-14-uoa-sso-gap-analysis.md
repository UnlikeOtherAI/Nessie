# Nessie × UnlikeOtherAI SSO — where we are (gap analysis, 2026-08-14)

> **Status:** assessment only — no code changed. Evidence verified against the
> tree at `7dd1de9e` (main). Three deep sweeps (server auth flow, local
> identity data model, per-platform clients) plus direct spot-verification of
> every load-bearing claim.
> **Update 2026-08-15:** the assessment stands as written except where a row
> or phase entry says otherwise. Landed since, in merge order: **Phase 1**
> (local-password stack hard-gated to `local` mode), **Phase 2** (principals
> keyed by UOA subject), **Phase 6** (directory cache in-memory + avatar-client
> egress pin), **Phase 4** (roles projected from verified claims; local
> membership mutators gated), **Phase 7** (targeted workspace reauthorization +
> one always-mounted callback lifecycle, from the parked
> `codex/sso-invites-team-switch` series), **Phase 3 step 1** (display-name
> synthesizer and Gravatar deleted, claim-synced profile mirror, UOA-relayed
> avatar uploads), and most of **Phase 5** (rosters + invitations on the UOA
> org API in backend mode). The rows and phase entries carry what shipped and
> what is left.
> **Note:** worktrees `.worktrees/sso-invites-team-switch/`,
> `.worktrees/switch-integration-prepare/`, and
> `.worktrees/native-logout-timeout/` contain in-flight work directly relevant
> to this brief that is **not on main** and is not assessed here.

## The brief being assessed

UOA SSO is the sole authority for human identity, authentication, profiles,
org/team membership, team rosters, and invitations. Nessie may persist only:
the stable UOA subject/reference, genuinely Nessie-specific extension data,
and encrypted scoped rotating UOA refresh material / an opaque session handle.
All identity/team/roster/invite reads and mutations go through the SSO API; a
bounded **in-memory** cache is allowed for performance and is never
authoritative. Product requirements: (1) one shared workspace switcher on
every platform, grouped by stable UOA org id, UOA-backed avatars; (2) silent
switch on valid renewable proof, SSO flow for the exact org/team otherwise,
never logging the user out on failure, one shared PKCE/callback lifecycle;
(3) rosters and invitations are SSO API features, matched by UOA subject —
never local email rows.

## Verdict in one paragraph

> **Superseded 2026-08-15 — see the update note above.** The paragraph below
> describes the 2026-08-14 state the remediation started from.

As of 2026-08-15: authentication, subject keying, roles, rosters, invitations,
the workspace directory cache, the targeted switch/reauthorization flow, and
the callback lifecycle are UOA-backed and brief-compliant; local-password and
local membership mutation surfaces are hard-gated to `local` mode. The
substantive remaining items are **Phase 3 step 2** (dropping the
`email`/`displayName`/`avatarUrl` mirror columns behind an in-memory profile
directory — the columns persist today as a documented non-authoritative,
claim-synced mirror) and the sign-off items listed under Ambiguities
(no-`state` PKCE, unverified UOA access-token signatures, the last-owner
floor, `pronouns`, upstream invitation revoke).

**Original 2026-08-14 verdict:** The **session plumbing** (encrypted UOA refresh credential, epoch binding,
silent workspace switch with layered subject/org/team validation) and the
**workspace switcher UI** (one shared component across web, iPhone, iPad,
Android, and the Tauri Mac app; grouped by stable UOA org id; UOA-backed
avatars) are close to fully brief-compliant. The **identity data model is
not**: Nessie keeps a full local identity store — `email` (which is also the
principal join key), `displayName`, `passwordHash`, provider `avatarUrl`, a
local avatar override — plus locally-owned roles, local membership lifecycle,
and a members-management UI that creates password accounts. There is **no
invitation system at all** and no UOA roster/invitation API calls; the
functional substitute (owner types an email and a password into
`POST /api/users`) is the single largest violation. Matching is by email, not
UOA subject — a risk the code itself documents as an account-takeover vector.
On the switching side, the step-up path is unfinished: the `teamHint`
plumbing for a targeted SSO flow exists end-to-end but has **zero callers**,
a switch never returns to the originating screen, and the OAuth callback
handling is duplicated per platform and only works while logged out.

## Per-requirement status

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 0.1 | No local-password accounts | **VIOLATES → mode-gated 2026-08-15** | `User.passwordHash` (`api/prisma/schema.prisma:747`, scrypt in `api/src/auth/password.ts`) and the whole password stack still exist, but are now refused server-side outside `local` mode (phase 1 below): password login branch `api/src/routes/auth-login.ts` → `403 PASSWORD_AUTH_DISABLED`, `POST /api/users` (`api/src/routes/users.ts`) → `403 LOCAL_USER_CREATION_DISABLED`, `POST /api/auth/password` (`api/src/routes/auth-security.ts`) → `403 PASSWORD_AUTH_DISABLED`. Bootstrap owner with password (`api/src/routes/auth-core.ts:235-319`) remains, and needs no gate: it is disarmed whenever an SSO provider is enabled. Login UI was already gated to local mode (`admin/src/pages/LoginPage.tsx:82,400-439`) |
| 0.2 | No duplicate SSO-owned data (email, name, avatar, memberships, roles, invitations) | **VIOLATES → roles + directory fixed 2026-08-15** | `User.email/displayName/avatarUrl/avatarAttachmentId/pronouns` (`schema.prisma:745-753`) still local (phase 3). **Roles/memberships no longer duplicated**: they are a projection of the verified `org_role`/`team_roles` claims re-applied at login, refresh, and workspace switch (`api/src/services/uoa-roles.ts`), and the local mutators are refused outside `local` mode (phase 4 below). **Workspace directory fixed**: no longer persisted — bounded in-memory cache (`api/src/services/uoa-directory-cache.ts`, phase 6) |
| 0.3 | Retain only UOA subject + extension data + encrypted refresh material | **Implemented (for what it covers)** | `UoaSessionCredential` AES-256-GCM (`schema.prisma:854-885`, `packages/runtime/src/secret-crypto.ts`); `ProductAccountLink.uoaSub/uoaTokenVersion` (`schema.prisma:1036-1037`); `Team.externalWorkspaceId/externalOrgId` (`schema.prisma:1234-1235`); `User.preferences/tokenVersion` legitimately local. But the subject is **not** on `User` — it lives only org-scoped on the link row, which is why email became the join key |
| 1 | One shared switcher, all platforms, grouped by UOA org id, UOA-backed avatars, active state | **Implemented** (one ambiguity) | One shared component with render variants (`admin/src/layouts/admin-shell/WorkspaceSwitcher.tsx:212-214`); native iPhone/iPad controls are trigger-only chrome calling into the same web menu (`mobile/src/lib/native-webview-actions.ts:25-27`, `mobile/src/components/NativePhoneHeader.tsx:140-161`, `IpadNativeWorkspaceSwitcher.tsx:29-51`); Tauri loads the hosted admin (`desktop/src-tauri/src/lib.rs:14-30`). Grouped by raw UOA org id (`admin/src/lib/workspaces.ts:62-79`); avatars via authed relay `/api/teams/:teamId/avatar` → UOA directory `avatarImageUrl` → initials (`admin/src/components/primitives/WorkspaceAvatar.tsx:53-59`); active state `WorkspaceSwitcher.tsx:124`. **Ambiguity:** the Swift app in `macos/` has no workspace/auth concept at all — if "Mac" means it rather than the Tauri desktop, that platform is a no-op |
| 2a | Silent switch on valid renewable proof | **Implemented** | `POST /api/auth/uoa/workspace` (`api/src/routes/auth-uoa-workspace.ts:48`) via UOA grant `urn:unlikeotherai:params:oauth:grant-type:workspace-switch` (`api/src/services/uoa-session.ts:66-67,343-370`); crash-safe `UoaWorkspaceSwitchIntent` (`schema.prisma:887-907`, 13-field source match); client branch `WorkspaceSwitcher.tsx:256-298` |
| 2b | Fresh-proof/2FA path opens SSO for the **exact** org/team, returns to the **same screen** | **Implemented 2026-08-15** | Landed from the parked `codex/sso-invites-team-switch` series: a refused switch classifies as a dedicated `reauthorize` outcome (`admin/src/layouts/admin-shell/workspace-switch-recovery.ts`) and `startWorkspaceSwitchReauthorization` (`admin/src/lib/external-auth.ts`) launches SSO with `teamHint` for the exact target; the pending PKCE record captures `returnPath` + `targetWorkspace` and the callback returns there on success AND on cancel/failure of a targeted flow (`admin/src/lib/external-auth-completion.ts`), session untouched. Deliberate choice, documented in the auth spec: even a *successful* switch returns to the captured route, which can land on a not-found entity after a cross-workspace switch |
| 2c | Never log out on failed/cancelled/unavailable switch | **Implemented (one edge)** | Safe refusals (`WORKSPACE_NOT_AVAILABLE`, `INTERACTION_REQUIRED`, `WORKSPACE_SWITCH_CONFLICT`) preserve the session (`auth-uoa-workspace.ts:21-33`, `uoa-session.ts:327-333`); native cancel normalizes to a benign state (`mobile/src/lib/external-auth-bridge.ts:35-37`); ambiguous failures reconcile through the refresh funnel and can be detected as success (`workspace-switch-recovery.ts:21-25,70-73`). One real logout path: a definitive upstream error revokes the family server-side (`auth-uoa-workspace.ts:126-133` → 401 `WORKSPACE_SWITCH_REAUTH_REQUIRED`) and the client's reconcile then clears the session (`packages/client-core/src/auth-session.ts:138-141`) — defensible (the credential is genuinely dead) but a literal-reading violation to sign off on |
| 2d | Never apply a returned session unless same subject/provider + exact requested org/team | **Implemented** | Layered: pre-flight `confirmUoaDirectServiceAccess` for the target (`api/src/services/uoa-workspace-switch.ts:49-71`); upstream response check (`uoa-session.ts:405-418`); `validateUoaRefresh` (`api/src/services/refresh-token-uoa.ts:167-182`); materialization re-check (`uoa-workspace-switch.ts:88-95`). Caveat: the materialization guard compares **email**, not sub (`uoa-workspace-switch.ts:96-107`) — see V1 |
| 2e | One shared PKCE/callback lifecycle across platforms | **Implemented 2026-08-15** | PKCE generation shared (`packages/client-core/src/pkce.ts`); callback handling is now ONE always-mounted `ExternalAuthProvider` (`admin/src/providers/ExternalAuthProvider.tsx` + `external-auth-callback.ts`), installed above the router with no session-state gate, so authenticated round-trips work on web, Tauri, and native; native results ride a retained delivery queue with ready/delivered acks (`mobile/src/lib/external-auth-delivery.ts`) — the old swallowed-catch bridge is deleted. Still open: UOA authorize carries no `state` param (CSRF rides sessionStorage PKCE, `uoa-auth.ts:322-326`) — sign-off item |
| 3a | Rosters are SSO API features | **Implemented for the workspace roster (2026-08-15)** | `GET /api/workspace/members` (`api/src/routes/workspace-members.ts`) serves the roster live from UOA in backend mode — `GET /org/organisations/:orgId/teams/:teamId` joined with `GET /org/organisations/:orgId/members?status=all` (`api/src/services/uoa-org-roster.ts`), keyed on the UOA subject, nothing persisted; role change / team removal / deactivate / reactivate relay the matching `/org/*` mutations behind Nessie's owner/admin gate (UOA applies none in backend mode). Enabled by `org_features.backend_org_management: true` in the config JWT (`uoa-auth.ts`). PA `people_search` answers from the same seam since 2026-08-15 (moved to `@nessie/workspace-admin`; item 7). **Still local:** `GET /api/users`, `POST /api/teams/:teamId/members`, and project member CRUD — previously: No UOA member-roster call exists anywhere; `/org/me` returns only the signed-in user's own workspaces (`api/src/services/uoa-workspace-directory.ts`). Local substitutes: `GET /api/users` from local rows; `POST /api/teams/:teamId/members` (`api/src/routes/teams.ts:81-130`); project member CRUD (`api/src/routes/projects.ts:240-311`); PA `people_search` reads local users by name/email substring (`worker/src/run/pa-tools/people.ts:17-46`) |
| 3b | Invitations created/resent/revoked/approved/declined/accepted via SSO; acceptance hosted by SSO | **Implemented (2026-08-15)** | `GET/POST /api/workspace/invitations`, `POST /api/workspace/invitations/:inviteId/resend\|revoke\|approve\|deny` relay UOA's team-invitation contract; acceptance is hosted by UOA and Nessie mints/stores/renders no invitation token. **Revoke landed both sides 2026-08-15**: UOA added `DELETE .../teams/:teamId/invitations/:inviteId` in backend mode and Nessie relays it — idempotent, `409 INVITATION_ALREADY_ACCEPTED` once accepted, generic `404` for an unknown or foreign id; `deny` keeps its own meaning for an invitation still awaiting approval. Shareable invite links are deliberately not surfaced. The admin Members page renders the UOA branch on a UOA session and keeps the local list otherwise. **Not yet removed:** `POST /api/users` and its local Add-member form, which Phase 1 already refuses outside `local` mode (`403 LOCAL_USER_CREATION_DISABLED`) and the Members page no longer reaches on a UOA session — previously: No invitation model, token, email, or endpoint exists (grep-clean; only agent-mention invites and executor pairing use the word). The substitute is worse: admin Members page submits `{displayName, email, password, role}` to `POST /api/users` (`admin/src/pages/settings/SettingsMembersPage.tsx:141-153`) — account + credential + roster placement with zero UOA involvement and no consent flow |
| 3c | Match by UOA subject + org/team ids, never local email rows | **Largely fixed 2026-08-15** | Phase 2 keyed principals on `User.uoaSub` (`api/src/services/workspace-principal.ts`, email kept only as the one-time adoption bridge), and the roster and invitation routes added the same day take the UOA subject in the path and resolve the workspace from `Team.externalOrgId`/`externalWorkspaceId` only. Remaining email-keyed paths are the adoption bridge itself and the CLI super-admin grant. Originally: principal resolution was `user.findUnique({ where: { email } })` (`api/src/services/workspace-context.ts:379`, `:194-205`); the per-principal advisory lock is keyed on the **email string** (`:190`); `auth-login.ts:120,134` (`loadSessionUserByEmail`); switch guard compares emails (`uoa-workspace-switch.ts:96-107`); super-admin grant by email (`cli/src/super-admin.ts:56-66`). Self-documented takeover risk at `api/src/services/external-auth.ts:209-217`. Correct sub-matching exists only in session/billing paths (`uoa-session-context.ts:102-106`, `packages/runtime/src/uoa-delegated-identity.ts:293-301`) |

## Flagged local copies of UOA-owned data (the non-negotiable)

Prioritized. Per the rule: no compatibility copies or fallbacks — each gets an
API-backed refactor + migration (sequence below).

1. **`User.email` as the identity join key** — the de-facto primary identity,
   used for provisioning, login matching, the per-principal advisory lock, and
   the workspace-switch binding guard. `external-auth.ts:209-217` states the
   consequence outright: an IdP-asserted email can take over the matching
   account. *(workspace-context.ts:190,194-205,379; auth-login.ts:120,134;
   uoa-workspace-switch.ts:96-107; users.ts:242-249,361-368;
   cli/src/super-admin.ts:56-66)*
2. **Local password authentication stack** — `passwordHash` (scrypt), a
   password login branch **not gated by deployment mode**
   (`auth-login.ts:222` — live in hosted for any account that has a hash),
   password change, password-set at member creation, password bootstrap.
3. **Local profile store** — `displayName`, provider `avatarUrl` (captured at
   provisioning, create-only, never re-synced — the only repair is when the
   stored name equals the email, `auth-login.ts:125-138`),
   `avatarAttachmentId` (local upload that **overrides** the UOA avatar —
   precedence documented in
   `admin/src/components/primitives/UserAvatar.tsx:7-10`), `pronouns`,
   Gravatar derived from the stored email (`api/src/services/users.ts:34`).
   Worse: `buildMeResponse` **manufactures** a display name from the email
   local part and persists it on every `/api/auth/me`
   (`api/src/services/auth.ts:252-258`,
   `api/src/services/identity-display.ts:43-64`).
4. **Locally-owned roles and membership lifecycle** — **RESOLVED 2026-08-15**
   (phase 4 below). Was: org/project/team roles in local rows, mutated by
   `PATCH /api/users/:userId`, `POST /api/teams/:teamId/members`, project member
   CRUD; `OrganizationMember.deactivatedAt` as a local membership kill-switch;
   UOA's `org_role` claim parsed then **discarded** (org role hardcoded
   `'member'`) and the team role mapped once at first join and never re-synced
   (upserts with `update: {}`), so a UOA demotion never propagated. Now: roles
   are a projection of the verified claims re-applied at login, refresh, and
   workspace switch (`api/src/services/uoa-roles.ts`), and the six local
   membership mutators answer `403 LOCAL_MEMBERSHIP_MANAGEMENT_DISABLED`
   outside `local` mode. The last-owner invariant
   (`api/src/services/organization-owner-lock.ts`) survives as a `local`-mode
   route rule and as a floor on the projection.
5. **`POST /api/users` — the invitation-system-shaped hole** — creates the
   human, the credential, and full roster placement in one local call, exposed
   in the admin UI. This is the "proposed local copy" case the rule exists
   for: do not extend it; replace it with the UOA invitation API.
6. **Durable caches of UOA data** — *fixed 2026-08-15 (phase 6)*. The workspace
   directory (labels, org names, avatar URLs) was persisted in
   `ProductAccountLink.metadata` and served from Postgres on every
   `/api/auth/me`; it now lives only in the bounded in-memory cache
   `api/src/services/uoa-directory-cache.ts`, with a Nessie-owned
   `Team`-mapping fallback for a cold cache, and migration
   `20260815120000_drop_uoa_workspace_directory_mirror` strips the old key.
   `activeOrgId`/`activeTeamId` last-seen columns remain borderline
   (session-handle-adjacent, explicitly non-authoritative).
7. **PA people directory** — **RESOLVED 2026-08-15.** Was: the agent tool
   answered "who is X" from the local user table by name/email substring
   (`worker/src/run/pa-tools/people.ts`), making Nessie the roster of record
   for agents too. Now: on a UOA-linked team `people_search` answers from the
   same `listWorkspaceMembers` read the Members page relays — the roster seam
   moved to `@nessie/workspace-admin` (`uoa-org-roster.ts` + `uoa-settings.ts`,
   re-exported by `api/src/services/uoa-org-roster.ts`/`uoa-auth.ts`) because
   the worker cannot import `api/src/services/*`. Results are keyed on the UOA
   subject (local `userId` shown only via the `User.uoaSub` join), cached
   in-memory per (org, team) for 60 s, and a failed UOA read reports failure in
   words — never a silent local fallback. The local search survives only for
   teams that are not UOA-linked (local mode).
8. **No `uoaSub` on `User`** — the stable subject lives only on the
   org-scoped `ProductAccountLink`, which is *why* email became the key. (Not
   a copy — the missing column that permits the copies.)

**Legitimate to keep** (extension data / permitted retention):
`UoaSessionCredential` (encrypted refresh material — exactly what the brief
permits), `UoaWorkspaceSwitchIntent`, `ProductAccountLink.uoaSub` /
`uoaTokenVersion`, `Team.externalWorkspaceId/externalOrgId`,
`User.preferences`, `User.tokenVersion` (local access-token epoch, distinct
from UOA `tv`), presence/status/alerts, `ChannelMember` and knowledge-space /
dashboard grants (product concepts, not UOA rosters).
`Organization.logoAttachmentId` is defensible as Nessie's own brand mark (the
workspace-avatar work explicitly separated it from the UOA team avatar) —
flagged only for a written decision.

## What is already right (don't re-litigate)

- Encrypted, rotating, family-bound UOA refresh credential with monotonic
  `tv` epoch, cross-replica advisory locks, replay grace, reuse detection
  (`refresh-token-uoa*.ts`, `refresh-token.ts:140-480`).
- The silent workspace switch, its intent machinery, safe-refusal
  classification, and layered identity validation; ambiguous-failure
  reconciliation through the refresh funnel.
- One genuinely shared switcher component with native trigger chrome, org-id
  grouping, entitlement-scoped avatar resolution.
- UOA-backed user and team avatar relays (bytes never stored, no quota).
- OIDC egress was hardened since the 2026-08-13 architecture audit flagged
  it: `external-auth.ts` now uses `safeFetch` with `maxRedirects: 0` and
  issuer-origin pinning (`ensureIssuerOriginEndpoint`,
  `external-auth.ts:60-90`). Remaining straggler: the UOA avatar client uses
  plain `fetch` (`uoa-avatar.ts`).
- First SSO login can seed the instance without a password
  (`initializeSharedOrganization`, `workspace-context.ts:221-254`), and
  bootstrap mode is disarmed whenever a non-local provider is enabled
  (`api/src/lib/server-context.ts:182-192`) — the SSO-first bootstrap the
  refactor needs already exists.

## Ambiguities to resolve before the refactor (decisions, not code)

1. **Brief vs deployment modes.** `docs/deployment-modes-and-auth-spec/overview.md`
   deliberately supports `local`/`selfHosted` installs with **no** UOA and a
   password bootstrap (§4.3a). The brief's "never create local-password
   accounts" cannot hold verbatim for a no-IdP local install. Decision
   needed: scope the brief to UOA-configured deployments and **hard-gate the
   entire local identity stack by mode** (today the password branch runs even
   in hosted), or drop local-password mode entirely.
2. **Does the UOA API offer what R3 needs?** No roster/invitation endpoints
   are called today, and `docs/done/2026-07-25-uoa-user-avatars.md` records a
   real constraint: dual-auth `/org/*` routes need a spendable end-user
   access token, which Nessie deliberately never holds (only the bound
   refresh credential); backend-driveable calls are the full-trust
   `/domain/*` flavour. R3 is therefore blocked on the **UOA-side contract**
   (roster list, invitation CRUD, hosted acceptance) being available to RP
   backends — confirm with the UOA team before planning UI.
3. **What does "Mac" mean?** The Tauri desktop app is covered (it renders the
   hosted admin, so it shares the switcher and PKCE code). The Swift app in
   `macos/` is an unrelated local voice client with no auth or workspace
   concept at all. If the brief's "Mac" includes it, that platform is a
   complete no-op today.
4. **Role boundary.** Nessie needs RBAC over product resources. Which roles
   are UOA-owned (org/team membership + org/team role) vs product-specific
   grants (channel member, knowledge space, dashboard, `superAdmin`)? The
   deny-overrides policy engine can stay, but its subject facts must come
   from UOA.
5. **One shared local Organization.** All UOA workspaces map to Teams inside
   a single local org
   (`docs/plans/2026-07-10-slack-workspace-login-nessie.md`); the switcher's
   org grouping comes from directory data, and the local `Organization` row
   has no UOA org id. Compatible with the brief's UI requirement, but the
   model decision should be restated as deliberate.
6. **`pronouns` and the local avatar upload** — extension data or profile
   data? UOA owns profiles; if UOA has no pronoun/avatar-override field,
   either drop them or record a written decision that they are Nessie
   extension data. The avatar upload currently *overrides* the UOA picture,
   which contradicts "UOA-backed avatar" at least in spirit.
7. **The definitive-error logout** (2c edge) and **no-`state`-param PKCE
   flow** — both defensible, both worth explicit sign-off rather than
   accident.
8. **UOA access tokens are never signature-verified** (HS256, decoded not
   verified — per UOA's own contract, trust derives from the
   `clientHash`-authenticated backchannel; `uoa-auth.ts:22-25`). Same:
   explicit sign-off.

## Recommended sequence (API-backed refactor + migration; no compat copies)

**Phase 0 — decisions.** Resolve ambiguities 1–4 (mode scoping, UOA
roster/invitation contract, "Mac", role boundary). Everything else sequences
off these. Check the in-flight `.worktrees/sso-invites-team-switch/` work
before starting — it appears to target this exact area.

**Phase 1 — stop the bleeding (small, immediate).** ✅ **Server gate landed
2026-08-15.** Mode-gate the local identity stack: outside `local` mode the
password branch of `POST /api/auth/session` and `POST /api/auth/password`
answer `403 PASSWORD_AUTH_DISABLED`, and `POST /api/users` answers
`403 LOCAL_USER_CREATION_DISABLED` (`api/src/routes/auth-login.ts`,
`auth-security.ts`, `users.ts`; tests in
`api/test/local-auth-mode-gate.test.ts`; contract written up in
`docs/deployment-modes-and-auth-spec/overview.md` §4.3a). The login gate is scoped to
the password branch — the SSO exchange is untouched — and refuses before the
account lookup, so it is not an account-existence oracle. Password bootstrap
needed no gate: `resolveBootstrapState` already disarms bootstrap mode
whenever a non-`local-bootstrap` provider is enabled, so every SSO deployment
provisions its owner through first SSO login (verified, unchanged). This
resolves ambiguity 1 in favour of scoping the brief to UOA-configured
deployments rather than dropping local-password mode. Still open in this
phase: point the admin Members page at read-only data (tracked separately).
No schema change yet.

**Phase 2 — subject keying.** Add `User.uoaSub` (unique, nullable for
non-UOA modes); backfill from linked `ProductAccountLink` rows in one
migration; flag unmatched users for re-link at next login. Switch principal
resolution, the advisory lock, login matching, and the workspace-switch
binding guard from email to subject. Email leaves the unique constraint and
stops being a key.

> **Status (2026-08-15): landed** on branch `task/uoa-subject-keying`.
> `User.uoaSub` (unique, nullable) added and backfilled from `linked`
> `nessie` `product_account_links`
> (`20260815090000_user_uoa_subject_keying`; a subject mapping to two users
> was left NULL on both — operator resolution, never a guess). UOA principal
> resolution is subject-first with a one-time email **adoption** limited to
> unbound rows (`uoaSub IS NULL`), and an email row bound to a different
> subject fails login closed with `409 UOA_IDENTITY_CONFLICT`
> (`api/src/services/workspace-principal.ts`). The per-principal advisory
> lock is keyed on the subject with the email lock retained second (the
> adoption path and non-UOA logins still resolve through the unique email
> column). The switch materialization guard now compares `User.uoaSub`
> against the verified session subject (`uoa-workspace-switch.ts`), and the
> SSO login path loads the session user by resolved id, not email
> (`auth-login.ts`). Generic (non-UOA) OIDC providers keep email keying
> unchanged. Deliberately **not** done here: email keeps its unique
> constraint and profile fields stay local (Phase 3), the password branch
> and `POST /api/users` are untouched (Phase 1 owns the mode gating), and
> `cli/src/super-admin.ts` still grants by email.

**Phase 3 — profile de-duplication.** Stop persisting `email`,
`displayName`, `avatarUrl`; delete the email→display-name synthesizer; serve
profile fields through a UOA-backed read (extending the existing
avatar-relay pattern) behind a **bounded in-memory TTL cache**. Decide
`pronouns`/avatar upload per ambiguity 6. Migration drops the columns for
UOA deployments (local mode keeps them per the Phase 0 decision).

> **Status (2026-08-15): step 1 landed, column drop pending** on branch
> `task/uoa-profile-authority`. Local profile *authority* is gone while the
> columns remain, now documented in `schema.prisma` as a non-authoritative
> mirror:
> - **The synthesizer is deleted.** `buildMeResponse` no longer manufactures a
>   name from the email local part (nor persists one on every `/api/auth/me` —
>   it now writes nothing), and `resolveIdentityDisplayName` returns only what
>   the provider asserted, `undefined` otherwise. `humanizeEmailLocalPart`,
>   `isEmailLikeDisplayName`, and `resolveStoredDisplayName` are gone. A row
>   the provider has not named carries its email address.
> - **The mirror re-syncs from verified claims** — one function
>   (`api/src/services/uoa-profile-mirror.ts`), called from
>   `ensureWorkspacePrincipal` (SSO login **and** workspace-switch
>   materialization) and from the UOA refresh coordinator (best-effort; a
>   display-data write must never break renewal). Only asserted fields, only
>   when they differ. The narrow "stored name equals the email" repair in
>   `auth-login.ts` is replaced by it.
> - **Avatar authority moved.** Client precedence is UOA relay → local upload →
>   provider `picture` → initials; **Gravatar is removed entirely** (chain,
>   `buildGravatarUrl`, and the `gravatarUrl` field on every API record). A UOA
>   session's `PATCH /api/auth/me/avatar` answers `403 PROFILE_MANAGED_BY_SSO`,
>   and `PUT`/`DELETE /api/auth/me/avatar/uoa` relay to
>   `/domain/users/:uoaSub/avatar` using the actor's own `User.uoaSub` (never a
>   request-supplied subject), reusing the `uoa-avatar.ts` transport and a
>   shared multipart/relay-error module with the workspace-avatar route. The
>   profile panel routes by `me.auth.providerType`.
>
> Deliberately **not** done here: the columns still exist and `email` is
> unchanged, there is no in-memory profile directory or UOA-backed profile
> read, `pronouns` is untouched (ambiguity 6 still open for it), and roles /
> rosters / the workspace-directory cache belong to phases 4–6.

**Phase 4 — roles and membership from UOA.** Map the (currently discarded)
`org_role` claim; re-resolve team role at every session refresh (the refresh
path already re-resolves membership — swap its source to the signed UOA
claims); remove local role-mutation and deactivation routes in UOA mode
(deactivation and last-owner invariants become UOA's); memberships become a
projection of the session's signed claims, not an authority.

> **Status (2026-08-15): landed** on branch `task/uoa-role-authority`.
> One projection function (`api/src/services/uoa-roles.ts`) maps the verified
> `org.org_role` and `org.team_roles[workspaceId]` claims onto
> `organization_members` / `project_members` / `team_members`, and all three
> claim-carrying paths re-apply it: **login** (`resolveUoaWorkspaceContext` →
> `ensureWorkspacePrincipal`), **workspace switch** (`materializeUoaWorkspaceSwitch`
> runs the same path against UOA's target claims), and **refresh** — the
> refreshed access token's `org` claim is threaded through the rotation
> (`uoa-refresh-coordinator` → `refresh-token` → `refresh-token-uoa`
> `RotatedUoaCredential.workspace` → `refresh-token-uoa-rotation`) and projected
> inside the family transaction by `advanceUoaBindingInTransaction`, so the
> reissued token already carries the new role. The membership upserts stay
> create-only; role changes come from the projection alone. Two deliberate
> carve-outs, both documented in the spec: **an absent claim projects nothing**
> (generic OIDC, `local` mode, and the legacy no-workspace login are unchanged,
> and the first-materializer team-`owner` rule survives only for a workspace UOA
> sent no role for), and **the projection never removes the last active owner of
> the shared local organization** (all UOA orgs share one local `Organization`,
> and the SSO-first bootstrap owner would otherwise demote themselves on their
> own first login) — checked under the same `FOR UPDATE` owner lock the local
> mutators take, now shared from `api/src/services/organization-owner-lock.ts`.
> The six local membership mutators (`PATCH /api/users/:userId`,
> `POST /api/users/:userId/deactivate|reactivate`,
> `POST /api/teams/:teamId/members`, `POST|DELETE /api/projects/:projectId/members…`)
> answer `403 LOCAL_MEMBERSHIP_MANAGEMENT_DISABLED` outside `local` mode, gated
> after the owner check and before any body parse or DB read
> (`api/src/routes/membership-mode-gate.ts`), so the last-owner invariant is now
> a local-mode rule for those routes and the service functions are untouched.
> Tests: `api/test/workspace-context.test.ts`,
> `api/test/uoa-session-context.test.ts`,
> `api/test/local-membership-mode-gate.test.ts`. Deliberately **not** done here:
> `ChannelMember` and knowledge/dashboard grants stay product-local and mutable;
> `GET /api/users` and the roster reads still come from local rows (phase 5);
> profile fields and the workspace-directory cache are phases 3 and 6.

**Phase 5 — rosters + invitations on the UOA API.** *Largely landed
2026-08-15* (`api/src/services/uoa-org-roster.ts`,
`api/src/routes/workspace-members.ts`, `admin/src/pages/settings/WorkspaceMembersSection.tsx`,
`docs/deployment-modes-and-auth-spec/overview.md` §4.6): the UOA client calls exist for
the roster read, team role change, team removal, organisation
deactivate/reactivate, and invitation create/list/resend/revoke/approve/deny, all in
UOA **backend mode** (domain-hash bearer, no access token, gated by
`org_features.backend_org_management`), all keyed on the UOA subject, with
acceptance hosted by UOA. Ambiguity 2 is therefore resolved: the UOA-side
contract *is* available to RP backends.

Remaining in this phase:

- ✅ **Invitation revoke — landed both sides 2026-08-15.** Raising it with the
  UOA team was the right move rather than building a local substitute: UOA now
  exposes
  `DELETE /org/organisations/:orgId/teams/:teamId/invitations/:inviteId` in
  backend mode (domain-hash bearer, no `X-UOA-Access-Token`, gated by the same
  `org_features.backend_org_management` flag Nessie already sends). Nessie's
  side is `revokeTeamInvitation` (`packages/workspace-admin/src/uoa-org-roster.ts`,
  re-exported by `api/src/services/uoa-org-roster.ts`),
  `POST /api/workspace/invitations/:inviteId/revoke`
  (`api/src/routes/workspace-members.ts`, owner/admin-gated exactly like the
  sibling invitation mutations), and a Revoke button beside Resend on each sent
  invitation (`admin/src/pages/settings/WorkspaceMembersSection.tsx`). Three
  outcomes, three different answers: revoking twice is a success because UOA's
  delete is idempotent, an **already accepted** invitation is a `409` mapped to
  its own `UoaInvitationAlreadyAcceptedError` → `409
  INVITATION_ALREADY_ACCEPTED` ("remove the member instead" is a different
  decision, so it is refused in words rather than reinterpreted), and an
  unknown or foreign invite id stays a generic `404` that reveals nothing about
  other workspaces. A `200` whose body is not the agreed `{ ok: true }` is an
  outage, not a silent revoke. `deny` keeps its own meaning — the review verb
  for an invitation that was never sent.
  **Activation is a UOA deployment matter:** the relay is live in Nessie from
  this change, and starts working against a given UOA instance once that
  instance ships the endpoint (and, where the config JWT is cached, once the
  domain's config is re-read/redeployed — a UOA-side coupling, not a Nessie
  one). Until then the button reports UOA's own refusal; nothing else in the
  page changes.
- ✅ **Member avatars in the roster** — *landed 2026-08-15.* UOA's `/org/*`
  member records carry an `avatarImageUrl` in the `/domain/users/:userId/avatar`
  form, which needs the domain-hash bearer — there is no public user-avatar
  route to hand a browser, and `GET /api/users/:userId/avatar` is keyed by a
  *Nessie* user id a roster member may not have. `GET
  /api/workspace/members/:uoaSub/avatar`
  (`api/src/routes/workspace-members.ts`) relays it under the roster read's own
  entitlement, and **verifies the subject is in that workspace's roster before
  relaying** (`api/src/services/uoa-roster-subjects.ts` — the same
  `listWorkspaceMembers` read, cached in-memory per workspace for 30 s so a
  roster of N rows asks UOA once, not N times). The domain-hash path is full
  trust: without that check any member could read any domain user's picture by
  guessing subjects. A foreign subject and a subject with no picture are the
  same cacheable 404. The roster renders it through the shared `UserAvatar`
  (`uoaSub` prop → this relay; `userId` → the organisation-scoped one), falling
  back to initials exactly as before.
- **Re-point PA `people_search`** (`worker/src/run/pa-tools/people.ts`) at the
  same service function, following the pa-tools mirror-the-route pattern.
- ✅ **PA `people_search` re-pointed 2026-08-15** at the same service function
  (`worker/src/run/pa-tools/people.ts` → `@nessie/workspace-admin`
  `resolveUoaRosterWorkspace` + `listWorkspaceMembers`), following the
  pa-tools mirror-the-route pattern: the roster module and the UOA settings
  resolution (`loadUoaSettings`/`clientHash`) moved into the package and the
  api services re-export them. UOA-linked teams answer from the roster
  (60-second bounded in-memory cache per org/team); unlinked teams keep the
  local search; a failed UOA read is an error in words, never a local answer.
- **Replace `POST /api/users` outright**, together with the remaining local
  membership mutations (`POST /api/teams/:teamId/members`, project member CRUD)
  and the Members page's local branch.
- **Doorways.** ✅ **Nav gate landed 2026-08-15.** The sidebar entry now follows
  the API's entitlement instead of `ownerOnly`: an item may carry its own
  `visibleTo(viewer)` rule (`ownerOnly` stays the shorthand for the common
  case), and Settings → Members uses `isUoaSession || isOwner`
  (`admin/src/layouts/admin-shell/AdminSidebarNav.tsx`, viewer assembled from
  `useAdminShell`'s `isOwner`/`isSuperAdmin`/`isUoaSession`). The UOA branch of
  `SettingsMembersPage.tsx` no longer redirects a non-admin to the profile: it
  renders `WorkspaceMembersSection` with `canManage={isOwner || isAdmin}`, so a
  member sees the read-only roster and the mutation controls (role, activation,
  removal, invite form, invitation actions) appear only for the roles
  `/api/workspace/members` would accept. A local session is untouched —
  owner-only nav, owner-only page. Test:
  `admin/test/members-nav-doorway.test.ts`. Still open: the read-only roster
  wants an in-context entry point of its own (a people surface reachable from
  where the question arises, not only from Settings).

**Phase 6 — cache hygiene.** ✅ **Workspace directory landed 2026-08-15.** The
directory now lives only in a bounded in-memory cache
(`api/src/services/uoa-directory-cache.ts`: keyed per user, 30-minute TTL,
LRU-bounded at 10,000 users), written wherever `fetchUoaWorkspaceDirectory`
succeeds — login (`syncUoaProductAccountLinks`) and every rotation including a
workspace switch (`advanceUoaBindingInTransaction`) — and read by
`buildMeResponse`. The durable mirror is gone from both writers and from
existing rows (`20260815120000_drop_uoa_workspace_directory_mirror`). A cold
cache (fresh process, other replica) degrades to a directory derived only from
Nessie-owned data — the user's `TeamMember` rows joined to
`Team.externalWorkspaceId`/`externalOrgId`, local team name as the label, UOA's
deterministic per-team avatar URL — so the switcher keeps working across a
restart; workspaces never materialized locally reappear at the next rotation.
Still open in this phase: sweep the remaining plain-`fetch` UOA avatar client
onto `safeFetch`.

**Phase 7 — switching UX.** Wire `teamHint` into the `INTERACTION_REQUIRED`
recovery path so a refused switch launches SSO for the **exact** org/team;
capture and restore the pre-switch route instead of hard-navigating
`/channels`; unify the three `LoginPage.tsx` callback listeners into one
lifecycle that also runs while **authenticated**, so the desktop/native
"Add a workspace" round-trip stops being silently swallowed
(`external-auth-bridge.ts:53-57`). Add the missing component-level test for
select → navigate → error-render.
