# Pages, routing and page-level state

## Verdict

Routing is unusually disciplined for a codebase this size: one flat
`createBrowserRouter` table (`router.tsx`), one totality-checked surface
registry (`navigation/surfaces.ts` + `admin-surfaces.ts`), one `ScreenHeader`,
and a real `useTabParam` convention that most pages actually use for
linkable filter/tab state. Where the codebase follows its own rules
(`OrganizationSettingsPage`, `useChannelTab`, `TriggersPage`'s status filter,
`PolicyPage`'s always-rendered header) it is exemplary. But there is zero
route-level code-splitting — every page ships in one 2.5 MB JS chunk — and
the two column-browser pages (`TriggersPage`, `WorkflowsPage`, `ToolsPage`,
`IntegrationsPage`) render through `ColumnBrowserColumn`, a bespoke header
bar with no `h1` that sits entirely outside the `ScreenHeader` contract and
outside the lints that enforce it. Entitlement checking is the other soft
spot: authentication is centralised in `AdminShellLayout`, but per-page
authorization (owner-only, org-admin-only, super-admin-only) has three
independent implementations, one of which silently drops the header-always-
renders rule the other two follow. Roughly two-thirds of the pages read
follow the documented conventions; the column-browser family and the two
20+-`useState` settings pages are the recurring outliers.

## Findings

### F1. No route-level code-splitting; the whole app is one ~2.5 MB JS bundle
- Severity: high
- Category: performance
- Evidence: `admin/src/router.tsx:1-54` imports every page component eagerly
  (`AgentDesignerPage`, `WorkflowDesignerPage`, `ChannelsPage`, all ~50
  pages) with no `React.lazy`/`lazy:` route loader anywhere in the file.
  `grep -rn "lazy(" admin/src` finds exactly 3 hits, none of them routes:
  `components/features/dashboards/DashboardWidgetCard.tsx:20,38` (two chart
  sub-panels) and `components/shared/EmojiPickerPanel.tsx:5`
  (`emoji-picker-react`). `admin/dist/assets/index-C4ZPtwAi.js` is
  2,575,873 bytes (2.58 MB) uncompressed; the only other split chunks are
  `emoji-picker-react.esm-*.js` (309 KB) and `WidgetCharts-*.js` (412 KB).
  Heavy, rarely-visited screens — `WorkflowDesignerPage`,
  `AgentDesignerPage`, `OpsHealthPage`, the settings family — all ship in
  the same chunk as `ChannelsPage`, which is the first thing almost every
  session loads.
- Why it matters: every visitor downloads and parses the workflow designer,
  the agent designer, every settings tab and every admin governance page
  before they ever open a channel. This is the single biggest lever on
  cold-load time in the app, and it costs nothing behaviourally to fix — the
  router already funnels every route through one table.
- Fix: convert the `import { X } from './pages/X'` lines in `router.tsx` to
  `React.lazy(() => import('./pages/X'))` for the heavy, infrequently-hit
  routes at minimum (`AgentDesignerPage`, `WorkflowDesignerPage`,
  `OpsHealthPage`, `OperationalTelemetryPage`, `AuditLogPage`, `PolicyPage`,
  the whole `pages/settings/*` family), wrap the router's outlet in a
  `Suspense` with the existing `Skeleton` primitive as fallback, and confirm
  `docs/navigation/overview.md` §12's scroll/settle logic tolerates a
  suspended screen (it already handles a loading query on the same screen).
- Fix size: M (router.tsx + a Suspense boundary in `RootLayout`/
  `AdminShellLayout`; no page logic changes)
- Risk: a route that isn't preloaded fast enough could show a flash of
  fallback on a slow connection; existing `admin/test/navigation-*.test.ts`
  suite runs under a memory router and would need to await the lazy
  import before asserting on rendered content — check whether it already
  awaits (it should, since RTL's `findBy*` queries do).

### F2. `ColumnBrowserColumn` is a second, unheadered header shape that evades both source gates
- Severity: high
- Category: navigation
- Evidence: `admin/src/components/shared/column-browser/ColumnBrowserColumn.tsx:187-201`
  renders a hand-built `<div className="flex h-[50px] ...">` bar with a
  `<h3>` title (not `<h1>`), an optional `leading`, a `PhoneBackButton`/
  `PhoneNavigationButton`, and a `headerAction?: ReactNode` prop — an
  arbitrary React-node action slot, the exact thing
  `docs/architecture.md`'s PageHeaderAction rule forbids
  ("do not add ... arbitrary React-node action slots"). `TriggerListColumn`
  (`components/features/triggers/TriggerListColumn.tsx:79-89`) passes a raw
  `<button>` as `headerAction`, not a `PageHeaderAction`.
  `admin/test/screen-header.test.ts:207-213` only walks
  `admin/src/pages/**` and only greps for the literal string `<header`; this
  component lives under `components/shared/` and renders a `<div>`, so it
  matches neither the directory nor the tag the gate checks
  (`test/screen-header.test.ts:196-213`). `TriggersPage.tsx` and
  `WorkflowsPage.tsx` (both column-browser pages, per the brief) render no
  `ScreenHeader` and therefore no `h1` at all — `screen-header.test.ts:69-74`'s
  "exactly one h1 per screen" invariant is untested on these two routes.
- Why it matters: this is precisely the "nine shapes at three heights"
  problem `docs/navigation/deep-links-and-headers.md` §9 says `ScreenHeader`
  was built to end, reintroduced one layer down where the gate can't see it.
  A screen reader on `/agents/triggers` has no `h1` to land on; the settle
  focus and live-region announcement (§12) have nothing to target.
- Fix: give `ColumnBrowserColumn` a `heading level="h2"` (sectioning content
  inside a real page, which is legitimate per §9 — "a card's own `<header>`
  heading row is sectioning content, not a screen header") but require the
  page that hosts the column browser to render one `ScreenHeader` above it
  carrying the real `h1` (e.g. "Triggers", "Workflows") — `TriggersPage.tsx`
  and `WorkflowsPage.tsx` currently have nowhere for that title to live.
  Replace `headerAction?: ReactNode` with `headerAction?: PageHeaderAction[]`
  rendered through the same measured-overflow primitce `ResponsivePageHeader`
  uses, so "New trigger" becomes a typed action instead of a bare button.
  Extend `screen-header.test.ts`'s walk to include
  `components/shared/column-browser/**` or add a dedicated assertion that
  every `ColumnBrowserColumn` consumer sits under a `ScreenHeader`.
- Fix size: M (ColumnBrowserColumn + TriggersPage + WorkflowsPage + ToolsPage
  + IntegrationsPage, the four column-browser consumers, plus the test)
- Risk: changing `<h3>` semantics or adding a wrapping header changes
  existing DOM structure that `navigation-layout.test.ts` and any e2e
  selectors keyed on the column header may assert against; run the full
  `admin/test` suite and the triggers/workflows e2e specs.

### F3. `OpsHealthPage` returns before its header, breaking the "header always renders" rule its siblings follow
- Severity: high
- Category: navigation
- Evidence: `admin/src/pages/OpsHealthPage.tsx:75-80` —
  `if (!isSuperAdmin) { return (<section className="flex h-full items-center justify-center ...">Instance super-admin access required</section>) }` —
  executes *before* `<ScreenHeader actions={headerActions} title="System Health" />`
  at line 84. Contrast `admin/src/pages/PolicyPage.tsx:101-106`, which
  comments "The header is always rendered: a refusal is a state of this
  screen, not a screen of its own, so Back never disappears with it" and
  renders `<ScreenHeader title="Policy Rules" />` unconditionally before
  `<OwnerGate>` wraps the body. `AuditLogPage.tsx` and `ToolsPage.tsx` follow
  the same PolicyPage pattern (`OwnerGate` wraps the body, not the page).
- Why it matters: `docs/navigation/deep-links-and-headers.md` §9 names this
  exact defect class ("Five states returned *before* any header ... so a
  phone standing on one had no Back") as already fixed once. A non-super-admin
  who lands on `/ops` on a phone gets a dead-end screen with no Back control.
- Fix: move the `!isSuperAdmin` branch's refusal to render *inside* the
  section, after an unconditional `<ScreenHeader title="System Health" />`,
  matching `PolicyPage.tsx:101-106`'s shape exactly (ideally reusing
  `OwnerGate`'s refusal text/markup via a shared component, see F6).
- Fix size: S (one file)
- Risk: none functionally; `screen-header.test.ts` doesn't currently target
  this page, so add a regression assertion (refusal branch still renders
  exactly one `h1`).

### F4. `ProjectsIndexPage` has no error state; a failed query reads as "No projects yet"
- Severity: high
- Category: data-flow
- Evidence: `admin/src/pages/ProjectsIndexPage.tsx:6-15` —
  `const { data: projects = [], isLoading } = useProjects(); if (isLoading) return null; ... return (<EmptyState>No projects yet.</EmptyState>)`.
  There is no `isError`/`QueryState` branch at all: a network failure sets
  `isLoading` to `false` and `data` stays defaulted to `[]`, so the failure
  path and the legitimately-empty path render the identical "No projects
  yet." message. Loading also renders a bare `null` — no header, no
  skeleton — for however long the query takes.
- Why it matters: a real outage (auth expiry, 500, offline) tells the user
  they have no projects rather than that something went wrong, which is
  actively misleading on the page that is the entire `/projects` root.
- Fix: use `QueryState` (the same primitive every other list page in this
  audit uses) around the redirect logic, or at minimum branch on
  `isError` before falling through to the empty state; keep the `Navigate`
  fast-path for the success case with data.
- Fix size: S (one file)
- Risk: none; purely additive error branch.

### F5. `WorkflowsPage` keeps six pieces of page state in `useState`/router `location.state` instead of the URL, contradicting its own registry row
- Severity: medium
- Category: state
- Evidence: `admin/src/navigation/admin-surfaces.ts:85-101` declares the
  `/agents/(?:workflows|triggers|tools|executors)$/` row's `state` intent as
  `['executorId', 'accessChange', 'promotion', 'tab', 'status', 'search',
  'source', 'instance', 'deepWaterInstance']` — i.e. search and selection
  are supposed to be URL-linkable on this route family. But
  `admin/src/pages/WorkflowsPage.tsx:94,121-131` seeds
  `selectedInstallationId`/`selectedRunId`/`selectedTemplateId` from
  `useLocation().state` via `readWorkflowsPageLocationState` (lines 48-64),
  and `searchQuery` (124), `showFailedRuns` (151), `showDemonstrationDrafts`
  (152) are plain `useState` with no URL sync at all. `grep -n
  "useSearchParams|useTabParam" pages/WorkflowsPage.tsx` returns nothing.
  Compare `pages/triggers/useTriggersPageState.ts:108`, which puts the
  equivalent status filter in `useTabParam('status', ...)` with an explicit
  comment on why it must be linkable.
- Why it matters: a workflow selection/search cannot be bookmarked, shared,
  or survive a refresh, and `location.state`-seeded selection is lost
  entirely on any hard navigation (a new tab, a pasted link, a native deep
  link) — exactly the gap intent params were built to close per
  `docs/navigation/deep-links-and-headers.md` §8.
- Fix: move `selectedTemplateId`/`selectedInstallationId`/`selectedRunId`
  to `useTabParam` or plain `useSearchParams` writes (with `replace`) keyed
  to the intents already declared on the registry row (`instance`,
  `search`); drop `readWorkflowsPageLocationState` and the `location.state`
  seeding once callers pass query params instead of router state.
- Fix size: M (WorkflowsPage.tsx plus its few `navigate(..., {state})`
  callers)
- Risk: any caller that currently does `navigate('/agents/workflows',
  {state: {selectedRunId}})` needs to switch to a query-param link; grep
  `selectedInstallationId\|selectedRunId\|selectedTemplateId` for callers
  before removing the location.state path.

### F6. Three independent, inconsistent entitlement-gate patterns, one of which contradicts its own predecessor's stated lesson
- Severity: medium
- Category: layering
- Evidence: (1) `components/shared/OwnerGate.tsx:44-56` — a shared component
  over `useIsOwner()` (session-derived, synchronous), rendering "Owner access
  required"; its own docstring (lines 6-16) says it was built because "Five
  owner-only pages ... rendered that sentence in byte-identical markup" and
  "the question 'is this person an owner?' has one answer" now. (2)
  `pages/settings/OrganizationAdministrationGate.tsx:11-49` — a *different*
  shape: a query-backed gate (`useCurrentOrganization()`) with four render
  branches (loading/error/unavailable/denied), each wrapping its own
  `SettingsPanel` with a different title, no shared component with (1). (3)
  `pages/OpsHealthPage.tsx:49,75-80` — a third, ad hoc, inline check
  (`me?.user.superAdmin ?? false`) with its own bespoke refusal markup
  ("Instance super-admin access required") that is structurally identical
  to `OwnerGate`'s but duplicated rather than reused, and which (per F3)
  additionally skips the "header always renders" rule the other two respect.
  Authentication itself (signed-in vs not) is centralised once, correctly,
  in `layouts/AdminShellLayout.tsx:79-97`. Route-level classification in
  `admin-surfaces.ts:174,182` documents "owner-only" / "super-admin-only" in
  *comments* only (`// '/ops' is super-admin-only`); the registry enforces
  no such thing — it is a navigation classification, not an authorization
  boundary.
- Why it matters: `OwnerGate`'s own history shows this project already paid
  once to consolidate a scattered "is this an owner" check into one place;
  the super-admin question is now repeating that exact mistake one tier up,
  and a reader has no single place to answer "who can see this route" —
  they must open each page to find out which of three patterns it uses.
- Fix: extract a `SuperAdminGate` component mirroring `OwnerGate`'s shape
  (`useIsSuperAdmin()` + shared refusal markup) in `components/shared/`,
  and use it in `OpsHealthPage.tsx` and `OperationalTelemetryPage.tsx`
  (which also declares `parent: 'origin'` super-admin-only per
  `admin-surfaces.ts:179-188`). Leave `OrganizationAdministrationGate` as
  its own thing (it is answering a materially different, server-verified
  question), but document in `docs/navigation/overview.md` §11 (gates) that
  there are exactly two client gate shapes — synchronous session-role gates
  and query-backed capability gates — so a third ad hoc shape doesn't
  reappear.
- Fix size: S (new SuperAdminGate component + 2 call sites)
- Risk: none behaviourally; purely consolidates existing checks.

### F7. Route topology is declared twice — `router.tsx`'s path strings and `surfaces.ts`/`admin-surfaces.ts`'s regexes — guarded only by a text-scraping lint
- Severity: low
- Category: reuse
- Evidence: every route in `admin/src/router.tsx` (e.g. `path:
  '/agents/:agentId/mailbox'` at line 272) has an independently written
  regex counterpart (`pattern: /^\/agents\/([^/]+)\/mailbox$/` in
  `admin-surfaces.ts:113`). The two are cross-checked by
  `scripts/lint-navigation-surfaces.mjs` (reads both files as text, no
  TypeScript loader — comment at lines 12-16) and mirrored by
  `admin/test/navigation-surfaces-total.test.ts` against the real, executed
  registry.
- Why it matters: every new route is a two-file edit (three, counting
  `connected-mail-surfaces.ts`) with a third syntax (path string vs. regex)
  to keep in sync by hand; the lint catches a *missing* row, but not a typo'd
  pattern that happens to still match (e.g. a param name drift). This is a
  real, permanent per-change tax, not a one-off refactor debt.
- Fix: this is a considered, tested tradeoff (the registry needs richer
  per-route metadata — depth, identity, parent, intent — that a route
  object literal in `router.tsx` doesn't carry), so the mechanical fix is
  not "delete one side." Lower-cost improvement: have `admin-surfaces.ts`
  build its `RegExp` from the literal route-path strings imported from a
  single source (or generate `router.tsx`'s path list from the registry)
  so only the per-route metadata is hand-written twice, not the path itself.
  Given the existing lint/test coverage, this is optional hardening, not a
  defect.
- Fix size: L (touches the registry's authoring model; a public contract
  for every route)
- Risk: this is a design-tradeoff writeup, not an urgent fix; leaving it
  alone is a legitimate choice given the compensating gate.

### F8. `StatusesPage` mixes four independent forms (status create/edit, schedule create, contact-rule create) and their 25 `useState` calls in one 589-line component
- Severity: medium
- Category: structure
- Evidence: `admin/src/pages/settings/StatusesPage.tsx:70-93` declares 25
  `useState` hooks in one function body:
  `newLabel`/`newEmoji`/`createError` (the create-status form, lines 233-252),
  `label`/`emoji`/`agentEnabled`/`agentInstructions`/`saveError` (the
  edit-status form, lines 273-339, re-seeded from `selectedStatus` by the
  effect at 111-117), `scheduleKind`/`scheduleLabel`/`startsAt`/`endsAt`/
  `dayOfWeek`/`startTime`/`endTime`/`timezone`/`scheduleError` (the schedule
  form, lines 344-425), and `ruleScope`/`ruleChannelId`/`ruleProjectId`/
  `ruleAgentId`/`ruleAgentEnabled`/`ruleInstructions`/`ruleError` (the
  contact-rule form, lines 458-542), plus `confirmingDelete` for the delete
  dialog. All nine server-sync mutation hooks (`useCreateStatus`,
  `useUpdateStatus`, `useCreateStatusSchedule`, `useCreateStatusRule`, etc.)
  are already correctly isolated in `facades/statuses/hooks.ts` — this file
  holds only form/UI state, no server-state-mirrored-into-useState smell
  beyond the one legitimate case (the edit form re-seeding from the
  selected record on `id` change, line 111-117, which is a standard
  "edit form tracks the selected record" pattern, not a sync bug).
- Why it matters: four unrelated forms sharing one component means a change
  to the schedule form's validation risks touching state names used by the
  rule form three sections down, and the file is already 89 lines over the
  500-line cap.
- Fix: split into `pages/settings/statuses/StatusEditorForm.tsx` (label/
  emoji/agentEnabled/agentInstructions/saveError + delete confirm — the
  edit-status form and its own effect), `StatusScheduleForm.tsx` (the
  9-field schedule form + schedule list), `StatusRuleForm.tsx` (the 7-field
  rule form + rule list). Keep `StatusesPage.tsx` itself as the orchestrator:
  the status list, the create-status form (small enough to stay inline),
  selection/redirect logic, and composing the three extracted forms as
  props-driven children. This is a feature-component split (each form is
  reusable in isolation and testable without the whole page), not a
  `-helpers` dump — each new file owns one form's full behavior.
- Fix size: M (one file → four; ≤5 files, one session)
- Risk: `admin/test` likely has StatusesPage-level tests exercising these
  forms end-to-end; after the split, re-run them unchanged (the extraction
  should not change any DOM output or event handler behavior) — the split is
  a pure structural refactor and should require zero test-assertion changes
  if done as prop-drilling rather than a behavior change.

### F9. `NotificationsPage` hydrates 11 server-owned preference fields into local `useState`, kept in sync by a ref-guarded effect
- Severity: medium
- Category: state
- Evidence: `admin/src/pages/settings/NotificationsPage.tsx:204-244` —
  eleven `useState` fields (`pushEnabled` through `quietTimezone`) are
  declared with placeholder defaults, then an effect (lines 221-244) copies
  `me.user.preferences` into all eleven on every user-id change, guarded by
  `hydratedUserId.current === me.user.id` (219, 227) specifically to stop a
  background refetch of `me` from clobbering an in-progress edit — this is
  the exact "server data copied into useState and kept in sync by effects"
  smell the task description names. A `preferencesHydrated` flag (215, 242)
  additionally gates the Save button and every form control's `disabled`
  prop (366, 399, 410, 421, 432) so the page functions correctly, but at the
  cost of five different places checking `!preferencesHydrated`.
- Why it matters: this pattern needs a manual "have we hydrated yet, and for
  which user" ref specifically to avoid the sync bug the pattern invites;
  a form driven by TanStack Query's own data (via `defaultValue` + `key={me.user.id}`
  remount, or an uncontrolled form read via `FormData` on submit) would not
  need `hydratedUserId`/`preferencesHydrated` at all. The file is also 8
  lines over the 500-line cap.
- Fix: extract a `NotificationPreferencesForm` component
  (`pages/settings/notifications/NotificationPreferencesForm.tsx`) that
  takes `preferences: UserPreferences` as a required prop (no `| undefined`,
  no hydration flag) and is only mounted once `me` has loaded — the parent's
  existing `if (!me) return null` (line 251) already provides that gate, so
  the child can be `key={me.user.id}`-remounted per user with plain
  `useState(() => preferences.pushEnabled ?? true)` initializers, eliminating
  the ref and the hydrated flag together. `BrowserNotificationsSection`
  (lines 96-193) is already correctly isolated in the same file as a
  sibling component — move it to its own file
  (`pages/settings/notifications/BrowserNotificationsSection.tsx`) in the
  same pass.
- Fix size: M (one file → three: NotificationsPage.tsx orchestrator,
  NotificationPreferencesForm.tsx, BrowserNotificationsSection.tsx)
- Risk: the `key={me.user.id}` remount must be verified against Focus Mode
  and the muted-channels panel, which read from different hooks and must
  NOT remount on the same key — keep those outside the remounted subtree.

### F10. Four components import types (and in one case, presentational logic) from `pages/`, inverting the pages→components dependency direction
- Severity: low
- Category: layering
- Evidence: `components/features/triggers/TriggerListColumn.tsx:9` imports
  `TriggerStatusCounts, TriggerStatusFilter, TriggerTypeFilter` (type-only)
  from `../../../pages/triggers/useTriggersPageState`;
  `components/features/workflow-designer/WorkflowDesignerHeader.tsx:3`
  imports `type WorkflowTestRunState` from
  `../../../pages/workflow-designer/useWorkflowTestRun`;
  `components/features/channels/thread-panel/ThreadReplyPanel.tsx:11`
  imports `type { useReplyThread }` from
  `../../../../pages/channels/useReplyThread`; and
  `components/features/settings/ActiveSessionsTable.tsx:5` imports the
  *value* `describeSessionDevice` from `../../../pages/settings/session-device`
  — the one non-type-only case, and also the one most clearly misplaced:
  `pages/settings/session-device.ts` is pure user-agent string parsing with
  no page orchestration in it at all.
- Why it matters: `pages/` is meant to be the top of the dependency graph
  (route-mounted orchestration); a component reaching into a page's hook
  file for a type means the type's real owner is the component (or a shared
  contract), not the page, and the page file cannot be deleted or replaced
  without checking who else imports its types first.
- Fix: move `TriggerStatusCounts`/`TriggerStatusFilter`/`TriggerTypeFilter`
  into `components/features/triggers/trigger-presentation.ts` (already the
  shared presentation module both files import from) and have
  `useTriggersPageState.ts` import them back; move `WorkflowTestRunState`
  into `components/features/workflow-designer/` beside
  `WorkflowDesignerHeader`; move the `useReplyThread` return type into a
  named `ReplyThreadState` export colocated with `ThreadReplyPanel`'s other
  shared types; move `session-device.ts` wholesale to
  `lib/session-device.ts` (it has no page dependency) and update
  `ActiveSessionsTable.tsx` and any page that also uses it.
- Fix size: S (4 files moved/renamed, import updates only)
- Risk: none — type-only moves for 3 of 4; the `session-device.ts` move is a
  pure relocation with no logic change.

### F11. `TriggersPage`'s `searchQuery` and `typeFilter` stay in `useState` despite the registry declaring `search` as URL state on this route
- Severity: low
- Category: state
- Evidence: `admin/src/navigation/admin-surfaces.ts:88-95` declares `state:
  [..., 'search', ...]` on the `/agents/(?:workflows|triggers|tools|executors)$/`
  row. `pages/triggers/useTriggersPageState.ts:104,109` keeps
  `searchQuery`/`typeFilter` as plain `useState`, while the *status* filter
  on the same page correctly uses `useTabParam('status', ...)` (line 108),
  with an explicit comment explaining why status must be linkable. No
  equivalent comment or URL wiring exists for search/type.
- Why it matters: inconsistent even within one hook — one filter on the row
  is linkable, two are not, for no stated reason, and the registry's own
  declared contract (`search` is `state`, not local) goes unfulfilled by the
  Triggers page specifically (it may be fulfilled by ExecutorsPage or
  ToolsPage, which share the row — not verified here).
- Fix: either wire `searchQuery`/`typeFilter` through `useSearchParams`
  with `replace` (matching `statusFilter`'s pattern) or remove `search` from
  the registry row's declared intent if no page on this route actually
  reads it linkably — `admin/test/navigation-intent.test.ts` (per
  `docs/navigation/deep-links-and-headers.md` §8) is described as gating
  "every consumed name is declared on a row and read nowhere but the
  hooks," but a declared `state` name with no reader anywhere is not
  something that test appears to catch (state names, unlike consume/hash
  names, are not required to have a matching hook call).
- Fix size: S (useTriggersPageState.ts)
- Risk: none; purely additive URL sync, or a documentation-only registry
  trim.

## Conventions observed

- One `createBrowserRouter` table, one `Surface` registry, both required to
  agree by a totality lint + test (`scripts/lint-navigation-surfaces.mjs`,
  `admin/test/navigation-surfaces-total.test.ts`).
- Every page fetches through `facades/*/hooks.ts`, never raw `fetch()` or
  `useApiClient` directly — confirmed clean on all six pages read in depth
  (`AgentsPage`, `StatusesPage`, `AgentDetailPage`, `ChannelsPage`,
  `TriggersPage`, `WorkflowsPage`, `OrganizationSettingsPage`); the two
  documented exceptions in this directory (`PolicyPage`, `OpsHealthPage`)
  use `useQuery`/`useApiClient` directly for genuinely page-owned, one-off
  reads rather than shared domain data.
- Tab/filter state that is meant to be linkable goes through
  `navigation/useTabParam`, written with `replace` — followed correctly by
  `OrganizationSettingsPage.tsx:29`, `useChannelTab.ts:59`,
  `useTriggersPageState.ts:108`, and ~13 other pages per the `useTabParam`
  grep.
- One-shot deep-link instructions go through `navigation/intent.ts`'s
  `useConsumedIntent`/`useConsumedHashIntent`, never raw `URLSearchParams`
  reads — confirmed in `useTriggersPageState.ts:101,178` and
  `TokenUsagePage.tsx:27`.
- A page that needs an entitlement refusal renders its `ScreenHeader`
  first, unconditionally, and puts the gate around the body only —
  `PolicyPage.tsx:101-106`, `AuditLogPage.tsx`, `ToolsPage.tsx` all follow
  this; `OpsHealthPage.tsx` is the one exception (F3).
- Page-local orchestration hooks live in a `pages/<page-name>/` sibling
  directory (`pages/channels/use*.ts` ×13, `pages/workflow-designer/use*.ts`
  ×4, `pages/triggers/useTriggersPageState.ts`) rather than inline in the
  page file — a good pattern for breaking up large pages that several pages
  here use well (`ChannelsPage` composes 13 such hooks plus 2 more from
  `components/features/channels/`).
- Authentication (signed-in vs not) is checked exactly once, in
  `layouts/AdminShellLayout.tsx:79-97`; no page re-checks session validity.

## Not a problem

- The route-path duplication between `router.tsx` and `surfaces.ts` (F7) is
  flagged for cost, but it is a deliberate, tested design: the registry
  needs metadata (depth, identity, parent-of, intent) that `router.tsx`'s
  route objects structurally cannot carry without becoming the registry
  itself. This is not naive copy-paste drift.
- `ChannelsPage.tsx` (615 lines) has no `ScreenHeader` call of its own, but
  correctly delegates header rendering to `components/features/channels/ChannelHeader.tsx`
  — checked directly; this is composition, not an omission.
- All six pages read for Q2 (`AgentsPage`, `StatusesPage`,
  `AgentDetailPage`, `ChannelsPage`, `TriggersPage`, `WorkflowsPage`,
  `OrganizationSettingsPage`) use facade hooks exclusively; no raw
  `useApiClient`/`fetch` in any of them (`grep -n "useApiClient|fetch("`
  across all seven files returned nothing).
- `StatusesPage`'s edit-form re-seeding effect (`StatusesPage.tsx:111-117`)
  looked at first glance like the server-data-into-useState smell, but it
  is the standard, correct "load the selected record into an edit form,
  keyed on id only" pattern — it explicitly avoids re-seeding on every
  background refetch (the comment at 108-110 explains why keying on `id`
  only, not the full record, matters) rather than fighting a sync problem
  of its own making.
- `SearchPage.tsx`'s hand-rolled loading/error/empty triad (lines 168-190)
  does handle all three states (including `results.errorMessage`); it's a
  non-standard implementation relative to `QueryState`, but it is not a
  missing-error-state defect, and the brief says not to recount the
  content-design-system audit's ~60 hand-rolled-triad count this belongs to.
- `WorkflowDesignerHeader.tsx` and `ThreadReplyPanel.tsx`'s imports from
  `pages/` (F10) are type-only (erased at build time, zero runtime coupling)
  — real but low-severity, not a functional layering violation.

## Appendix: page table

| Page | Route | Header component | Body component | Data source | Tab/filter state location | Has error state | Lines |
|---|---|---|---|---|---|---|---|
| AgentsPage | `/agents` | ScreenHeader (via `AgentsList`) | `AgentsList` | facades/agents | `scope` via registry intent (in `AgentsList`) | yes (in `AgentsList`) | 10 |
| AgentDetailPage | `/agents/:agentId` | ScreenHeader (inline) | `AgentDetailTabs` | facades/agents | `agentTab` via registry intent | yes (`QueryState` on not-found) | 143 |
| StatusesPage | `/settings/statuses(/:statusId)` | ScreenHeader (via `SettingsPanel`) | inline forms + `StatusList` | facades/statuses, channels, projects, agents | `statusId` is a route param, not a tab param | yes (`QueryState` on list) | 589 |
| NotificationsPage | `/settings/account?tab=notifications` (tab host) | ScreenHeader (via `SettingsPanel`) | inline form + `PushPreferenceCard` + `BrowserNotificationsSection` | facades/auth, channels, web-push | n/a (hosted tab, no own filter) | yes (`QueryState` on channel list) | 508 |
| ChannelsPage | `/channels/:channelId` etc. | ScreenHeader (via `ChannelHeader`, a feature component) | `ChannelConversationSurface` + `ChannelOverlays` | facades/channels, threads, agents, voice, users, integrations, messages | `tab`/`research` via `useChannelTab`/`useTabParam` | yes (via child `QueryState` usage) | 615 |
| TriggersPage | `/agents/triggers` | **none** — `ColumnBrowserColumn` renders a bespoke `h3` bar, no page-level `ScreenHeader`, no `h1` | `TriggerListColumn` + `TriggerDetail` | facades/triggers, agents, channels, workflows | `status` via `useTabParam`; `searchQuery`/`typeFilter`/`selectedTriggerId` in `useState` | yes (`QueryState` in `TriggerListColumn`) | 83 (+279 in `useTriggersPageState.ts`) |
| WorkflowsPage | `/agents/workflows` | **none** — same `ColumnBrowserColumn` pattern, no `h1` | inline list + `WorkflowInstallationDetail`/`WorkflowRunDetail`/`WorkflowTemplateDetail` | facades/workflows, demonstrations, usePagedList | selection state in `useState`, seeded once from router `location.state`; no URL sync at all | yes (`QueryState` used in list) | 568 |
| OrganizationSettingsPage | `/settings/organization` (tab host) | ScreenHeader (via child `OrganizationXPage` pages, through `OrganizationAdministrationGate` → `SettingsPanel`) | `OrganizationAgentsPage`/`OrganizationAppearancePage`/`OrganizationProfilePage` | facades/organization (via `OrganizationAdministrationGate`'s `useCurrentOrganization`) | `tab` via `useTabParam` | yes (`OrganizationAdministrationGate`'s own loading/error/unavailable/denied branches) | 53 |
| ProjectsIndexPage | `/projects` | none (redirect-only page) | `EmptyState` only | facades/projects | n/a | **no** — loading returns `null`, error path indistinguishable from empty (F4) | 16 |
| OpsHealthPage | `/ops` | ScreenHeader, but only on the authorized branch — refusal branch renders before it (F3) | inline stat grid | `useQuery`/`useApiClient` directly (documented exception) | n/a | yes (`QueryState` on the health query) | 172 |
| PolicyPage | `/policy` | ScreenHeader (always, before `OwnerGate`) | inline form + `PageBody`/`Section` | facades (policy) | n/a | yes | not read in full (header pattern confirmed at lines 101-106) |
