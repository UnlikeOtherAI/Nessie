# Admin overhaul: build plan and route map

**Status:** in progress · **Plan:** [2026-09-26-admin-ux-overhaul.md](2026-09-26-admin-ux-overhaul.md) ·
**Integration branch:** `feat/admin-overhaul` ·
**Task branches:** `feat/admin-overhaul-<task>`, each in its own worktree ·
**Landing:** one pull request to `main` per phase, merged when CI is green.

This file is the contract every build task follows. The plan says what the
admin becomes and why; this file says exactly which route becomes which, who
does what, and how each task proves it is done. It also records the decisions
taken after two independent pre-build reviews (Kimi K3 and Codex) checked the
plan against the code.

## Table of Contents

- [Rules for every task](#rules-for-every-task)
- [Decisions from the pre-build reviews](#decisions-from-the-pre-build-reviews)
- [The route map](#the-route-map)
- [Query intents that move with their route](#query-intents-that-move-with-their-route)
- [Sidebar, menus and roots](#sidebar-menus-and-roots)
- [Phase 1: structure](#phase-1-structure)
- [Later phases](#later-phases)
- [Verification of a phase](#verification-of-a-phase)

## Rules for every task

1. **Worktree and branch.** Work only in your own worktree, on a branch from
   `feat/admin-overhaul`. Commit as you go with the attribution line, push the
   branch after every commit, and never touch another worktree.
2. **Read first.** `AGENTS.md` (Rule zero, Workflow, Code Quality),
   `docs/navigation/overview.md` and the chapters it lists,
   `docs/standards/design-system.md`, the plan's §6 to §8, and this file.
3. **Greenfield, no redirects.** Old routes are deleted, including every
   legacy redirect row in `router.tsx` and `navigation/surfaces.ts`, and pages
   that no longer exist are deleted. Every in-app `Link`, `navigate()` target,
   `parentOf` in `navigation/surface-parents.ts` and the registries, alert deep
   link in `facades/alerts`, header Back target, menu item and test assertion
   moves to the new route in the same change. Nothing may link to a path that
   no longer exists: a grep of `admin/src` for `'/settings/`, `'/agents`,
   `'/apps`, `'/tokens`, `'/audit`, `'/policy` and `'/ops` must return only
   the new families.
4. **The navigation framework is the only way.** A route exists in
   `router.tsx` and in the surface registry with depth, parent and identity;
   page and filter state is a query param written with `replace`; one
   `ScreenHeader` per screen; every strip is `TabBar`; no new overlay family;
   phone roots are `contextualList` rows. `node scripts/lint-navigation-surfaces.mjs`
   passes.
5. **One component per surface.** A thing shown at two scopes is one
   component with a scope prop. `SecretsPanel`, `MembersRosterPanel`,
   `ModelAvailabilitySettings`, `CloudBrowserPanel`, `LocalInferenceEnablement`
   and `MailboxConnectionsPanel` already are; reuse them, never copy them.
6. **Code quality gates.** Files under 500 lines; `node scripts/lint-admin-layers.mjs`
   passes; colours are tokens; no nested cards; no `any`; no default exports.
7. **Vocabulary.** Every label you add or touch follows the plan's §7 table.
   "Organisation" in labels, never "Organization". No infrastructure vendor or
   protocol name (UOA, Infisical, Ledger, Browserbase, MCP, IMAP, OAuth) in a
   label or heading; the services people connect (Google Workspace, Microsoft
   365, Slack, Jira, Linear, GitHub, Trello) are named by their names.
8. **Docs move with routes.** Any document that describes current behaviour
   and names a route or label you changed is updated in the same change:
   `docs/standards/*`, `docs/navigation/*`, `docs/testing/*`, the guides at
   `docs/*.md`, `CLAUDE.md`, `AGENTS.md`, and `web/`. Historical records
   (`docs/done/*`, dated `docs/plans/*` other than the two overhaul documents)
   are not rewritten.
9. **Prove it.** Before reporting, run from the repository root and report the
   real exit code of each:
   - `node scripts/lint-navigation-surfaces.mjs`
   - `node scripts/lint-admin-layers.mjs`
   - `node scripts/lint-markdown-structure.mjs`
   - `pnpm exec turbo run typecheck --filter=@nessie/admin`
   - `pnpm exec turbo run lint --filter=@nessie/admin`
   - `DATABASE_URL=postgresql://nessie:nessie@127.0.0.1:55432/nessie pnpm exec turbo run test --filter=@nessie/admin`
   - a headless Playwright screenshot of every route you added or moved, at
     1280 px and 390 px, using the harness in `admin/e2e/navigation/lib`
     (`startApi`, `startAdmin`, dev-login) on the port pair this file
     assigns to your task, and read each screenshot before claiming it renders.
10. **Report.** Files changed, what moved where, what you could not finish and
    why, the commands above with their results, and the screenshot paths.

## Decisions from the pre-build reviews

Two reviewers read the plan against the code before this build started.
These are the decisions taken on what they found; each is binding on the
tasks below.

- **No redirects, and every emitter changes.** The plan's earlier sentences
  about redirects are superseded. Every place outside `admin/src` that mints,
  links, asserts or documents an admin route changes in T4 (the list is in
  that task). A paired-agent verification URI printed before the deploy is
  restarted; `docs/standards/paired-agents.md` drops its old-route redirect
  contract and names the new route.
- **Every query intent moves with its route.** The table below is part of the
  route map; a row is not done until its intents resolve at the new address.
- **Members keep their team roster.** Any member on an SSO session reads their
  own teams' rosters today; People keeps that. `/admin/people` carries a scope
  switch from T1 (Organisation for organisation administrators, plus each team
  the viewer belongs to), and the Organisation sidebar group renders whenever
  any of its items is visible, so a member sees "Organisation · People".
- **Security is not owner-only as a page.** The audit log stays owner-only;
  the programs-signed-in-as-people list, Allow pairing and revocation stay
  reachable by organisation administrators, as today.
- **"Apps and accounts" is renamed "Company connections"** (`/admin/connections`)
  so it cannot be confused with Apps.
- **Voice stays in the agent's Settings; manner moves to Instructions.**
- **Usage and limits never shows credits.** It shows local usage (tokens,
  estimated cost) and budgets in local units; credits stay on Credits and
  billing; the `?uoa_billing=` checkout return lands on `/admin/billing`.
- **Budget modes keep Inherit.** Off means inherit; the plain names are
  Inherit · Warn · Stop automations · Switch to a cheaper model · Unlimited.
- **A mailbox keeps two decisions.** The access row and the agent's mailbox
  tools stay two writes shown together; no write rewrites the other.
- **A person's own app install reaches their own requests without a grant**;
  shared installs stay pending until approved and off per agent until granted.
- **Agent assignment and sharing on a computer apply immediately**; only
  lifecycle changes take the password or code confirmation.
- **Identifiers.** The ban on ids outside Advanced does not cover security
  confirmations: "This device" shows the session id, pairing shows the
  fingerprint.
- **Reviewed drafts stay reachable across machines.** The Computers list keeps
  its Reviewed drafts header action (it shows reviews from machines the person
  can no longer open) as well as the per-computer Activity entry.
- **Local AI without a paired computer** stays where it is reachable: the
  Local AI section (Find Ollama on this computer, host status) lives on the
  Connected accounts page's AI plans tab, whether or not a computer is paired.
- **Held for later phases** (not lost): audit export needs an API route
  (phase 3); "agents still using a disabled model" needs a filtered agents
  read (phase 3); an ordinary member's Schedule tab stays read-only while
  trigger writes are owner-only (phase 2 copy); the conversation Details panel
  and the project overview route choice are phase 5.

## The route map

Old routes are removed without redirects. "Same page" means the existing page
component moves to the new route with its label changed as noted.

### Your settings (avatar menu; `/settings/*`)

| Old | New | Page |
|---|---|---|
| `/settings` | `/settings` | Phone: the Your settings list. Desktop: redirects to `/settings/profile` |
| `/settings/account?tab=profile` | `/settings/profile` | `SettingsProfilePage` without the Session card |
| `/settings/account?tab=notifications` | `/settings/notifications` | Same page |
| `/settings/account?tab=appearance` | `/settings/appearance` | Same page |
| `/settings/account?tab=security` | `/settings/security` | Sections: Active sessions · Programs signed in as you (today's personal Paired agents list, Pair an agent, `?code=` opens the decision dialog) · Password (local accounts) · This device (session id, issued, auto redirect) |
| `/settings/paired-agents/:credentialId` | `/settings/security/programs/:credentialId` | `PairedAgentDetailPage` |
| `/settings/account?tab=agents` | `/settings/accounts?tab=browsers` | Cloud browser panel and browser sign-ins, as a tab of Connected accounts |
| `/settings/connections?tab=…` | `/settings/accounts?tab=…` | `ConnectionsPage` (T3 re-tabs it) |
| `/settings/connections/:id` | `/settings/accounts/:id` | `ConnectionDetailPage` |
| `/settings/secrets` | `/settings/keys` | `SecretsPage`, titled Saved keys |
| `/settings/statuses`, `/settings/statuses/:id` | `/settings/status`, `/settings/status/:id` | `StatusesPage`, `StatusDetailPage`, titled Status |
| `/tokens` (member) | `/settings/usage` | `TokenUsagePage` (member projection); the row is shown only when the billing capability is available |
| (new) | `/settings/computers` | The computers list filtered to Mine · Shared with me, Pair a computer; rows open `/admin/computers/:id` |
| `/settings/agent-access` | removed | |
| `/settings/profile`, `/settings/security`, `/settings/notifications`, `/settings/appearance` (old redirects) | real routes now | |

### Admin (rail; `/admin/*`)

| Old | New | Page |
|---|---|---|
| `/settings` (Admin landing) | `/admin` | Phone: the Admin sidebar list. Desktop: redirects to `/admin/agents` |
| `/agents` | `/admin/agents` | `AgentsPage` |
| `/agents/designer`, `/agents/designer/:id` | `/admin/agents/designer`, `/admin/agents/designer/:id` | `AgentDesignerPage` (phase 2 folds it into the agent page) |
| `/agents/:id` | `/admin/agents/:id` | `AgentDetailPage` |
| `/agents/:id/mailbox` | `/admin/agents/:id/mailbox` | `AgentMailboxPage` |
| `/apps`, `/apps/:slug` | `/admin/apps`, `/admin/apps/:slug` | `AppsPage`, `AppDetailPage` |
| `/agents/executors` | `/admin/computers` | `ExecutorsPage`, titled Computers; "Pair a computer"; Reviewed drafts and Sessions header actions kept |
| `/agents/executor-sessions` | `/admin/computers/sessions` | `ExecutorSessionsPage` |
| `/agents/executors/:id` | `/admin/computers/:id` | `ExecutorDetailPage` |
| `/agents/executors/:id/sessions/:sid` | `/admin/computers/:id/sessions/:sid` | `ExecutorSessionPage` |
| `/agents/triggers` | `/admin/automations?tab=triggers` | `TriggersPage` inside the Automations page |
| `/agents/triggers/:id` | `/admin/automations/triggers/:id` | `TriggerDetailPage` |
| `/agents/task-sets` | `/admin/automations?tab=batch-jobs` | `TaskSetsPage`, titled Batch jobs |
| `/agents/task-sets/new`, `/agents/task-sets/:id` | `/admin/automations/batch-jobs/new`, `/admin/automations/batch-jobs/:id` | Same pages |
| `/agents/workflows` | `/admin/automations?tab=workflows` | `WorkflowsPage` unchanged inside |
| `/agents/workflow-designer`, `/agents/workflow-designer/:id` | `/admin/automations/workflows/designer`, `…/designer/:id` | `WorkflowDesignerPage` |
| `/settings/members`, `/settings/team/members` | `/admin/people?scope=organisation|team:<id>` | `MembersRosterPanel` with the scope switch; the local-install roster (`SettingsMembersPage`'s local sections, each person's agents, the agent buckets, Add member) at organisation scope; Automatic team access as its tab |
| (new) | `/admin/teams` | Teams list: name, picture, members count, Open |
| `/settings/team` | `/admin/teams/:teamId?tab=general` | `TeamProfilePage` content, plus the team's call provider (from Organisation › Agents) |
| `/settings/team` (Agents tab) | `/admin/teams/:teamId?tab=overrides` | T1: `TeamAgentsPage` content (cloud browser, AI on own computers) · T2: the team's effective values with inheritance chips, each opening `/admin/models` or `/admin/connections` at `?scope=team:<id>`, where the controls now live |
| `/settings/team/models` | T1: `/admin/teams/:teamId?tab=models` · T2: `/admin/models?scope=team:<id>` | `ModelAvailabilitySettings` with `teamId` |
| `/settings/team/secrets` | T1: `/admin/teams/:teamId?tab=keys` · T2: `/admin/keys?scope=team:<id>` | `SecretsPanel scope="team"` |
| `/settings/organization?tab=profile` | `/admin/organisation?tab=profile` | `OrganizationProfilePage` |
| `/settings/organization?tab=appearance` | `/admin/organisation?tab=appearance` | `OrganizationAppearancePage` |
| `/settings/organization?tab=agents` | `/admin/connections` | Company connections. T1: the former `OrganizationAgentsPage` content (shared mailboxes, company cloud browser; the call provider moves to the team page) · T2: the scope-switched page |
| `/settings/organization/models` | `/admin/models` | `OrganizationModelsPage` content, titled AI models |
| `/settings/organization/secrets` | `/admin/keys` | `SecretsPanel scope="organization"`, titled Keys |
| `/settings/organization/paired-agents` | `/admin/security?tab=programs` | `OrganizationPairedAgentsPage` content incl. Allow pairing, titled Programs signed in as people |
| `/settings/organization/paired-agents/:credentialId` | `/admin/security/programs/:credentialId` | `OrganizationPairedAgentDetailPage` |
| `/audit` | `/admin/security?tab=audit` | `AuditLogPage` content |
| `/ops/usage` | `/admin/usage` | `OperationalTelemetryPage`, titled Usage and limits (phase 6 splits telemetry and pricing out) |
| `/tokens` (manager) | `/admin/billing` | `TokenUsagePage` |
| `/agents/tools`, `/agents/tools/:id` | `/admin/advanced/tools`, `/admin/advanced/tools/:id` | `ToolsPage`, `ToolDetailPage`, titled Tool registry |
| `/policy` | `/admin/advanced/access-rules` | `PolicyPage`, titled Access rules |
| `/ops` | `/admin/advanced/health` | `OpsHealthPage`, titled System health |
| `/settings/push` | `/admin/advanced/push` | `PushCredentialsPage`, titled Mobile push setup |
| avatar menu › Debug | `/admin/advanced/debug` | The session-debug dialog's content as a page |
| `/workflows`, `/workflows/tools`, `/chats`, `/work`, `/settings/tools`, `/settings/agents` | removed | |

Unchanged: `/channels/*`, `/projects/*` (the project section labelled Executors
is retitled Computers), `/knowledge-base/*`, `/documents/*`, `/mail/*`,
`/alerts`, `/feedback`, `/search`, `/threads`, `/unread-messages`, `/login*`,
`/bootstrap`.

## Query intents that move with their route

| Old address | New address | Emitted by |
|---|---|---|
| `/settings/account?tab=profile|notifications|appearance|security` | the four `/settings/<page>` routes | shell, tests |
| `/settings/account?tab=agents` | `/settings/accounts?tab=browsers` | `api/src/routes/browser-cloud-agent-session.ts` banners |
| `/settings/organization?tab=agents` | `/admin/connections` | same banners |
| `/settings/organization?tab=appearance` | `/admin/organisation?tab=appearance` | `ColoursPanel`, docs |
| `/settings/connections?tab=<id>` | `/settings/accounts?tab=<id>` (T3 renames the ids) | alerts, model picker, PA tool copy |
| `/settings/connections?connected=&error=&provider=` | `/settings/accounts?connected=&error=&provider=` | `api/src/routes/comms/oauth-routes.ts`, `board-sources/callback-page.ts` |
| `/settings/connections?tab=inference#local-inference-host-<id>` | `/settings/accounts?tab=inference#local-inference-host-<id>` (T3: `?tab=ai`) | `facades/alerts/hooks.ts` |
| `/settings/members?membersTab=automatic&automaticMembershipRule=<id>` | `/admin/people?scope=organisation&tab=automatic&automaticMembershipRule=<id>` | `facades/alerts/hooks.ts` |
| `/settings/paired-agents?code=<code>` | `/settings/security?code=<code>` | `api/src/routes/mcp-agent-auth.ts` verification URI, `well-known-mcp-resource.ts` |
| `/apps?filter=installed` | `/admin/apps?filter=installed` | catalogue |
| `/apps/:slug?tab=overview|capabilities|accounts|agents&connect=true` | `/admin/apps/:slug` with the same params | app cards, custom-app discovery, setup cards |
| `/apps/:slug` → project `?section=sources&connect=<provider>` | unchanged project intent | `AppBoardSourceAction` |
| `/agents/:id?agentTab=<t>` | `/admin/agents/:id?agentTab=<t>` | alerts, e2e |
| `/agents/designer?designerSection=&designerMode=&visibility=&parentId=` and `returnTo` state | `/admin/agents/designer` with the same | Create menu, agent rows |
| `/agents/:id/mailbox?conversation=&mailboxFilter=` | `/admin/agents/:id/mailbox?…` | Email tab |
| `/agents/executors?create=personal|team|project`, `#confirmationToken`, `?accessChange=`, `?promotion=` | `/admin/computers?…` | avatar menu, cards, e-mails |
| `/agents/executors/:id?tab=agents|sessions|permissions|activity` | `/admin/computers/:id?tab=…` | executor cards, alerts |
| `/agents/triggers?create=&status=&type=&search=&trigger=` | `/admin/automations?tab=triggers&…` | agent Activity, alerts |
| `/agents/triggers/:id#machine-access` | `/admin/automations/triggers/:id#machine-access` | `facades/alerts/hooks.ts`, worker trigger-health dispatch |
| `/agents/tools?status=&source=&search=&instance=&deepWaterInstance=` | `/admin/advanced/tools?…` | app pages |
| `/agents/task-sets/new?sourcePageId=&sourceVersionId=&format=` | `/admin/automations/batch-jobs/new?…` | Documents doorway |
| `/agents/task-sets/:id?item=` | `/admin/automations/batch-jobs/:id?item=` | `worker/src/run/task-set-tools.ts` |
| `/agents/workflows?template=&installation=&run=&failedRuns=&demonstrationDrafts=` | `/admin/automations?tab=workflows&…` | worker workflow-failure dispatch, channel Automations |
| `/tokens?uoa_billing=<v>` | `/admin/billing?uoa_billing=<v>` | `facades/billing/checkout-return.ts`, root redirect |
| `/ops/usage` | `/admin/usage` | `worker/src/control/budget-alert-dispatch.ts` |
| `/settings/push` | `/admin/advanced/push` | `api/src/services/push-credentials.ts` test push |
| `/settings/executors` (never existed) | `/admin/computers` | `packages/team-admin/src/task-set-processors.ts` |

## Sidebar, menus and roots

- **Rail.** `NAV_ITEMS` ids unchanged (`channels`, `projects`, `knowledge`,
  `admin`, `search`); Admin's `to` is `/admin`; `ADMIN_ROUTE_PREFIXES` is
  `['/admin']`. On `/settings/*` no rail item is active and the sidebar column
  shows the Your settings list.
- **Admin sidebar** (`admin-nav-items.tsx`), three groups; a group renders
  whenever any of its items is visible:
  - `agents` "Agents", everyone: Agents `/admin/agents` (also active for
    `/admin/agents/…`), Apps `/admin/apps`, Computers `/admin/computers`,
    Automations `/admin/automations`.
  - `organisation` "Organisation": People `/admin/people` (any member on an
    SSO session, owner or can-manage-org otherwise), Teams `/admin/teams`
    (owner or admin), Organisation `/admin/organisation` (can-manage-org), AI
    models `/admin/models` (owner or admin), Company connections
    `/admin/connections` (owner or admin), Keys `/admin/keys` (owner), Usage
    and limits `/admin/usage` (owner), Credits and billing `/admin/billing`
    (owner or admin), Security `/admin/security` (owner, admin or
    can-manage-org; the audit tab keeps its owner gate inside).
  - `advanced` "Advanced", collapsed by default, visible when owner or
    super-admin: Tool registry (owner), Access rules (owner), System health
    (super-admin), Mobile push setup (super-admin), Session debug (owner or
    super-admin).
- **Your settings list** (new `settings-nav-items.tsx`): Profile,
  Notifications, Appearance, Status, Connected accounts, Your computers, Saved
  keys, Usage (only when the billing capability read says it is available),
  Security.
- **Avatar menu:** Availability · Status · Your settings · Send feedback ·
  Sign out. The Executors rows and Debug leave the menu.
- **Roots.** `/admin` and `/settings` are `contextualList` roots: on a phone
  the list is the page; on desktop each redirects to its first page. Back from
  a Your settings page returns to where the person came from (`parent:
  'origin'`), as `/alerts` does today.
- **Create menu, team switcher, top bar:** unchanged in phase 1.

## Phase 1: structure

Sequential unless marked parallel. Port pairs are per task so worktrees never
collide: T1 5470/5471 · T2 5472/5473 · T3 5474/5475 · T4 5476/5477 · T5 5478/5479.

### T1 Navigation skeleton (Opus)

Everything in "Sidebar, menus and roots", every row of the route map, and
every intent row above, with these compositions built from existing
components:

- `/settings/security`: sections in this order: Active sessions
  (`ActiveSessionsTable`), Programs signed in as you (the personal paired
  agents table, Pair an agent action, `?code=` handling from
  `PairedAgentsPage`), Password (`SecuritySettingsPage`'s form), This device
  (the Session card from `SettingsProfilePage`).
- `/settings/accounts`: `ConnectionsPage` with one added tab, Browsers,
  holding `CloudBrowserPanel scope="user"` and `MyBrowserLoginsPanel` (from
  `UserAgentsPage`, which is deleted); `MyBrowserLoginsPanel` renders whether
  or not a personal browser account exists.
- `/settings/computers`: the executors list component with a
  `?filter=mine|shared` strip defaulting to mine, Pair a computer.
- `/admin/security`: `TabBar` Audit log · Programs signed in as people.
- `/admin/automations`: `TabBar` Schedules & triggers · Batch jobs ·
  Workflows, each tab rendering the existing list page's body with its own
  intents; the three list pages' own headers collapse into the one
  Automations header.
- `/admin/organisation`: `TabBar` Profile · Appearance.
- `/admin/connections`: the former `OrganizationAgentsPage` content minus the
  call provider, titled Company connections.
- `/admin/people`: `MembersRosterPanel` behind a scope switch (Organisation
  when can-manage-org; each team the viewer is in), the Automatic team access
  tab at organisation scope, and the local-install roster sections at
  organisation scope on a local install.
- `/admin/teams`: a list from `useTeams` (name, picture, member count when the
  roster read allows, Open); `/admin/teams/:teamId` with `TabBar` General ·
  Overrides · AI models · Keys built from the existing team pages' content;
  the call-provider select from `CallProviderSettingsPanel` for this team on
  General; the team's People is a link to `/admin/people?scope=team:<id>`.
- `/admin/advanced/debug`: a page rendering the session-debug dialog's content.
- Delete: `UserSettingsPage`, `UserAgentsPage`, `TeamSettingsPage`,
  `TeamMembersPage`, `TeamModelsPage`, `TeamSecretsPage`,
  `OrganizationSettingsPage` (replaced), `OrganizationAgentsPage`,
  `OrganizationModelsPage` shell (content moves), `OrganizationSecretsPage`,
  `SettingsRootRoute` redirect, `AgentAccessRedirect`, every legacy redirect,
  and `admin-nav-items.tsx`'s User, Team, Organisation, Governance and
  Platform groups.
- Tests: update every test that pins nav items, routes, parents or labels
  (the reviews listed: `agents-nav-designer`, `billing-ops-boundary`,
  `instance-admin-nav`, `members-nav-doorway`, `native-touch-navigation`,
  `phone-navigation-routes`, `phone-navigation-transition`,
  `phone-navigation-stack`, `navigation-surfaces-total`,
  `navigation-redirect-route`, `navigation-layout`, `navigation-intent`,
  `navigation-controller`, `prewarm`, `route-code-splitting`,
  `screen-header`, `push-surface`, `owner-gate`, `super-admin-gate`,
  `team-models-page`, `apps-*`, `alert-row-*`, `trigger-url`,
  `uoa-billing-checkout-return`, `secrets-settings`, `team-invite-*`,
  `member-roster-confirmations`, `model-subscription-device-link`,
  `caller-call-dialog`, `knowledge-local-back`, `local-inference-host-status`,
  `executor-*`, `sidebar-rail-product-surfaces`, `tool-picker-groups`,
  `governance-actor-names`, `agent-*`, `deep-water-research-render`), and
  the `admin/e2e/navigation` cases that visit moved routes.
- Docs: `docs/navigation/*.md` examples, `docs/standards/*.md` and the
  guides that describe current routes, `CLAUDE.md`; amend the plan's own
  tree and mapping where this file changed a decision.

### T2 Organisation group consolidation (Opus, after T1)

- `/admin/models?scope=organisation|team:<id>`: one page, scope switch
  (`TabBar` of Organisation plus each team the viewer administers),
  `ModelAvailabilitySettings` with the matching `teamId`, the AI-on-own-
  computers policy (`LocalInferenceEnablement`) for the selected scope.
- `/admin/keys?scope=…`: `SecretsPanel` with the matching scope.
- `/admin/connections?scope=…`: organisation scope shows the company cloud
  browser (owner) and the install locks list (read-only in phase 1); team
  scope shows that team's shared mailboxes and cloud browser.
- `/admin/teams/:teamId`: the AI models and Keys tabs become links into the
  pages above with the team preselected; Overrides shows the effective values
  with "Set by organisation" chips and links.

As built:

- **One switch.** People, AI models, Company connections and Keys share
  `useAdminScope` (rules in `admin/src/lib/admin-scope.ts`, each page's scopes
  in `admin/src/pages/admin/scope-entitlements.ts`). People moved onto it, so a
  member now sees its Organisation scope disabled with the reason instead of
  absent. An address naming a team the page does not offer is an error on
  screen; a viewer without the organisation lands on their working team (else
  the first offered), written into the address with a replacing redirect.
  `useTabParam` returns the named value as a third element for this.
- **Scopes follow the API gates.** AI models: the organisation for its owner,
  every team for any owner or admin; Test is the owner's at either scope and
  is shown disabled, with the reason, to an admin; the own-computers policy
  is shown only to the sign-in provider's administration standing its reads
  need. Keys: the owner at every scope; anybody else is refused with a
  doorway to Saved keys. Company connections: owner or admin at every scope;
  a shared cloud browser account (company or team) is the owner's to connect,
  and its panel now says so to an admin while keeping the lock and home page.
  The team catalogue's pagination no longer writes its own `?scope=`, which
  collided with the switch.
- **Company connections.** The organisation's scope holds the company cloud
  browser and Locked apps. The lock list is read from the catalogue's
  Installed view, the only read that reports a lock and can be read whole:
  `/api/apps` has no lock filter and `/api/mcp/catalog` stops at 500 of the
  roughly 6,700 entries. So a locked app nobody here connected is not listed,
  and the section says so; a complete list needs a filtered read, held with
  the app page's Lock for phase 2. A team's scope holds that team's shared
  mailboxes (listed and connected for it alone) and its cloud browser; a mail
  surface's "Open mailbox settings" finds a shared mailbox's team when pressed.
- **The team page** keeps two tabs, General and Overrides, as the route map
  names them (the plan's §6.9 would make fewer than three concerns sections).
  Overrides reads the team's narrowing, own-computers policy, shared
  mailboxes, cloud browser account and home page, and keys, with "Set by
  organisation", "Set by this team", "Locked by organisation" and "Locked by
  this team" chips; each row opens the owning page at `?scope=team:<id>`.
- **Open, outside T2:** `GET /api/browser-cloud/connections` never returns a
  team's own connection, so a team's cloud browser panel cannot show a
  connected team account. It predates this change and needs the backend.

### T3 Connected accounts re-tab (Opus, after T1, parallel with T2)

`/settings/accounts` tabs: Mail and calendar (today's Email tab plus the
Calendar & Meet connect action and the Google capabilities), Chat (Slack),
Tickets and code (Project tools), Browsers (T1's tab), AI plans (model
subscriptions and Local AI). Each tab keeps every control it has today,
including the OAuth landing (`?connected=`, `?error=`, `?provider=`) and the
`#local-inference-host-<id>` anchor; the connection detail stays at
`/settings/accounts/:id`.

### T4 Old routes outside `admin/src` (Opus, after T1, parallel with T2)

Every emitter of an admin path outside `admin/src` moves to the new route,
with its tests. The reviews found these; grep for more before finishing:

- `api/src/routes/mcp-agent-auth.ts` (verification URI and `?code=`),
  `well-known-mcp-resource.ts`, `comms/oauth-routes.ts`,
  `board-sources/callback-page.ts`, `browser-cloud-agent-session.ts`,
  `call-link-error.ts`, `api/src/services/push-credentials.ts`.
- `worker/src/control/budget-alert-dispatch.ts`, `trigger-health-dispatch.ts`,
  `workflow-failure-dispatch.ts`, `push-delivery-core.ts`,
  `web-push-delivery.ts`; `worker/src/run/executor-coding-sessions.ts`,
  `task-set-tools.ts`, `pa-tools/tool-output.ts`, `workflow-authoring.ts`,
  `agent-conversations.ts`, `calls.ts`, `executors.ts`, `gmail-send-tool.ts`,
  `google-access.ts`.
- `packages/runtime/src/browserbase-setup-prompt.ts`, `credits.ts`,
  `builtin-agent-tools.ts`, `builtin-email-account-tools.ts`,
  `budget-admin.ts`; `packages/team-admin/src/global-agent-blueprints.ts`,
  `global-agent-executor-catalogue.ts`, `task-set-processors.ts`;
  `packages/schemas/src/agent-pairing.ts`; `packages/mcp-manage` app paths.
- `mobile/src/lib/tabs.ts` (`/settings` → `/admin`) and its test;
  `desktop/src-tauri/src/local_inference/origins.rs`;
  `executor/tray-windows/src-tauri/src/service_identity.rs`, `commands.rs`;
  `executor/menubar-macos/Sources/Core/ApprovedAPIOrigin.swift` and its tests.
- `web/src/home/content.ts`, `web/src/pages/mcp.tsx`.
- Every `admin/e2e/*` suite that visits or asserts an old route.
- The docs that describe current behaviour and name old routes:
  `docs/standards/paired-agents.md`, `inference-model-availability.md`,
  `calls.md`, `comms-connector.md`, `connected-mailboxes.md`,
  `design-system.md`, `personal-model-subscriptions.md`, `mcp-connectors.md`,
  `global-agents.md`, `deepwater.md`, `customer-billing.md`,
  `capability-health-alerts.md`, `app-store.md`, `agent-ownership.md`,
  `agent-email.md`, `tech-and-run-budgets.md`, `team-model.md`,
  `task-sets.md`, `task-set-agent-tools.md`; `docs/navigation/*.md`;
  `docs/web-push.md`, `docs/token-ledger-spec.md`, `docs/secret-management-spec.md`,
  `docs/functionality.md`, `docs/external-tool-integration.md`,
  `docs/connected-mailboxes.md`, `docs/agent-email.md`,
  `docs/organization-governance-spec.md`, `docs/knowledge-base-requirements.md`,
  `docs/deployment/*.md`, `docs/testing/*.md`.
Run the unit tests of every package touched (`pnpm exec turbo run test --filter=<pkg>` with `DATABASE_URL`).

### T5 Vocabulary pass (Sonnet, after T2, T3, T4 merge)

Labels, titles, eyebrows, tab names, button labels and empty-state copy in the
pages the restructure touched, per the plan's §7: Computers, Pair a computer,
Programs signed in as you, Saved keys / Keys, AI models, Your AI plans, AI on
your computer, Usage and limits, Access rules, System health, Mobile push
setup, Status, People, Batch jobs, Schedules & triggers, Organisation,
Automatic team access, Prevent overrides, Sign out this device. Raw status
enums to sentences belongs to phase 2.

## Later phases

2. The agent page's six tabs with the designer folded in (parent agent shown
   read-only on About; voice in Settings); Apps in two tiers with the
   Capabilities list, Installed filter, Remove all accounts, Refresh
   capabilities, the project-source handoff and DeepWater's cancel-research
   controls kept; the computer page's four tabs; Automations polish; raw
   enums to sentences.
3. Admin › Overview; the local-install roster fix; Security's audit filters,
   an export route and Verify integrity; a filtered agents read for "still
   using this model".
4. The accounts read model and one grant write; the Integrations pages;
   Check access; Used in.
5. Project settings consolidation; the conversation Details panel (keeping the
   Conversations and Browser tool doorways and the single-agent tabs); one
   project overview route with the Channels-origin Back decided.
6. Usage and limits split (Telemetry and Model pricing to Advanced); the
   deletions in the plan's §9; Alerts on every shell.

## Verification of a phase

Before a phase's pull request: the gates in rule 9 across the integration
branch, `pnpm --filter @nessie/admin test:e2e:navigation` on the integration
worktree's own port pair, a screenshot sweep of every route in the map at
1280 px and 390 px read by the orchestrator, and a grep for every old path
across the repository returning nothing outside `docs/done` and dated plans.
