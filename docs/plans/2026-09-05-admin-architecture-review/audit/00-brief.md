# Admin architectural review — shared brief

You are one reviewer in a parallel architectural review of the Nessie admin
frontend. READ-ONLY: do not edit, create, move or delete any file in the repo,
do not create branches or worktrees. Your only output is the report file named
in your task.

## Where the code is
Repo root: /Volumes/External/Projects/nessie  (main checkout, branch main)
App under review: /Volumes/External/Projects/nessie/admin  (src/ = 883 files,
557 .tsx + 324 .ts; tests in admin/test, 207 flat files; e2e in admin/e2e)
Stack: React 19, Vite 7, TanStack Query 5, React Router 7, Tailwind 4,
TypeScript strict, zod. Workspace packages: @nessie/schemas, @nessie/client-core,
@nessie/sign-in-surface, @nessie/config.
Out of scope: api/, worker/, packages/ internals (another session owns the API).
Only report on admin/. You may READ packages/ and api/ to understand contracts.

## Standards the code is judged against (read what your task names)
- AGENTS.md — "Rule zero" (esp. check 4: reuse the surface, never fork it),
  "Code Quality" (500-line cap, no -extras/-helpers dumps, no premature
  abstraction), "Architecture" routing list.
- docs/architecture.md — guardrails: no helpers/common/extras buckets; no
  hand-written client DTOs drifting from shared schemas; PageHeaderAction rule.
- docs/provider-system-and-frontend-architecture.md — §3 componentization,
  §4/§5 few app providers + domain facades (api/queries/mutations/types/hooks
  per facade), §5.3 primitives/shared/features/pages layering, §6 single source
  of truth for identity and per-entity cache.
- docs/standards/design-system.md — tokens only, one TabBar, one IdentityTile,
  one composer, one Dialog shell, one page gutter, no nesting.
- docs/navigation/overview.md (+ the chapter files it links) — one navigation
  framework; §7 overlays; §9 screen headers; §11 gates.
- docs/plans/2026-09-01-content-design-system/overview.md — an EXISTING audit
  of tables/lists/forms/pagination/dialog adoption. Do NOT redo it; cite it and
  only add what it missed or what has changed.
- eslint.config.js (root) and scripts/lint-*.mjs — the ratchet lints already in
  place (z-index scale, viewport classification, useMediaQuery ban, focus gates).

## Baseline facts already established (don't re-derive; build on them)
- 14 files exceed the 500-line cap (largest: ProjectsSidebarNav 675,
  ChannelsPage 615, AdminSidebarNav 599, lib/workflow-designer/serialization 598,
  AuthSessionProvider 597, lib/query-keys 596, StatusesPage 589, WorkflowsPage
  568, ResponsivePageHeader 547, MentionInput 541, voice-call-client 528,
  KnowledgeProvider 511, NotificationsPage 508, ChannelMessageFeed 506).
- Facades: 55 dirs under src/facades; ~40 are a single hooks.ts. Only `agents`
  and `agent-todos` have keys.ts/queries.ts/mutations.ts. Query keys are
  otherwise centralised in src/lib/query-keys.ts (596 lines).
- useQuery/useMutation outside facades: 5 files (EmbeddedWidget, PricingManager,
  BudgetManager, PolicyPage, OpsHealthPage). useApiClient outside facades/
  providers: 9 files. Raw fetch() outside facades/lib: IncomingCallProvider,
  PushSurfacePresenceHeartbeat, MessageAttachments.
- Reverse/cross-layer imports: components→pages 4; facades→components 12
  (mostly useIsOwner from components/shared/OwnerGate); shared→features 4
  (AgentVisibilityPill); components→layouts 20 (PhoneBackButton,
  sidebarAriaCurrent, LocalBackContext, phone-navigation-gesture).
- Two components named Card (components/shared/Card.tsx, components/overlays/Card.tsx).
- Naming: hooks are mostly useX.ts but some are use-x.ts; pages/ holds 27
  non-Pascal files (hooks, presentation helpers) and many dialogs/panels;
  catch-all names exist: pages/settings/settings-shared.tsx,
  pages/settings/push/shared.tsx, pages/settings/statuses/status-components.tsx.
- Hex colours in .tsx: 29 hits (workflow-designer node colours, ExternalAuthProvider
  fallbacks); Tailwind named colours: 8 (PhoneBackButton 5, FileNodeViewer 2).
- localStorage touched directly in 14 files outside lib/storage.ts; key
  schemes drift between `nessie:` and `nessie.` prefixes.
- 30 files in src/providers (the doc names 5 app-wide providers); 4 more
  contexts in layouts/admin-shell; KnowledgeProvider lives in components/features.
- 0 index barrels, 0 React.FC, 0 default exports in components (4 in pages),
  0 `any`, 0 ts-ignore, 5 eslint-disable, 0 console.*, 8 confirm( calls.

## Report format (write EXACTLY this structure to your output file)
# <Dimension title>
## Verdict
2–4 sentences: is this area consistent? What is the dominant convention, and what
fraction of the code follows it?
## Findings
One per finding, numbered, most severe first:
### F<n>. <one-line claim>
- Severity: high | medium | low   (high = violates a written standard or hides
  a real defect; medium = inconsistency that costs every future change; low = polish)
- Category: reuse | naming | structure | layering | data-flow | state | navigation |
  styling | typing | testing | a11y | performance
- Evidence: `path:line` citations (at least one per finding, real lines you read)
- Why it matters: 1–2 sentences
- Fix: concrete, mechanical description of the change (what moves where, what
  is renamed to what, what replaces what). Name target files.
- Fix size: S (<1h, one agent, ≤5 files) | M (one agent, one session, ≤20 files) |
  L (needs a plan; touches >20 files or a public contract)
- Risk: what could break; what test/typecheck proves it didn't.
## Conventions observed
Bullet list of the de-facto rules the code follows today (even if unwritten),
so the fix phase can codify rather than invent.
## Not a problem
Things you checked that looked suspicious but are fine, with a reason — so
nobody re-audits them.

Be precise and skeptical. Every claim needs a file:line you actually read.
Prefer 6–15 strong findings over 40 weak ones. Do not restate the baseline
facts as findings unless you add evidence or a fix.
