# Nessie × UnlikeOtherAI SSO — where we are (gap analysis, 2026-08-14)

> **Status:** assessment only — no code changed. Evidence verified against the
> tree at `7dd1de9e` (main). Three deep sweeps (server auth flow, local
> identity data model, per-platform clients) plus direct spot-verification of
> every load-bearing claim.
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

The **session plumbing** (encrypted UOA refresh credential, epoch binding,
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
| 0.1 | No local-password accounts | **VIOLATES** | `User.passwordHash` (`api/prisma/schema.prisma:747`, scrypt in `api/src/auth/password.ts`); password login branch `api/src/routes/auth-login.ts:222-278` — **not mode-gated**, runs even in hosted (the `local` provider is only *advertised* in local mode, `api/src/services/auth.ts:58`); `POST /api/users` creates accounts with passwords (`api/src/routes/users.ts:51-116`, hash at `:73`); `POST /api/auth/password` (`api/src/routes/auth-security.ts:74-147`); bootstrap owner with password (`api/src/routes/auth-core.ts:235-319`). Login UI for it exists but is gated to local mode (`admin/src/pages/LoginPage.tsx:82,400-439`) |
| 0.2 | No duplicate SSO-owned data (email, name, avatar, memberships, roles, invitations) | **VIOLATES** | `User.email/displayName/avatarUrl/avatarAttachmentId/pronouns` (`schema.prisma:745-753`); roles owned + mutated locally (`api/src/services/users.ts:182-187,205-210`); UOA workspace directory persisted durably in `ProductAccountLink.metadata.workspaceDirectory` (`api/src/services/uoa-session-context.ts:239-247`) — brief allows in-memory cache only |
| 0.3 | Retain only UOA subject + extension data + encrypted refresh material | **Implemented (for what it covers)** | `UoaSessionCredential` AES-256-GCM (`schema.prisma:854-885`, `packages/runtime/src/secret-crypto.ts`); `ProductAccountLink.uoaSub/uoaTokenVersion` (`schema.prisma:1036-1037`); `Team.externalWorkspaceId/externalOrgId` (`schema.prisma:1234-1235`); `User.preferences/tokenVersion` legitimately local. But the subject is **not** on `User` — it lives only org-scoped on the link row, which is why email became the join key |
| 1 | One shared switcher, all platforms, grouped by UOA org id, UOA-backed avatars, active state | **Implemented** (one ambiguity) | One shared component with render variants (`admin/src/layouts/admin-shell/WorkspaceSwitcher.tsx:212-214`); native iPhone/iPad controls are trigger-only chrome calling into the same web menu (`mobile/src/lib/native-webview-actions.ts:25-27`, `mobile/src/components/NativePhoneHeader.tsx:140-161`, `IpadNativeWorkspaceSwitcher.tsx:29-51`); Tauri loads the hosted admin (`desktop/src-tauri/src/lib.rs:14-30`). Grouped by raw UOA org id (`admin/src/lib/workspaces.ts:62-79`); avatars via authed relay `/api/teams/:teamId/avatar` → UOA directory `avatarImageUrl` → initials (`admin/src/components/primitives/WorkspaceAvatar.tsx:53-59`); active state `WorkspaceSwitcher.tsx:124`. **Ambiguity:** the Swift app in `macos/` has no workspace/auth concept at all — if "Mac" means it rather than the Tauri desktop, that platform is a no-op |
| 2a | Silent switch on valid renewable proof | **Implemented** | `POST /api/auth/uoa/workspace` (`api/src/routes/auth-uoa-workspace.ts:48`) via UOA grant `urn:unlikeotherai:params:oauth:grant-type:workspace-switch` (`api/src/services/uoa-session.ts:66-67,343-370`); crash-safe `UoaWorkspaceSwitchIntent` (`schema.prisma:887-907`, 13-field source match); client branch `WorkspaceSwitcher.tsx:256-298` |
| 2b | Fresh-proof/2FA path opens SSO for the **exact** org/team, returns to the **same screen** | **Missing** | `INTERACTION_REQUIRED` renders a text message only — no re-auth launch (`admin/src/layouts/admin-shell/workspace-switch-recovery.ts:36-45`). The `teamHint` plumbing exists end-to-end (`packages/client-core/src/pkce.ts:27,84-86` → `api/src/services/uoa-auth.ts:341-343` `team_hint`) but has **zero callers** — both `startExternalSignIn` call sites omit it (`WorkspaceSwitcher.tsx:302`, `LoginPage.tsx:133`), so "Add a workspace" gets UOA's generic chooser. Every success path hard-navigates `/channels` `{replace:true}` (`WorkspaceSwitcher.tsx:281,291`; `LoginPage.tsx:121`) — nothing captures/restores the pre-switch route |
| 2c | Never log out on failed/cancelled/unavailable switch | **Implemented (one edge)** | Safe refusals (`WORKSPACE_NOT_AVAILABLE`, `INTERACTION_REQUIRED`, `WORKSPACE_SWITCH_CONFLICT`) preserve the session (`auth-uoa-workspace.ts:21-33`, `uoa-session.ts:327-333`); native cancel normalizes to a benign state (`mobile/src/lib/external-auth-bridge.ts:35-37`); ambiguous failures reconcile through the refresh funnel and can be detected as success (`workspace-switch-recovery.ts:21-25,70-73`). One real logout path: a definitive upstream error revokes the family server-side (`auth-uoa-workspace.ts:126-133` → 401 `WORKSPACE_SWITCH_REAUTH_REQUIRED`) and the client's reconcile then clears the session (`packages/client-core/src/auth-session.ts:138-141`) — defensible (the credential is genuinely dead) but a literal-reading violation to sign off on |
| 2d | Never apply a returned session unless same subject/provider + exact requested org/team | **Implemented** | Layered: pre-flight `confirmUoaDirectServiceAccess` for the target (`api/src/services/uoa-workspace-switch.ts:49-71`); upstream response check (`uoa-session.ts:405-418`); `validateUoaRefresh` (`api/src/services/refresh-token-uoa.ts:167-182`); materialization re-check (`uoa-workspace-switch.ts:88-95`). Caveat: the materialization guard compares **email**, not sub (`uoa-workspace-switch.ts:96-107`) — see V1 |
| 2e | One shared PKCE/callback lifecycle across platforms | **Partial → VIOLATES in practice** | PKCE *generation* is genuinely shared (`packages/client-core/src/pkce.ts:5-9,51-95`); redirect URIs allowlisted to exactly two values (`api/src/services/uoa-auth.ts:255-264`). But *callback handling* is three separate listeners in `LoginPage.tsx` (web `:148-157`, RN `:161-200`, Tauri `:202-257`), and the native two bail unless `sessionState === 'unauthenticated'` — so an authenticated "Add a workspace" round-trip works **on web only**; on desktop/native the `nessie://auth/callback` returns to no handler and is silently swallowed (`external-auth-bridge.ts:53-57`). Also: UOA authorize carries no `state` param (CSRF via sessionStorage PKCE, `uoa-auth.ts:322-326`) |
| 3a | Rosters are SSO API features | **Missing + VIOLATES** | No UOA member-roster call exists anywhere; `/org/me` returns only the signed-in user's own workspaces (`api/src/services/uoa-workspace-directory.ts`). Local substitutes: `GET /api/users` from local rows; `POST /api/teams/:teamId/members` (`api/src/routes/teams.ts:81-130`); project member CRUD (`api/src/routes/projects.ts:240-311`); PA `people_search` reads local users by name/email substring (`worker/src/run/pa-tools/people.ts:17-46`) |
| 3b | Invitations created/resent/revoked/approved/declined/accepted via SSO; acceptance hosted by SSO | **Missing + VIOLATES** | No invitation model, token, email, or endpoint exists (grep-clean; only agent-mention invites and executor pairing use the word). The substitute is worse: admin Members page submits `{displayName, email, password, role}` to `POST /api/users` (`admin/src/pages/settings/SettingsMembersPage.tsx:141-153`) — account + credential + roster placement with zero UOA involvement and no consent flow |
| 3c | Match by UOA subject + org/team ids, never local email rows | **VIOLATES** | Principal resolution is `user.findUnique({ where: { email } })` (`api/src/services/workspace-context.ts:379`, `:194-205`); the per-principal advisory lock is keyed on the **email string** (`:190`); `auth-login.ts:120,134` (`loadSessionUserByEmail`); switch guard compares emails (`uoa-workspace-switch.ts:96-107`); super-admin grant by email (`cli/src/super-admin.ts:56-66`). Self-documented takeover risk at `api/src/services/external-auth.ts:209-217`. Correct sub-matching exists only in session/billing paths (`uoa-session-context.ts:102-106`, `packages/runtime/src/uoa-delegated-identity.ts:293-301`) |

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
4. **Locally-owned roles and membership lifecycle** — org/project/team roles
   in local rows, mutated by `PATCH /api/users/:userId`,
   `POST /api/teams/:teamId/members`, project member CRUD;
   `OrganizationMember.deactivatedAt` as a local membership kill-switch
   (`api/src/routes/users.ts:162-211`). UOA's `org_role` claim is parsed then
   **discarded** — org role is hardcoded `'member'` (`uoa-session.ts:126` →
   `workspace-context.ts:212`); the team role is mapped once at first join and
   never re-synced (`workspace-context.ts:42-52,74-95`, upserts with
   `update: {}`), so a UOA demotion never propagates. The last-owner
   invariant is enforced locally (`api/src/services/users.ts:147-170`).
5. **`POST /api/users` — the invitation-system-shaped hole** — creates the
   human, the credential, and full roster placement in one local call, exposed
   in the admin UI. This is the "proposed local copy" case the rule exists
   for: do not extend it; replace it with the UOA invitation API.
6. **Durable caches of UOA data** — the workspace directory (labels, org
   names, avatar URLs) persisted in `ProductAccountLink.metadata`
   (`uoa-session-context.ts:239-247`; written via `syncUoaProductAccountLinks`,
   `api/src/services/integrations.ts:86-150`; served from Postgres on every
   `/api/auth/me`, `api/src/services/auth.ts:223-244` — UOA is only consulted
   at login/rotation). Documented as non-authoritative and rotation-refreshed
   — but the brief allows an **in-memory** cache only.
   `activeOrgId`/`activeTeamId` last-seen columns are borderline
   (session-handle-adjacent, explicitly non-authoritative).
7. **PA people directory** — the agent tool answers "who is X" from the local
   user table by name/email substring (`worker/src/run/pa-tools/people.ts`),
   making Nessie the roster of record for agents too.
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

1. **Brief vs deployment modes.** `docs/deployment-modes-and-auth-spec.md`
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

**Phase 1 — stop the bleeding (small, immediate).** Mode-gate the local
identity stack: in UOA deployments refuse the password branch of
`POST /api/auth/session`, `POST /api/users`, `POST /api/auth/password`, and
password bootstrap (SSO-first bootstrap already covers first login). Point
the admin Members page at read-only data meanwhile. No schema change yet.

**Phase 2 — subject keying.** Add `User.uoaSub` (unique, nullable for
non-UOA modes); backfill from linked `ProductAccountLink` rows in one
migration; flag unmatched users for re-link at next login. Switch principal
resolution, the advisory lock, login matching, and the workspace-switch
binding guard from email to subject. Email leaves the unique constraint and
stops being a key.

**Phase 3 — profile de-duplication.** Stop persisting `email`,
`displayName`, `avatarUrl`; delete the email→display-name synthesizer; serve
profile fields through a UOA-backed read (extending the existing
avatar-relay pattern) behind a **bounded in-memory TTL cache**. Decide
`pronouns`/avatar upload per ambiguity 6. Migration drops the columns for
UOA deployments (local mode keeps them per the Phase 0 decision).

**Phase 4 — roles and membership from UOA.** Map the (currently discarded)
`org_role` claim; re-resolve team role at every session refresh (the refresh
path already re-resolves membership — swap its source to the signed UOA
claims); remove local role-mutation and deactivation routes in UOA mode
(deactivation and last-owner invariants become UOA's); memberships become a
projection of the session's signed claims, not an authority.

**Phase 5 — rosters + invitations on the UOA API.** Build the UOA client
calls for roster list and invitation create/resend/revoke/approve/decline
(acceptance stays hosted by UOA); rebuild the Members surface on them, per
rule zero with its in-context entry points; re-point the PA `people_search`
tool at the same service function (the pa-tools mirror-the-route pattern).
This replaces `POST /api/users` outright.

**Phase 6 — cache hygiene.** Move the workspace directory cache from
`ProductAccountLink.metadata` to the bounded in-memory cache (or record a
written waiver: durable, display-only, rotation-refreshed). Sweep the
remaining plain-`fetch` UOA avatar client onto `safeFetch`.

**Phase 7 — switching UX.** Wire `teamHint` into the `INTERACTION_REQUIRED`
recovery path so a refused switch launches SSO for the **exact** org/team;
capture and restore the pre-switch route instead of hard-navigating
`/channels`; unify the three `LoginPage.tsx` callback listeners into one
lifecycle that also runs while **authenticated**, so the desktop/native
"Add a workspace" round-trip stops being silently swallowed
(`external-auth-bridge.ts:53-57`). Add the missing component-level test for
select → navigate → error-render.
