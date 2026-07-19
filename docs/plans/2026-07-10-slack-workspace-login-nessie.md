# Slack-style workspace login → Nessie environments

> **Status:** Implemented (2026-07-10).
> **Scope:** `api/` (auth routing, workspace provisioning, UOA config JWT, schema),
> `admin/` (workspace switcher), `packages/client-core` (switch-context).
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

Switching between environments reuses the existing `POST /api/auth/switch-context`
(it already validates the full org/project/team triple) surfaced by a new
sidebar **workspace switcher**. Adding a workspace re-runs SSO so UOA's chooser
appears.

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
- `packages/client-core` `auth-session.ts` — `switchContext({ organizationId,
  projectId, teamId })` (POST `/api/auth/switch-context`, bearer + cookie).
- `AuthSessionProvider` exposes `switchContext`.
- `layouts/admin-shell/WorkspaceSwitcher.tsx` — a rail control listing the
  workspaces (teams) from `me.memberships`, switching the active one, plus
  "Add a workspace" (re-runs SSO → UOA chooser).
- `LoginPage` processes an OAuth `code` even when already authenticated (so
  "add a workspace" re-scopes the session).

## Security / compatibility
- Non-UOA providers are unaffected. Single-workspace UOA users are routed and
  projected from their sole active membership even when UOA auto-skips the
  chooser and omits `active`.
- `switch-context` still authorises membership server-side; `team_hint`/UI is a
  shortcut, never a trust boundary.
- Additive migration; existing installs keep their default org/team.

## Follow-ups (not in this change)
- Friendly workspace names: the UOA access token carries workspace **ids** only;
  auto-created teams are named `Workspace <shortid>` and renameable. Fetching the
  real name from UOA `GET /org/me` at login is a future enhancement.
- Reflecting UOA membership **removal/deactivation** back onto Nessie memberships.
