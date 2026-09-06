# Fix plan

One run, one worktree (`.worktrees/admin-arch-review`), one branch, one PR.
Fix agents (Opus for the state/realtime/structural work, Sonnet for the
mechanical splits and conversions) work in the same worktree in parallel with
strictly disjoint file ownership; the orchestrator commits and pushes between
waves. The gate for every wave is the baseline that was green at the start:
`pnpm --filter @nessie/admin typecheck`, `lint`, and the Turbo `test` run.

## Table of Contents

- [Wave 1 — content fixes](#wave-1--content-fixes)
- [Wave 2 — structural moves and the layering gate](#wave-2--structural-moves-and-the-layering-gate)
- [Wave 3 — react-hooks lint, docs, verification](#wave-3--react-hooks-lint-docs-verification)
- [Deferred follow-ups](#deferred-follow-ups)
- [Decisions the team owes](#decisions-the-team-owes)
- [Verification caveat](#verification-caveat)

## Wave 1 — content fixes

Eight agents, disjoint files. Findings by ID per [findings.md](findings.md).

| Agent | Model | Owns | Fixes |
|---|---|---|---|
| 1a providers-state | Opus | `KnowledgeProvider` + deep-link hook, `AuthSessionProvider`, `FocusModeProvider`, `facades/auth/hooks.ts`, `useStarredItems`, `index.html` | 07-F1, 07-F2 (memo + split), 07-F6, 07-F7, 07-F13, 06-F9, 06-F10 |
| 1b realtime | Opus | `IncomingCallProvider`, `facades/calls/*`, `facades/agents/realtime.ts` + `keys.ts`, `DashboardRealtimeProvider`, `useAdminShell.ts`, `PushSurfacePresenceHeartbeat`, `MessageAttachments` | 07-F3, 07-F4, 03-F5, 02-F8 |
| 1c headers-url-state | Sonnet | `ColumnBrowser*`, `ToolsPage`, `TriggersPage`, `WorkflowsPage`, `IntegrationsPage`, `OpsHealthPage`, `OperationalTelemetryPage`, `ProjectsIndexPage`, `ConnectedMailPage`, `MembersRosterPanel`, `useTriggersPageState`, `ConversationInfoFlow`, `TriggerListColumn`, new `SuperAdminGate`, navigation registries (`flowPresentation`), `screen-header`/`tab-param` tests, navigation docs §1/§9 | 08-F2, 08-F3, 08-F5, 08-F10, 08-F12, 08-F13, 05-F3, 05-F4, 05-F5, 05-F6, 05-F11, 06-F7, 07-F8 (ColumnBack) |
| 1d tokens-hygiene | Sonnet | `WorkflowCanvasNode`, `lib/workflow-designer/constants.ts`, `PhoneBackButton`, `FileNodeViewer`, `RichTextEditor`, timer files, `!` sites, `scripts/lint-navigation-surfaces.mjs`, `docs/navigation/overlays.md`, `docs/architecture.md` header line | 02-F1, 02-F2, 02-F5, 02-F7 (prompt), 02-F9, 08-F6, 08-F11 |
| 1e layout-page-splits | Sonnet | `AdminSidebarNav`, `ProjectsSidebarNav`, `SidebarProjectsSection`, `StatusesPage` + `statuses/*`, `NotificationsPage` | 06-F1, 06-F5, 06-F6, 06-F4, 05-F8, 05-F9, 02-F7 (alert) |
| 1f component-splits-shell | Sonnet | `ResponsivePageHeader`, `MentionInput`, `ChannelMessageFeed`, `serialization.ts` + callers, shell contexts (`AccountMenu`/`MobileNav`/`ShellActions` → `ShellStateContext`), `AdminShellLayout`, `PhoneNavigationButton`, `ChannelsPage` (consumer line) | 06-F8, 06-F3, 06-F2, 06-F11, 07-F10, 07-F8 |
| 1g errors-deadcode-reuse | Sonnet | dead files, `TriggerTypePicker` + `ChoiceGroup`, `ChannelMessageActions` + `CommentActions` + new `EmojiReactionButton`, `useReplyThread`, `facades/form-errors.ts` + the twelve `errorMessage` sites, `agent-mailbox/hooks.ts`, `DashboardDetailPage`, client-core `QueryProvider` (additive prop) + admin `QueryProvider`, `ToastProvider`, new mutation-feedback gate test, `AgentAvailableTools`, `clear-project-attention.ts`, `ExecutorsPage`, `ChannelConversationSurface`, `eslint.config.js` | 04-F3, 04-F1, 08-F7, 08-F8, 09-F9 (bypass), 09-F4, 09-F3, 09-F8 (hook), 08-F15 (eslint), 02-F5 (ExecutorsPage) |
| 1h code-splitting | Sonnet | `router.tsx` | 05-F1 |

## Wave 2 — structural moves and the layering gate

Sequential, one Opus agent per step, because both steps rewrite import paths
across the tree.

1. **Moves and renames** (04-F2, 04-F4, 04-F5, 04-F7, 04-F8, 04-F9, 04-F10,
   04-F11, 04-F12, 04-F6, 03-F6, 01-F1, 01-F2, 01-F5, 07-F9), then
   `scripts/lint-admin-layers.mjs` wired into the root `lint` chain with the
   residual allowlist seeded from
   [08 Appendix 3](audit/08-navigation-dependency-rules.md) minus the edges
   the moves deleted. Docs: `docs/provider-system-and-frontend-architecture.md`
   §5.2/§5.3 rewritten to the real conventions; `docs/architecture.md`
   gains the layer order.
2. **Query keys per facade** (03-F2, 06-F13): `lib/query-keys.ts` split into
   `facades/<domain>/keys.ts`, the five private factories folded in,
   `test/query-key-invariants.test.ts` globs every `keys.ts`, central file
   keeps only `paginationKeys`.

## Wave 3 — react-hooks lint, docs, verification

1. Register `eslint-plugin-react-hooks` (07-F5) with `rules-of-hooks: error`
   and `exhaustive-deps: error` (admin lint runs `--max-warnings 0`, so
   `warn` would fail anyway); fix every hit or add a one-line justified
   disable.
2. Full gate: typecheck, lint (root chain, including the new script), Turbo
   tests, the five e2e suites where a database is available.
3. PR, CI, merge per `AGENTS.md` → Workflow.

## Deferred follow-ups

Ordered by value. Each is one PR.

1. **Record types from `@nessie/schemas`** (03-F1 / 09-F2): delete the
   hand-written `ChannelRecord`/`AgentRecord`/`ProjectRecord`/`TeamRecord` in
   `client-core/api-types.ts`, re-export `z.infer` types, fix the branded-id
   fallout, add `metadata` to `ChannelRecordSchema` or drop the client reads.
   Touches desktop and mobile; coordinate with the API session on
   `packages/schemas`.
2. **Parse at the boundary** (09-F1 / 03-F4): optional `schema` argument on
   the client; migrate `channels`, `agents`, `projects`, `users` first using
   `facades/executors/hooks.ts` as the template.
3. **`controller.push` and the `navigate()` gate** (08-F1): add `push` to
   `PhoneNavigationApi`, convert 143 sites directory by directory, flip the
   eslint rule to `error`.
4. **`SidePanelShell` on `useOverlay`** (08-F4): Back registration, focus
   trap and Escape in the overlay band; replace the breakpoint branch with
   `useNavigationLayout()`.
5. **Mutation feedback cleanup** (09-F3): empty the 43-file allowlist the new
   gate seeds.
6. **z-index allowlist** (02-F3): 28 files onto `OVERLAY_LAYER`/`--layer-*`.
7. **`KnowledgeProvider` → URL state** (07-F2 second half): `spaceId`,
   `productView`, `pageId` from the route; facade hooks called directly.
8. **`usePreference`** (07-F12); **`lib/storage.ts` helpers** (02-F6);
   **`lib/format.ts`** (02-F11); **facade navigation** (08-F9);
   **route-change focus** (09-F9); **`FormField` conversions** (09-F8);
   **gate-test triage** (09-F7); **tiptap behind a lazy boundary** (09-F5).

## Decisions the team owes

- **React Compiler** (09-F6): enable `babel-plugin-react-compiler` and delete
  hand memoisation, or add `memo()` to the five heaviest row components.
  Recommendation: enable it behind the `react-hooks` lint in compiler mode.
- **`ChannelsPage` / `voice-call-client`** (06-F12, 06-F14): both are over
  the cap for structural reasons; each needs an interface redesign, not a
  split. Recommendation: accept a documented exception for the socket
  controller; group the channel page's call cluster into one hook.
- **`ShellEnvironmentProvider`** (07-F11): finish the call-site migration or
  delete it.
- **Route path duplication** (05-F7): keep the tested two-file model, or
  derive the registry regex from the router path literal.

## Verification caveat

Ports 5454/5455 are held by another session's dev stack serving a different
checkout, and ports are non-negotiable, so Playwright screenshots of this
worktree's changes could not be taken during the run. Every change is proven
by typecheck, lint and the unit/render suite; the e2e suites skip without a
database. Visual verification of the header, sidebar and settings changes is
owed before merge if CI does not cover them.
