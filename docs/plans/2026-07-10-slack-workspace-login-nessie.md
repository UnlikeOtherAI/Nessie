# Slack-style workspace login → Nessie environments

> **Status:** Implemented (2026-07-10).
> **Scope:** `api/` (auth routing, workspace provisioning, UOA config JWT, schema),
> `admin/` (workspace switcher), `packages/client-core` (serialized session
> mutation and workspace-switch clients).
> **Companion:** UnlikeOtherAuthenticator (UOA)
> `Docs/plans/2026-07-07-slack-style-login-and-membership.md` — the auth-side
> Slack-style login/workspace chooser this consumes.

## Problem

Every user who signed in through UOA landed in the **same** Nessie account. Two
independent bugs caused it, both in `POST /api/auth/session` (the SSO branch):

1. **Provisioning ignored the workspace.** A new SSO user was always created in
   *the first organization ever created*
   (`organization.findFirst({ orderBy: { createdAt: 'asc' } })`) and dropped into
   its default project/team — regardless of which UOA workspace they selected.
2. **The session ignored the workspace.** The session was always built from
   `sessionUser.organizationMembers[0]` / `teamMembers[0]` (the *first* membership),
   so the parsed UOA `active { orgId, teamId }` workspace claim was thrown away.

On top of that, Nessie's **config JWT never enabled the workspace chooser**
(`login_flow.workspace_selection`), so UOA never presented the Slack-style
"choose a workspace" screen and never populated the `active` claim.

## Model decision

> **Superseded 2026-08-15 — the org half only.** UOA's move to a
> relationship-based access model made organisations first-class (a user can
> belong to several; a workspace is created *inside* one), so the
> "one shared Nessie Organization" flattening below no longer holds: there is
> now **one Nessie `Organization` per UOA organisation**, keyed on
> `Organization.externalOrgId`. Everything below the org level in this section
> is unchanged — a workspace is still its own Project + Team + `#general`,
> bound by `Team.externalWorkspaceId`, and the switch routes and directory
> behaviour described here still apply. The record below is kept as written
> (including the "why not the alternatives" reasoning, which was correct for
> the UOA model of the time). New model, migration, and verification:
> [2026-08-15-uoa-org-tenancy.md](2026-08-15-uoa-org-tenancy.md).

UOA gives each user **one org but many teams (workspaces) per domain**
(UOA design §9.1). Nessie's isolation boundary is the **Organization**; a Team is
a sub-unit inside a Project inside an Organization.

Chosen mapping (product decision, 2026-07-10):

- **One shared Nessie Organization** (the bootstrap default org) — the single
  "account": shared member directory, budget, org settings.
- **Each UOA workspace → its own Nessie Project + Team (+ `#general` channel)**
  inside that shared org. The Team is bound to the UOA workspace by
  `Team.externalWorkspaceId` (= UOA `active.teamId`). Channels, agents and policy
  evaluation scope by the active `proj`/`team`, so each workspace is an isolated
  environment while the account stays shared.
- **Auto-provision on first login** (self-serve): the first person to sign into a
  workspace materialises its Project/Team/`#general` and becomes that team's
  `owner`. Everyone shares the org as `member` (the very first bootstrap user is
  the org `owner`).

Local sessions use `POST /api/auth/switch-context` after it validates the full
org/project/team triple. Renewable UOA sessions use Nessie's dedicated
`POST /api/auth/uoa/workspace` route: Nessie presents its server-held upstream
refresh proof to UOA's explicit workspace-switch grant, and both services
atomically rotate their session families to the exact authorized external
organisation/team. The directory is only a list of choices, never authority.
This makes every authorized workspace selectable without a hosted-login detour
or allowing the local and external session scopes to drift.

The directory itself is UOA-owned data and is held only in the API's bounded in-memory cache
(`api/src/services/uoa-directory-cache.ts`, 30-minute TTL, 10,000-user LRU), written at login and
at every rotation and never persisted; a cold cache degrades to the local `Team` → UOA workspace
mapping. The same `/auth/me` hydration reconstructs a workspace's credential-free UOA avatar URL
from its external team id whenever an entry carries no `avatarImageUrl`. It uses
UOA's supported `size=128` image parameter so clients do not reuse a cached response from before
cross-origin embedding was enabled; the shared workspace menu rows use that fallback directly.

Why not the alternatives: mapping a workspace to a whole **Organization** would
mean provisioning a new tenant per workspace (heavier, and UOA's one-org-per-user
means the UOA org can't be the key); mapping to a **Team under one shared
project** would leak agents/policies across workspaces (both scope by project).

## Changes

### Schema (`api/prisma/schema.prisma`, migration `…_team_external_workspace`)
- `Team.externalWorkspaceId String? @unique` — binds a Nessie team to a UOA
  workspace (`active.teamId`). One Nessie team per workspace.
- `Team.externalOrgId String?` — the UOA org id, for traceability.

### API
- **`services/workspace-context.ts`** (new) — `resolveUoaWorkspaceContext`:
  ensures the shared org + the user exist, then resolves-or-creates the workspace
  Project/Team/`#general` and the user's memberships, returning the
  `{ userId, organizationId, projectId, teamId, orgRole }` the session is scoped
  to. Role mapping: UOA `owner|admin|member` → Nessie `MemberRole`; the first
  materialiser of a workspace owns that team.
- **`routes/auth.ts`** — the SSO branch delegates to `resolveUoaWorkspaceContext`
  and builds the session from the resolved workspace context instead of
  `organizationMembers[0]`. UOA may omit `active` when `auto` skips the chooser
  for a sole active team; that sole `org.teams[]` entry is the selected
  workspace. The same centralized selection rule drives session routing, the
  `Team.external*` binding, and every `ProductAccountLink.active*` projection so
  delegated billing cannot lose tenancy. No resolvable workspace (chooser off,
  no team, or multiple teams without `active`) falls back to the user's
  existing/default team, so non-UOA OIDC is unchanged.
- **`services/uoa-auth.ts`** — the config JWT now advertises
  `login_flow: { workspace_selection: "auto", email_code_enabled: true }` so UOA
  shows the chooser and issues the `active` claim.

### Admin
- `packages/client-core` `auth-session.ts` — local `switchContext({
  organizationId, projectId, teamId })` and UOA `switchUoaWorkspace({
  organizationId, teamId })`, both with bearer + cookie. Refresh and switching
  share one session-mutation coordinator so a delayed response cannot restore
  an older access token.
- `AuthSessionProvider` exposes both switch operations and a payload-aware
  reconciliation refresh. Before any mutation applies a replacement session,
  it cancels and clears tenant queries when the user or active
  organisation/project/team changed; an ordinary refresh therefore handles a
  shared-cookie switch made in another tab. Clearing authentication also clears
  the cache.
- `layouts/admin-shell/WorkspaceSwitcher.tsx` — a rail control. Local sessions
  list `me.memberships` and switch context; UOA sessions list the named UOA
  directory cached at authentication and switch directly inside Nessie. The menu
  remains open with a row spinner during the request. After an ambiguous error
  it reconciles through ordinary refresh: a recovered target completes the
  navigation, a recovered source is named accurately, and an unconfirmed state
  never claims the source was retained. "Add a workspace" still opens the full
  UOA chooser.
- `LoginPage` processes an OAuth `code` even when already authenticated (so
  "add a workspace" re-scopes the session).

## Security / compatibility
- Non-UOA providers are unaffected. Single-workspace UOA users are routed and
  projected from their sole active membership even when UOA auto-skips the
  chooser and omits `active`.
- Both switch routes authorize server-side. A UOA target is accepted only after
  UOA validates the rotating source session, product workspace policy, current
  membership, and any target 2FA requirement; the directory/UI is never a trust
  boundary.
- Additive migration; existing installs keep their default org/team.

## Follow-ups

- **Completed 2026-08-13:** Nessie fetches the entitlement-scoped UOA
  `GET /org/me` directory at interactive login, retains the organisation and
  team names plus public workspace-avatar URLs, and renders teams grouped under
  their organisation in the shared desktop/iPad/phone switcher.
- **Completed 2026-08-13:** Selecting an existing UOA workspace rotates the
  signed UOA and Nessie sessions in place. Only adding a workspace or satisfying
  an exceptional stronger sign-in requirement leaves the app for hosted UOA.
- Reflecting UOA membership **removal/deactivation** back onto Nessie memberships.
