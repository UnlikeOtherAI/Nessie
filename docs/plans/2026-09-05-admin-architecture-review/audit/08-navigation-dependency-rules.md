# Navigation framework adherence, and dependency direction rules

## Verdict

The navigation framework is real, unusually well documented, and genuinely
load-bearing: the surface registry is total (80 router paths → 45 rows, every
row live, verified by re-running the lint's own extractor in reverse), the
motion has exactly one mover, `history.pushState`/`replaceState` is at zero,
and the gate suite (`navigation-gates`, `tab-param`, `screen-header`,
`dialog-adopters`, `lint-navigation-surfaces`, `lint-layers`) is the strongest
convention-enforcement machinery in the repo. What it does not have is
*closure*: the one gate that would make the framework the only way to push a
screen — the `navigate()` admission rule — is still `'off'` because the
controller API it waits on (`PhoneNavigationProvider`'s `push`) was never
built, and 143 `navigate(` call sites in 72 files sit outside it. Around that
open gate, three families of second implementations have grown back where no
gate looks: a second screen-header shape (`ColumnBrowserColumn`, four routes),
a third overlay family (`SidePanelShell`, three consumers), and hand-rolled
`useSearchParams` tab strips the `useState`-only tab gate cannot see. Roughly
80% of screens follow the framework; the remaining 20% are concentrated in the
column-browser pages, the side panels, and the conversation info chain.

Dependency direction has no enforcement at all in `admin/src` — the repo's four
ratchet lints cover z-index, breakpoints, viewport classification and egress,
but nothing covers layering. 60 imports run against the intended direction
(components→layouts 21, facades→components 12, lib→up 6, navigation→layouts 5,
providers→components 4, components→pages 4, shared→features 4, primitives→up 2,
plus 2 singletons). There are only 2 real module cycles, both intra-directory,
so this is drift rather than tangle, and the biggest single cause is that six
navigation-framework modules live in `layouts/admin-shell/` instead of
`navigation/`.

## Findings

### F1. The `navigate()` admission gate is permanently off because the controller `push` it waits for does not exist, and §16 does not list it as planned

- Severity: high
- Category: navigation
- Evidence:
  - `eslint.config.js:264-284` — the block is `files: ['admin/src/**/*.ts','admin/src/**/*.tsx']`, `ignores: ['admin/src/navigation/**']`, `'no-restricted-syntax': ['off', …]`, commented "*OFF. The controller API this rule will hold call sites to (PhoneNavigationProvider's `push`) does not exist yet; enabled in step 13 once controller.push exists.*"
  - `admin/src/layouts/admin-shell/PhoneNavigationProvider.tsx:53-75` — the whole `PhoneNavigationApi` surface: `performBack`, `performBackAction`, `resolveBackAction`, `hasBack`, `back`, `redirect`, `history`, `sectionTarget`, `pressActiveTab`, `selectTab`. There is no `push`. The only `push` in the file is `tabAction.type === 'push'` at line 156, an internal tab-press branch.
  - `docs/navigation/deep-links-and-headers.md` heads §8 "**built** (step 13)" — step 13 is declared done, but `docs/navigation/overview.md:38-46` (§16 "Still planned") lists only three items and `controller.push` is not among them.
  - 143 `navigate(` call sites in 72 files outside `navigation/` (Appendix 1). Nine of them are `usePhoneNavigation()` consumers, and only four are pages — every other site talks to React Router directly.
- Why it matters: §4.2 and the gate table both promise "one controller"; in practice the controller owns Back and redirect but not push, so the single largest class of navigation — the forward push — has no seam, no ledger hook, no prewarm hook and no lint. Every finding below about a second doorway is downstream of this.
- Fix: add `push(to, options?)` to `PhoneNavigationApi` in `admin/src/layouts/admin-shell/PhoneNavigationProvider.tsx` (wrapping `stateRef.current.navigate` the way `back` already does, so ledger and settle stay in one place) and export a `usePush()` in `admin/src/navigation/` beside `useRedirect` for components outside the provider. Convert the 143 sites directory by directory (Appendix 1 orders them), then flip `eslint.config.js:273` from `'off'` to `'error'` and replace `ignores` with the residual allowlist. Add `controller.push` to `docs/navigation/overview.md` §16 in the same commit that starts the work.
- Fix size: L (143 call sites, 72 files, a public provider contract)
- Risk: a `push` that forgets `{ state }` or `flushSync` breaks the two sites that need them (`ChannelConversationComposePage.tsx:173` uses `flushSync: true`). `admin/test/phone-navigation-stack.test.ts`, `admin/test/navigation-settle.test.ts` and the `phone-push`/`phone-back`/`tablet-split-push` e2e cases prove the stack still commits.

### F2. Four routes render a `h3` column header instead of `ScreenHeader`, so they publish no screen title at all

- Severity: high
- Category: navigation
- Evidence:
  - `admin/src/components/shared/column-browser/ColumnBrowserColumn.tsx:187-201` — a 50px bar with `<h3 className="… text-sm font-semibold …">{title}</h3>`, its own back branch (`stacked ? <PhoneNavigationButton /> : <PhoneBackButton …/>`), no title publication.
  - The four routes whose top-level screen is that column: `admin/src/pages/ToolsPage.tsx:201` (`/agents/tools`), `admin/src/pages/TriggersPage.tsx:23` (`/agents/triggers`), `admin/src/pages/WorkflowsPage.tsx:325` (`/agents/workflows`), `admin/src/pages/IntegrationsPage.tsx:464`.
  - `admin/src/components/shared/ScreenHeader.tsx:92` is the *only* caller of `publishScreenTitle` in `admin/src` (grep across the tree returns exactly `navigation/screen.ts:91` the definition and this one call).
  - `admin/src/navigation/settle.ts:16` — `layer?.querySelector<HTMLElement>('h1')`. `<h1` appears 7 times in `admin/src`, none inside `ScreenHeader`/`ResponsivePageHeader` (they render a dynamic `Heading` tag, `ResponsivePageHeader.tsx:409,448`).
  - `admin/test/screen-header.test.ts:212-216` — the "no hand-rolled header" gate walks `${srcDir}/pages` only.
- Why it matters: §9 says every screen has exactly one `h1` and the settle focuses and announces it, and §10 says `nessie:screen.title` is the header's rendered title. On these four routes the settle finds no `h1` (no focus move, nothing announced), `document.title` stays bare `Nessie`, and the native shell's chrome gets an empty title — silently, on a phone, exactly the failure mode §9 says it fixed.
- Fix: give `ColumnBrowserColumn` a `screen?: boolean` (or have the four pages render `<ScreenHeader>` around the viewport and let column 0 drop its bar). The column that *is* the route's screen renders `ScreenHeader` (heading `h1` + `publishScreenTitle`); columns beyond it keep the `h3` section bar. Then widen `admin/test/screen-header.test.ts` from `${srcDir}/pages` to all of `admin/src`, with an allowlist for the intentional in-body `<header>`s.
- Fix size: M (4 pages + `ColumnBrowserColumn` + 1 test)
- Risk: two `h1`s if a page adds `ScreenHeader` without the column dropping its bar — the widened `screen-header` test and `admin/test/a11y-navigation.test.ts` catch it.

### F3. `ConversationInfoFlow` is a bespoke 58px screen header inside `components/`, where the §9 gate does not look

- Severity: high
- Category: navigation
- Evidence:
  - `admin/src/components/features/channels/ConversationInfoFlow.tsx:37-41` — `<header className="flex h-[58px] …"><PhoneNavigationButton /><h1 className="… text-[17px] font-bold …">{title}</h1>…</header>`.
  - Rendered by `admin/src/pages/ChannelsPage.tsx:601` for the `/channels/:id/info`, `/info/members`, `/info/members/add` route family (three registry rows, `splitInline`).
  - The gate that would have caught it, `admin/test/screen-header.test.ts:212-216`, is scoped to `admin/src/pages/**`.
  - §9 (`docs/navigation/deep-links-and-headers.md`) names "the hand-rolled hero and **58 px bars** the pages had grown" as precisely what `ScreenHeader` replaced.
- Why it matters: three real screens carry a header shape the framework deleted, with their own `h1` (so they do focus, but publish no title — same `document.title`/`nessie:screen` hole as F2) and their own hardcoded 58px/`text-[17px]` geometry that will drift from the one bar every other screen renders.
- Fix: replace `FlowHeader` in `ConversationInfoFlow.tsx` with `<ScreenHeader title={title} actions={…} />`; delete the local component. Widen the `screen-header` gate as in F2 so `components/features/**` is covered.
- Fix size: S (1 file + the gate)
- Risk: the info chain's actions slot may not fit `PageHeaderAction[]`; `admin/test/screen-header.test.ts` and the channel info e2e path prove the doorway and heading survive.

### F4. `SidePanelShell` is a third overlay family: three consumers, CSS-breakpoint layout branching, no Back registration, and one of them has no Escape

- Severity: high
- Category: navigation
- Evidence:
  - `admin/src/components/features/channels/side-panel/SidePanelShell.tsx:143` — `className="thread-panel-scrim fixed inset-0 z-[var(--layer-card)] hidden bg-[var(--scrim-strong)] min-[900px]:max-xl:block"`, and `:156-159` — `max-[900px]:fixed max-[900px]:inset-0 … min-[900px]:max-xl:fixed min-[900px]:max-xl:inset-y-0 min-[900px]:max-xl:right-0`. Below 900px it is a full-screen surface; 900–1279 it is a scrimmed overlay.
  - Three consumers, not one: `components/features/channels/thread-panel/ThreadReplyPanel.tsx:214`, `components/features/browser-cloud/AgentScreenPanel.tsx:85`, `components/features/dashboards/DashboardWorkspacePanel.tsx:65`.
  - `docs/navigation/overlays.md` sanctions exactly one: "*Two edge cases stay outside it deliberately: the thread reply panel's 900–1279 px overlay mode … and the design-assistant panel*". `AgentScreenPanel` and `DashboardWorkspacePanel` are undeclared new adopters of that carve-out.
  - No `useLocalBack` / `useOverlay` in `ThreadReplyPanel.tsx` or `DashboardWorkspacePanel.tsx` (`useLocalBack(` has exactly three callers in `admin/src`: `navigation/NestedStage.tsx:82`, `components/overlays/useOverlay.ts:78`, `components/shared/column-browser/ColumnBrowserViewport.tsx:98`).
  - `ThreadReplyPanel.tsx:162-176` hand-rolls Escape with a `window.addEventListener('keydown', …)`. `DashboardWorkspacePanel.tsx` has no Escape at all — its only dismissals are `onClose` at `:76` (a `PhoneBackButton`) and `:124`.
- Why it matters: §7 says an overlay registers `overlay:<id>` with the Back registry "*so hardware Back, the header Back, the edge swipe and Escape agree*". These panels register nothing, so on Android hardware Back the route pops out from under an open full-screen panel; and a phone user of the dashboard workspace panel has no keyboard escape. §5 also forbids reading a breakpoint to decide a container — this shell reads three.
- Fix: make `SidePanelShell` call `useOverlay({ kind: 'sheet', … })` when it is in its overlay/full-screen band, so all three consumers inherit Back registration, focus trap and Escape from one place; delete `ThreadReplyPanel.tsx:162-176`. Replace the `min-[900px]:max-xl:` CSS branch with a `useNavigationLayout()` branch, or record the three-band exception explicitly in §7 naming all three consumers.
- Fix size: M (4 files + `admin/test/navigation-overlay.test.ts`)
- Risk: a focus trap on the ≥1280px in-flow branch would break the "content beside it stays live" contract `components/shared/SidePanel.tsx:9-14` states — the trap must arm only in the overlay band. `admin/test/sheet.test.ts` and `admin/test/navigation-overlay.test.ts` cover the registration.

### F5. Two tab strips hand-roll `useTabParam` through `useSearchParams`, and the tab gate cannot see them

- Severity: medium
- Category: state
- Evidence:
  - `admin/src/pages/settings/MembersRosterPanel.tsx:105,110-115` — `const [searchParams, setSearchParams] = useSearchParams()`, then `const requestedTab = searchParams.get('membersTab')` and a hand-written three-value validate-or-fallback ladder; the writer is `setTab` at `:141-149` (`{ replace: true }`); the strip is `<TabBar … onChange={setTab} value={tab} />` at `:189-195`. That is `useTabParam('membersTab', …, 'active')` rewritten.
  - `admin/src/pages/ConnectedMailPage.tsx:56` — `const filter = searchParams.get('filter') === 'unread' ? 'unread' : 'all'`, written through a generic `setState` merger at `:95-99`, strip at `:172`.
  - The gate, `admin/test/tab-param.test.ts:299-311`, only flags a `<TabBar value={x}>` whose `x` matches `const [x, …] = useState`. A `useSearchParams`-derived value passes silently.
  - Neither host appears in the §1 host table (`docs/navigation/page-types-and-motion.md`).
- Why it matters: each is a second copy of the read/validate/fallback/delete-the-default/carry-`location.state` contract in `admin/src/navigation/useTabParam.ts:23-54`. `MembersRosterPanel` in particular drops the "selecting the fallback deletes the param" rule, so `?membersTab=active` sticks in shared links.
- Fix: replace both with `useTabParam` (`'membersTab'` and `'filter'`), delete the local ladders, add both rows to the §1 host table. Then extend `admin/test/tab-param.test.ts` so a `<TabBar value={x}>` whose `x` traces to `searchParams.get(` is also a violation.
- Fix size: S (2 files + 1 test + 1 doc row)
- Risk: `ConnectedMailPage`'s `setState` merger also writes `pageSize`, `threadId`, `compose` — only the `filter` key moves. `admin/test/tab-param.test.ts` proves the strip still resolves.

### F6. The overlays chapter's carve-out list is three entries out of date, and the z-index claim is 27 files out of date

- Severity: medium
- Category: navigation
- Evidence:
  - `docs/navigation/overlays.md` lists eleven surfaces that "*Kept a carve-out on `useOverlay` alone*", among them `AgentAvatarQuickEdit`, `DeepWaterResearchLauncherDialog` and `TriggerEditorDialog`. All three are on `Dialog` now: `components/features/agents/AgentAvatarQuickEdit.tsx:143`, `components/features/integrations/DeepWaterResearchLauncherDialog.tsx:51`, `components/features/triggers/TriggerEditorDialog.tsx:274`. `admin/test/dialog-adopters.test.ts:42,50,53` already records all three as `mode: 'dialog'`.
  - Only 11 files in `admin/src` call `useOverlay(` at all, four of which are the primitives themselves.
  - `docs/navigation/overlays.md`: "*Nothing else in the admin declares a z-index (the lint gate lands in step 15 once the fifty overlays have adopted the scale).*" The gate landed; `scripts/lint-layers.mjs:30-58` carries 27 still-offending source files plus `styles.css`. `docs/navigation/overview.md` §16 does not list that allowlist.
- Why it matters: §7 is the reference the next author reads before choosing an overlay. Reading it today, they conclude eleven surfaces could not be expressed by `Dialog` — three of them since were — and that no z-index literals remain, when 27 files carry them.
- Fix: in `docs/navigation/overlays.md`, delete the three converted names from the carve-out paragraph (leaving eight) and re-word the z-index sentence to "*every remaining literal is listed in `scripts/lint-layers.mjs`'s allowlist, which only shrinks*". Add the `lint-layers` allowlist to `docs/navigation/overview.md` §16 beside the other two shrinking lists.
- Fix size: S (1 doc, 2 paragraphs)
- Risk: none. `admin/test/dialog-adopters.test.ts` is the source of truth either way.

### F7. Two files render the same hand-rolled `role="dialog"` emoji menu, and they are two of the three bespoke-dialog allowlist entries

- Severity: medium
- Category: reuse
- Evidence:
  - `admin/src/components/features/channels/ChannelMessageActions.tsx:141-158` and `admin/src/components/features/knowledge/comments/CommentActions.tsx:106-124` are near-identical: same `<div className="relative" ref={pickerRef}>`, same `aria-haspopup="dialog"` trigger, same `<div className="admin-msg-emoji-menu" id={pickerId} role="dialog"><EmojiPickerPanel …/></div>`. The only differences are the handler name and the tooltip string.
  - Both are entries in `BESPOKE_DIALOG_ALLOWLIST`, `admin/test/navigation-gates.test.ts` (the third is `layouts/admin-shell/NativeSearchOverlay.tsx`). All three still fail the sanctioned-usage test, so no line can be deleted today — the allowlist is honest.
  - `EmojiPickerPanel` has four other hosts (`ComposerEmojiButton`, `EditProjectDialog`, `StatusEmojiPicker`, and its own module) which do not paint this menu.
- Why it matters: it is one anchored menu written twice, and it is 2/3 of the remaining bespoke-dialog debt. §7 already declares `Popover` the anchored primitive with `role`, outside-press, Escape and one `placePopover`; these two get none of it and neither flips nor clamps at a viewport edge.
- Fix: extract one `EmojiReactionButton` (trigger + `<Popover role="menu" anchorRef={…}>` + `EmojiPickerPanel`) into `components/shared/`, use it from both files, delete both allowlist lines from `admin/test/navigation-gates.test.ts`. That takes the list from three entries to one.
- Fix size: S (3 files)
- Risk: the picker sits inside a hover-revealed action row; a portalled `Popover` must not close when the row un-hovers. `admin/test/popover.test.ts` and `admin/test/navigation-gates.test.ts` (the allowlist self-check refuses a stale line) prove it.

### F8. `useReplyThread` keeps its own copy of the panel geometry that `useSidePanelGeometry` was extracted to unify

- Severity: medium
- Category: reuse
- Evidence:
  - `admin/src/hooks/useSidePanelGeometry.ts:32-62` — `readThreadPanelWidth(window.localStorage.getItem(storageKey), window.innerWidth)`, `persist`, `resize`. Its eslint admission in `eslint.config.js:132-134` reads: "*The same drag geometry, lifted out of `useReplyThread` so the reply panel and the agent-screen panel cannot disagree about clamping.*"
  - `admin/src/pages/channels/useReplyThread.ts:125-159` still holds the original: `useState(() => window.innerWidth)`, `window.localStorage.getItem(THREAD_PANEL_WIDTH_STORAGE_KEY)`, `clampThreadPanelWidth`, its own resize listener and its own two `setItem` writers.
  - The two real adopters of the extracted hook are `AgentScreenPanel.tsx:30` and `DashboardWorkspacePanel.tsx:24`. The panel it was extracted *from* never adopted it.
- Why it matters: the extraction's stated purpose is unmet — there are now two clamping implementations, and `useReplyThread` also carries a second `window.innerWidth` reader that the viewport-classification gate has to keep admitting (`eslint.config.js:130`).
- Fix: replace `useReplyThread.ts:125-159` with `useSidePanelGeometry(THREAD_PANEL_WIDTH_STORAGE_KEY)`, delete the local width state, persist and resize, and drop `admin/src/pages/channels/useReplyThread.ts` from the `ignores` list at `eslint.config.js:130`.
- Fix size: S (1 file + 1 eslint line)
- Risk: the reply panel's min width comes from `thread-panel-helpers`; confirm `useSidePanelGeometry` clamps to the same constant. `admin/test/` reply-panel coverage plus `pnpm lint` (the removed admission must stay green).

### F9. Two facades navigate, and one navigates on a mutation success

- Severity: medium
- Category: layering
- Evidence: `admin/src/facades/team/invitations.ts:3,18,35` (`useNavigate` → `navigate('/channels', { replace: true })`), `admin/src/facades/team/provisioning.ts:2,87,99` (same), `admin/src/facades/channels/dm-navigation.ts:22,36,42` and `:56,65` (`useNavigateToDm` / `useNavigateToAgentDm`, three pushes after a channel lookup/create).
- Why it matters: `docs/provider-system-and-frontend-architecture.md` §4/§5 makes a facade a data boundary (api/queries/mutations/types/hooks); a facade that decides where the person goes next means the same mutation cannot be reused from a second surface without also being navigated. Two of the three are effect-shaped replaces that §4.2 says belong to `redirect()` (which waits for the stack to settle and is dropped if the location moved) — `redirect` has only 5 non-`navigation/` callers today.
- Fix: return the target from the facade (`useAcceptInvitation()` resolves to `{ channelId }`) and let the calling page navigate; for `dm-navigation.ts`, split into `facades/channels/resolveDmChannel.ts` (data) plus a `useOpenDm()` in `components/shared/` or `pages/channels/`. Convert the two `{ replace: true }` sites to `useRedirect()`.
- Fix size: M (3 facades + their ~6 call sites)
- Risk: a caller that forgets to navigate silently does nothing after accepting an invite. Typecheck plus the team-provisioning tests.

### F10. `flowPresentation` is a declared field no code reads, and `type` decides far less than §1 claims

- Severity: medium
- Category: structure
- Evidence:
  - `admin/src/navigation/page-types.ts:27` declares `SurfaceFlowPresentation = 'panel' | 'screen'`. Grep for `flowPresentation` across `admin/src` returns only the three registry files (`surfaces.ts:109`, `admin-surfaces.ts:64,76`, `connected-mail-surfaces.ts:20`) and the type declaration. Nothing reads it — not "reads only one value", *reads it never*.
  - `surface.type` has exactly four consumers: `navigation/surface-lookup.ts:26,82` (skip `redirect`), `:62` (stop the seed chain at `root`), `navigation/screen.ts:54` (the `screenType` wire field), and `layouts/admin-shell/PhoneNavigationLayer.tsx:92` (`type === 'root' || type === 'detail'`, the pull-to-refresh eligibility of §13).
  - Direction and motion come from `depth` (`navigation/motion.ts:58-77` takes a `StackDirection`, computed from depth by the stack), and sibling-swap identity from `identityOf`/`keyScope`.
- Why it matters: §1 opens "*the type decides its container, its motion and its Back rule*". A reader adding a route will agonise over `flow` vs `tabHost` vs `nested` when only `root`/`detail`/`redirect` change behaviour — and will assume `flowPresentation: 'panel'` does something. AGENTS.md "Code Quality" names exactly this (no premature abstraction).
- Fix: either delete `flowPresentation` from `page-types.ts` and the three rows (bring it back with the centred-panel work §16 promises), or add the one consumer. Reword §1's opening to what is true: "the type is the vocabulary the shell and the native bridge read; `depth` decides direction and `identityOf` decides a sibling swap."
- Fix size: S (1 type, 3 rows, 1 doc paragraph)
- Risk: none — nothing reads the field.

### F11. Every route path is declared twice, and the lint only checks one direction

- Severity: medium
- Category: structure
- Evidence:
  - `admin/src/router.tsx` declares 80 `path:` string literals; `admin/src/navigation/{surfaces,admin-surfaces,connected-mail-surfaces}.ts` declare 45 `pattern:` regexes covering the same space. `/channels/:channelId/info` is `path: ':channelId/info'` in the router and `/^\/channels\/([^/]+)\/info$/` in the registry.
  - `scripts/lint-navigation-surfaces.mjs` (`main()`, the `unclassified` filter) asserts router → registry only. Re-running its own exported `collectRouterPaths` / `collectSurfacePatterns` in reverse: every one of the 45 rows currently matches at least one router path, so nothing is dead today — but nothing keeps it that way, and a retired route leaves a live-looking row behind.
  - `matchSurface` is first-match-wins (`admin/src/navigation/surfaces.ts:322-329`). Fourteen router paths are matched by two rows — e.g. `/agents/designer` matches both `/^\/agents\/designer(?:\/([^/]+))?$/` and the broader `/^\/agents\/([^/]+)$/`; `/channels/new` matches both its own row and `/^\/channels\/([^/]+)(?:\/.*)?$/`. Correctness depends entirely on array order, and nothing asserts the order.
- Why it matters: the totality gate makes "add a route, forget the row" impossible but not "reorder the array" or "delete the route, keep the row". A specific row moved below its general sibling silently reclassifies `/agents/designer` as an agent detail — wrong depth, wrong parent, wrong motion — with every test still green.
- Fix: add two assertions to `scripts/lint-navigation-surfaces.mjs`: (1) every `pattern` matches ≥1 router sample path, and (2) for any router path matched by more than one pattern, the *first* matching row must be the one whose pattern is strictly more specific (fewer capture groups / no trailing `(?:\/.*)?`) — or, simpler and stricter, fail on any multi-match that is not on a declared `SHADOWED_PATHS` list. The extraction helpers for both already exist and are exported.
- Fix size: S (1 script + the seeded shadow list)
- Risk: the fourteen legitimate shadows must be seeded or the lint reddens `pnpm lint` immediately.

### F12. `docs/architecture.md` still names a component the tests assert does not exist

- Severity: low
- Category: naming
- Evidence: `docs/architecture.md:65` — "*`ResponsivePageHeader`/`AdminPageHeader`. Give each action an explicit …*". `admin/test/screen-header.test.ts:194` asserts `existsSync(components/shared/AdminPageHeader.tsx) === false`, and `:202` asserts nothing in `admin/src` imports or renders it. The one live entry point is `ScreenHeader` (25 files); `ResponsivePageHeader` is rendered directly in exactly three places (`components/features/knowledge/KnowledgePane.tsx:22`, `components/features/workflow-designer/WorkflowToolbar.tsx:45`, `components/features/workflow-designer/WorkflowDesignerHeader.tsx:113`), and §9 sanctions the first two by name but not the third.
- Why it matters: `architecture.md` is the guardrail doc a new author reads first, and it points at a deleted component. Separately, `WorkflowDesignerHeader` gives the `/agents/workflow-designer` route a `ResponsivePageHeader` with `title="Workflow Designer"` and its own `onBack` — the same no-`h1`, no-`publishScreenTitle` hole as F2.
- Fix: rewrite `docs/architecture.md:65` to name `ScreenHeader` as the one entry point, with `ResponsivePageHeader` as the primitive for bars that are not a route's screen header (the two §9 names it). Convert `WorkflowDesignerHeader.tsx:113` to `ScreenHeader` with `flowOwnsBack`, or add it to §9's sanctioned list with its reason (the `titleInput` inline rename, which `ScreenHeader` does not expose).
- Fix size: S (1 doc line + 1 component)
- Risk: `titleInput` is not on `ScreenHeader`'s prop surface; if it stays on `ResponsivePageHeader`, only the doc changes.

### F13. The §1 tab-exception count disagrees with itself and with the allowlist

- Severity: low
- Category: navigation
- Evidence: `docs/navigation/page-types-and-motion.md` says "*Those three keep `useState`*" (app-connect scope, app-secret scope, the approval gate) and then, in the same section, "*allowlist: the two dialog form fields*". `admin/test/tab-param.test.ts:270-278` has six: `AppConnectDialog`, `AppSecretDialog`, `RunApprovalGate`, `layouts/admin-shell/CreateTeamDialog.tsx`, `pages/settings/MemberInvitationDialog.tsx`, `pages/settings/organization/OrganizationAppearancePage.tsx`. Each of the three undocumented entries carries its own justification comment in the test, so the code is honest; the doc is two numbers wrong.
- Why it matters: §16 promises the allowlists only shrink; a reader comparing the doc's "two"/"three" to the file's six will read growth where there was none.
- Fix: replace both phrases in `docs/navigation/page-types-and-motion.md` with a single sentence naming all six and pointing at `admin/test/tab-param.test.ts` as the list of record.
- Fix size: S (1 doc paragraph)
- Risk: none.

### F14. `admin/src` has no layering enforcement, and 60 imports run backwards

- Severity: medium
- Category: layering
- Evidence (full edge map and file list in Appendices 2–3; measured by resolving every relative specifier in the 883 source files):
  - `components → pages` 4 — `ActiveSessionsTable.tsx:5` is a *value* import (`describeSessionDevice` from `pages/settings/session-device`); the other three are type-only.
  - `facades → components` 12 — five are `useIsOwner` from `components/shared/OwnerGate`, three are non-React modules misfiled under `components/features/apps` (`connect-flow.ts`, `external-auth-launcher.ts`, `connect-error-copy.ts` — none imports React), two are designer types, one is `AgentMention` from `MentionInput`.
  - `components/shared → components/features` 4 — all `AgentVisibilityPill` / `agent-scope`.
  - `components → layouts` 21 — 15 of them are four navigation modules that live in the wrong directory (`PhoneBackButton`, `PhoneNavigationButton`, `local-back/LocalBackContext`, `phone-navigation-gesture`), and `navigation/ → layouts/` adds 5 more of the same kind (`navigation/back.ts:1-6` imports `local-back/local-back-registry`, `phone-navigation-ledger`, `phone-navigation`; `navigation/history.ts` adds the ledger and `nav-items`).
  - `primitives → up` 2 — `AvatarBadges.tsx:2` reads `providers/PresenceProvider`; `TabBar.tsx:14` imports `components/overlays/Popover`.
  - `lib → up` 6 — `lib/external-auth.ts:23` and `lib/pkce.ts:40` read `providers/ThemeProvider`; `lib/avatar.ts` reads `components/primitives/identity-shape`; `lib/mobile-shell.ts` reads `hooks/useViewport` and `navigation/layout`.
  - `providers → components` 4 (excluding the sanctioned `ToastProvider → CardViewport` viewport mount), plus `providers/AppProvider.tsx → router`; `hooks → components/features` 1; `kanban → components/features` 1; `components/shared/ResponsivePageHeader.tsx → layouts/admin-shell/AccountMenuContext` 1.
  - There are only **2** real module cycles in `admin/src` (`ResponsivePageHeader ↔ PageHeaderMenu`, `PhoneNavigationProvider ↔ NativePhoneNavigationBridge`), both intra-directory — so this is direction drift, not a tangle.
  - No lint covers it: `scripts/lint-{layers,breakpoints,navigation-surfaces,test-globs,migrations}.mjs` cover z-index, viewport, route totality, test globs and migrations; `eslint.config.js`'s only `admin/src` `no-restricted-imports` block bans `useMediaQuery` (`:146-179`).
- Why it matters: `docs/provider-system-and-frontend-architecture.md` §5.3 declares the primitives/shared/features/pages layering, and it is the only structural rule in the repo with no ratchet behind it — which is why 60 edges accumulated while every gated rule held.
- Fix: the graph in Appendix 2 plus `scripts/lint-admin-layers.mjs` seeded from Appendix 3. Land the lint first (green on day one), then the four mechanical moves that delete 33 of the 60 edges in one sitting: (a) move `local-back/`, `phone-navigation*.ts`, `nav-items.ts`, `PhoneBackButton.tsx` and `PhoneNavigationButton.tsx` from `layouts/admin-shell/` into `navigation/` — 21 edges; (b) move `isOwnerSession`/`useIsOwner` out of `components/shared/OwnerGate.tsx:37-40` into `facades/auth/` — 5 edges; (c) move `connect-flow.ts`, `external-auth-launcher.ts`, `connect-error-copy.ts` from `components/features/apps/` to `facades/apps/` — 3 edges; (d) move `AgentVisibilityPill`/`agent-scope` from `components/features/agents/` to `components/shared/` — 4 edges.
- Fix size: L (the lint is S; the four moves touch >20 files and shift public module paths)
- Risk: the moves are import-path churn only, no behaviour; `pnpm -w typecheck` plus `pnpm lint` prove them. Moving `local-back` is the one with real risk — `admin/test/knowledge-local-back.test.ts` and `nested-stage-viewport.test.ts` import those paths.

### F15. Do not introduce a `@/` alias — the depth problem is smaller than the churn

- Severity: low
- Category: structure
- Evidence: measured across all `.ts`/`.tsx` in `admin/src`: 3589 relative imports total — depth 2 (`../../`) 1347, depth 3 638, depth 4 **62**, depth 5 **0**. The maximum directory nesting under `src` is 4. All 62 depth-4 imports live in 29 files in 9 directories: `components/features/agents/todos` (7 files), `.../agents/designer` (6), `knowledge/comments` (5), `channels/panels` (4), `knowledge/wikilink` (3), `knowledge/notes`, `knowledge/backlinks`, `channels/thread-panel`, `channels/side-panel` (1 each). Neither `admin/tsconfig*.json` nor `admin/vite.config.ts` declares `paths`/`alias` today.
- Why it matters: an alias would rewrite ~3589 specifiers to fix 62 (1.7%), invalidate every reviewer's path intuition, and require duplicating each `no-restricted-imports` `paths` entry in both spellings for a transition period (the `useMediaQuery` block at `eslint.config.js:146-179` already spells one ban five ways because of relative depth — an alias makes that six).
- Fix: skip the alias. If the deep chains are the actual irritant, flatten the two worst trees instead — `components/features/agents/{designer,todos}` → `components/features/agent-designer/` and `components/features/agent-todos/` — which takes 13 of the 29 files to depth 3 and is a rename, not a global rewrite. Separately, delete the four redundant `paths` entries at `eslint.config.js:150-176`: the `patterns: [{ group: ['**/hooks/useMediaQuery'] }]` entry beneath them already matches every depth.
- Fix size: S (the eslint cleanup) / M (the optional flatten)
- Risk: none for the eslint cleanup — remove the four `paths` entries and confirm `pnpm lint` still rejects a test import of `useMediaQuery`.

## Conventions observed

- **One declaration table, two files per route.** Every route's path exists as a `path:` literal in `router.tsx` and as a `pattern:` regex in one of the three registry files; the pair is enforced router→registry by `scripts/lint-navigation-surfaces.mjs` and by `admin/test/navigation-surfaces-total.test.ts`. Adding a route means adding a row.
- **Effects redirect, interactions navigate.** A navigation the person did not ask for goes through `redirect()`/`useRedirect()` (waits for the settle, replaces, forwards state, drops if the location moved); a navigation they asked for calls `navigate` directly. The rule holds for the five conversions §4 names and is broken by the 19 `navigate(…, { replace: true })` sites outside `navigation/`.
- **Back is never local state.** Anything that owns Back registers with the local-back registry through exactly one of `NestedStage`, `useOverlay`, or `ColumnBrowserViewport`; `useLocalBack(` has three callers in the whole tree and nothing else may call it.
- **A tab is a URL param written with `replace`, never a history entry.** 21 call sites on `useTabParam`; the exceptions are form fields inside a transient overlay, each with a comment at its site and a line in `admin/test/tab-param.test.ts`.
- **A screen title is published, not derived.** `ScreenHeader` is the only caller of `publishScreenTitle`; `document.title`, the announcer and `nessie:screen` all read that one publication.
- **An overlay leaves the page tree.** Every `useOverlay` consumer portals through `OverlayPortal` into `.admin-overlay-root`; `active={false}` is the single documented opt-out.
- **A gate ships with a shrinking allowlist, and the allowlist self-checks.** `BESPOKE_DIALOG_ALLOWLIST`, `COMPONENT_STATE_ALLOWLIST` and `NAVIGATION_KEYFRAME_ALLOWLIST` all assert their own entries are still real offenders, so a converted file's line fails the test until it is deleted. `scripts/lint-layers.mjs` uses the same idiom without the self-check.
- **Layers are declared twice on purpose** (`--layer-*` in `styles.css`, `OVERLAY_LAYER` in `navigation/overlay.ts`) and read everywhere else.
- **`components/shared` may consume facade and provider hooks** (10 and 12 edges) — de facto, and correctly: a shared component that took identity as a prop would push identity plumbing into every page.
- **Non-React logic modules sit beside their React consumers** (`connect-flow.ts`, `composer-draft.ts`, `agent-scope.ts` under `components/features/**`) rather than in `facades/` or `lib/`. Unwritten and, in the three `apps` cases, the cause of a reverse edge.

## Not a problem

- **`history.pushState`/`replaceState` is at zero in `admin/src`.** The §8 gate holds; the executors page's four writes are gone.
- **`window.location.assign` (7 sites) and `popup.location.href` (2).** All are external navigations — OAuth authorize URLs and UOA billing redirects (`components/features/billing/UoaBilling*Panel.tsx`, `lib/external-auth.ts:52`, `pages/settings/ConnectionsPage.tsx:88`). Leaving the SPA is not a screen push and correctly bypasses the framework.
- **The 45 surface rows are all live.** Re-running the lint's exported extractors in reverse found zero rows matching no router path, so the registry has no dead entries today (F11 is about keeping it that way, not fixing it).
- **The three `BESPOKE_DIALOG_ALLOWLIST` entries are all still genuine offenders.** `ChannelMessageActions.tsx`, `CommentActions.tsx` and `NativeSearchOverlay.tsx` each carry `role="dialog"` with no sanctioned primitive; the test's own self-check would fail on a stale line, so no line can be deleted yet (F7 is how to earn two deletions).
- **`facades → providers` (97) and `providers → facades` (17) look like a cycle but are not.** A full DFS over the module graph found exactly 2 cycles in `admin/src`, both intra-directory and neither involving these two directories. Facades read `ApiClientProvider`/`AuthSessionProvider`; providers read facade *hooks*. Different modules, no cycle.
- **`components/shared/SidePanel.tsx` vs `components/features/channels/side-panel/SidePanelShell.tsx` are two different things, correctly.** `SidePanel` is layout (in flow, no scrim, no trap — `SidePanel.tsx:9-14` states the rule and the reason); `SidePanelShell` is the overlay-band panel. The names are confusingly close but the split is right; F4 is about the shell's missing Back, not about merging them.
- **`window.confirm` is gone.** The only `confirm(` call outside `ConfirmDialog` props is `pages/settings/connections/DeviceLinkDialog.tsx:221`, a local callback named `confirm`.
- **`navigation/prewarm.ts → facades` (6 edges).** §14 requires prewarm to call "the exact `fetch*` function the destination's hook calls" — a copy inside `navigation/` would be the second fetcher the chapter forbids and `admin/test/prewarm.test.ts` pins against. This edge is correct; Appendix 2 declares it as a named exception rather than a violation.
- **`useScrollMemory` living in `hooks/` rather than `navigation/`.** It is a generic scroll-position map (`hooks/useScrollMemory.ts:6`, an in-memory `Map`) with four callers, two of which are section sidebars that are not navigation layers at all. §12 discusses it but does not require it to move.
- **`lib/workflow-designer/draft-storage.ts` as a second draft store.** §15's own table lists the workflow designer with its own pre-existing store and key scheme; it is declared, not drift. (It is, however, absent from §16's "still planned" list — worth one line there, not a finding.)

---

## Appendix 1 — `navigate` / `Link` call sites by directory

Measured over `admin/src/**/*.{ts,tsx}`. "navigate(" counts call expressions (excluding `useNavigate` imports and the `navigation/redirect.ts` definition site's comment); "Link" counts `<Link`/`<NavLink` JSX elements.

| directory | files using `useNavigate` | `navigate(` calls | `<Link`/`<NavLink` |
| --- | --- | --- | --- |
| `pages/` (top level) | 17 | 49 | 3 |
| `components/features/**` | 25 | 37 | 40 |
| `layouts/admin-shell/**` | 10 | 28 | 11 |
| `providers/**` | 3 | 5 | 0 |
| `pages/channels/**` | 4 | 5 | 4 |
| `pages/settings/**` | 3 | 4 | 2 |
| `facades/channels/**` | 1 | 3 | 0 |
| `components/shared/**` | 3 | 3 | 2 |
| `pages/workflow-designer/**` | 1 | 2 | 0 |
| `pages/project/**` | 1 | 2 | 5 |
| `facades/team/**` | 2 | 2 | 0 |
| `components/kanban/**` | 1 | 1 | 1 |
| `navigation/**` (sanctioned) | 1 | 2 | 0 |
| **total** | **72** | **143** | **68** |

Sites that bypass `intent.ts` / `redirect.ts` / `back.ts`:

- **19 `navigate(…, { replace: true })` outside `navigation/`** — each is a `redirect()` written by hand (no settle wait, no drop-if-moved): `providers/ExternalAuthRouterBridge.tsx:20`, `components/shared/LoginSessionImportButton.tsx:58`, `layouts/admin-shell/TeamSwitcher.tsx:147,157`, `layouts/admin-shell/useAdminShell.ts:335`, `facades/team/provisioning.ts:99`, `facades/team/invitations.ts:35`, `pages/ChannelConversationComposePage.tsx:88,173,210`, `pages/AgentDesignerPage.tsx:255`, `pages/LoginPage.tsx:130,164,178`, `pages/BootstrapPage.tsx:69`, `pages/settings/SettingsProfilePage.tsx:72`, `pages/settings/StatusesPage.tsx:209`. (`pages/ChannelConversationComposePage.tsx:173` additionally passes `flushSync: true`, a router escape hatch that skips the transition.)
- **5 facade-owned navigations** — `facades/channels/dm-navigation.ts:36,42,65`, `facades/team/invitations.ts:35`, `facades/team/provisioning.ts:99` (F9).
- **Zero** `history.pushState`/`replaceState`; **zero** in-app `window.location` pushes (the 7 `assign` sites are external, see "Not a problem").
- `redirect()` / `useRedirect()` has only **7** call sites (`navigation/intent.ts:117,160`, `pages/LoginPage.tsx:36`, `pages/BootstrapPage.tsx:31`, `pages/ChannelsPage.tsx:54`, `pages/settings/StatusesPage.tsx:48`, `pages/channels/useDeepWaterResearchLauncher.tsx:13`); the controller (`usePhoneNavigation()`) has 11, of which 7 are the shell itself and 4 are pages calling `back()`.

## Appendix 2 — the intended dependency graph, and the enforcement

### The allowed edges

Ten layers, ordered. An arrow is "may import from"; a layer may always import from itself, from `node_modules`, and from the `@nessie/*` workspace packages.

```
lib                    →  (nothing in admin/src)
hooks                  →  lib
navigation             →  lib, hooks, providers
facades                →  lib, hooks, providers
providers              →  lib, hooks, facades, navigation, components/overlays¹
components/primitives  →  lib
components/overlays    →  lib, hooks, navigation, components/primitives
components/shared      →  lib, hooks, navigation, facades, providers,
                          components/primitives, components/overlays
components/features    →  everything above, + components/shared
components/kanban      →  everything above, + components/shared
layouts                →  everything above
pages                  →  everything above, + layouts
router.tsx / main.tsx  →  everything
```

¹ `providers → components/overlays` is allowed for **viewport mounts only** — a provider that mounts the region an ambient surface lives in (`ToastProvider.tsx → CardViewport`). It does not license a provider rendering product UI.

Named exceptions, declared rather than inferred (each is one line in the lint's `EXCEPTIONS` map, not a general edge):

- `navigation/prewarm.ts → facades/**` — §14 requires the exact `fetch*` the destination's hook calls; a copy would be the second fetcher `admin/test/prewarm.test.ts` pins against.

### Contested edges, decided

| edge | decision | reason from the code |
| --- | --- | --- |
| `components/shared → facades` (10) | **allow** | `OwnerGate`, `AssigneePicker`, `MemberManagementPopup` and the identity tiles need "who is this / what may they do". Threading that through props from ~40 call sites is the duplicated identity `docs/provider-system-and-frontend-architecture.md` §6 forbids. Restriction: facade **hooks** only, never a facade's `api.ts`. |
| `components/shared → providers` (12) | **allow** | Same reason; `OwnerGate.tsx:3` reads `useAuthSession` and that is the single source of truth. |
| `facades → components/shared/OwnerGate` (5) | **deny; move the symbol** | The facades want the *predicate* (`useIsOwner`, to gate `enabled:`), not the render gate. `OwnerGate.tsx:37-40` bundles both. Move `isOwnerSession`/`useIsOwner` to `facades/auth/` — `providers/` already imports `facades/auth/hooks` (`ThemeProvider.tsx:16`), so the direction is established. |
| `facades → components/features/apps/*` (3) | **deny; move the modules** | `connect-flow.ts`, `external-auth-launcher.ts`, `connect-error-copy.ts` import no React. They are facade logic filed under `components/`. |
| `facades/designer → components/.../useAgentDesigner` (3) | **deny; invert the type** | Type-only (`AgentFormState`, `AgentDesignerActions`, `DesignerPageContext`). The form shape is the facade's contract — declare it in `facades/designer/types.ts` and let the component import it. |
| `facades/messages → components/shared/MentionInput` (1) | **deny; move the type** | Type-only (`AgentMention`). It describes a message payload; it belongs in `facades/messages/types.ts`. |
| `navigation → layouts/admin-shell/*` (5, over 3 files) | **deny; move the modules** | `navigation/back.ts:1-6` imports the local-back registry, the ledger and `phone-navigation.ts`. Those *are* the framework, not shell chrome. Moving them into `navigation/` also deletes 15 of the 21 `components → layouts` edges in the same change. |
| `components/* → layouts/admin-shell/PhoneBackButton\|PhoneNavigationButton\|LocalBackContext\|phone-navigation-gesture` (15) | **deny; resolved by the move above** | These are the doorway and the registry — navigation, not shell. |
| `components/features/knowledge → layouts/admin-shell/SidebarRow` (3) | **deny; move `SidebarRow` to `components/shared`** | Three feature components and the personal-assistant surface render sidebar rows; `sidebarAriaCurrent` is a shared a11y helper (§12 names it as *the* one helper). |
| `components/primitives → providers` (1) | **deny; pass a prop** | `AvatarBadges.tsx:2` reads `useUserPresence`. A primitive that subscribes to app context cannot be rendered in isolation; its two callers already know the user. |
| `components/primitives → components/overlays` (1) | **deny; invert** | `TabBar.tsx:14` imports `Popover` for its overflow menu. Either take the overflow control as a render prop, or the popover-bearing `TabBar` belongs in `components/shared`. |
| `lib → providers/hooks/navigation/primitives` (6) | **deny** | `lib/external-auth.ts:23` and `lib/pkce.ts:40` read `ThemeProvider` to pass a theme to the IdP — the caller should pass the resolved value. `lib/mobile-shell.ts` (reads `hooks/useViewport`, `navigation/layout`) is a hook module misfiled in `lib`: move it to `navigation/`. `lib/avatar.ts → components/primitives/identity-shape`: move `identity-shape` to `lib`. |
| `providers → components/shared|features` (4) | **deny** | `IncomingCallProvider → IncomingCallDialog` and `DirectDesktopUpdatePrompt → Dialog` are providers rendering product UI; that composition belongs in `layouts/`. |
| `components → pages` (4) | **deny** | Three are type-only (page-hook return shapes) and one is a value (`describeSessionDevice`). Move the shared types into the feature directory and the presentation helper into `components/features/settings/`. |
| `components/shared → components/features` (4) | **deny; move the component** | `AgentVisibilityPill` and `agent-scope` have three shared consumers; that makes them shared. |
| `hooks → components/features` (1) | **deny; move the constant** | `useSidePanelGeometry.ts` reads `THREAD_PANEL_MIN_WIDTH` from `thread-panel-helpers`. Move the constant into the hook. |
| `components/kanban → components/features/knowledge/file-icons` (1) | **deny; move to shared** | `iconForFilename` is a pure lookup with two feature consumers. |

### Enforcement: a script, not eslint

**Recommendation: `scripts/lint-admin-layers.mjs`**, wired into the root `lint` chain beside the other four, with a `pnpm lint:admin-layers` alias.

Why not `no-restricted-imports`:

1. eslint expresses a per-file exception only as `ignores:`, and the repo's own config says so — `eslint.config.js:320-324`: "*An allowlisted file is exempt **as a whole**, so an entry that has shrunk to zero real offenses must leave the list in the same change …*". Seeding 52 exceptions that way would exempt 40-odd files from every other rule in whichever block they sit in.
2. The config header at `eslint.config.js:6-9` already warns that two matching config objects both setting a rule means the later wins — layering blocks scoped per directory would collide with the four existing `admin/src` `no-restricted-syntax` blocks.
3. A glob pattern cannot classify `'../../../../facades/designer/tool-catalog'` reliably; a script resolves the specifier against the importing file's directory and classifies both ends by real path. `lint-layers.mjs` and `lint-navigation-surfaces.mjs` are the established idiom for exactly this.

```js
#!/usr/bin/env node

// Layer-direction gate (docs/provider-system-and-frontend-architecture.md §5.3):
// admin/src is ten ordered layers, and an import may only run downward.
// Modelled on scripts/lint-layers.mjs — same shape, same shrinking-allowlist
// contract: every entry below is a real offender at the time this gate landed.
// Delete a line the moment its edge is inverted; never add one back.

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const SCAN_ROOT = 'admin/src'

// Longest-prefix wins, so 'components/shared' beats 'components'.
const LAYERS = [
  ['lib',                   ['lib']],
  ['hooks',                 ['lib', 'hooks']],
  ['navigation',            ['lib', 'hooks', 'providers', 'navigation']],
  ['facades',               ['lib', 'hooks', 'providers', 'facades']],
  ['providers',             ['lib', 'hooks', 'facades', 'navigation', 'components/overlays', 'providers']],
  ['components/primitives', ['lib', 'components/primitives']],
  ['components/overlays',   ['lib', 'hooks', 'navigation', 'components/primitives', 'components/overlays']],
  ['components/shared',     ['lib', 'hooks', 'navigation', 'facades', 'providers',
                             'components/primitives', 'components/overlays', 'components/shared']],
  ['components',            ['*']],   // features, kanban, desktop
  ['layouts',               ['*']],
  ['pages',                 ['*']],
  ['',                      ['*']],   // router.tsx, main.tsx, styles
]

// Edges that are correct despite running upward, each with its reason.
// A named exception, never a general edge (docs/navigation/content-and-drafts.md §14).
const EXCEPTIONS = new Map([
  ['admin/src/navigation/prewarm.ts', ['facades']],
])

const layerOf = (rel) => {
  let best = ''
  for (const [layer] of LAYERS) {
    if (layer && rel.startsWith(`${layer}/`) && layer.length > best.length) best = layer
  }
  return best
}
const allowedFrom = (layer) => LAYERS.find(([name]) => name === layer)?.[1] ?? ['*']

const IMPORT = /(?:^|\n)\s*(?:import|export)(?:\s+type)?\s[^'"\n]*from\s+'(\.[^']*)'/g

function trackedFiles() {
  return execSync(`git ls-files '${SCAN_ROOT}/*.ts' '${SCAN_ROOT}/*.tsx'`, { encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter(Boolean)
}

const violations = []
let scanned = 0

for (const file of trackedFiles()) {
  scanned += 1
  const rel = file.slice(`${SCAN_ROOT}/`.length)
  const from = layerOf(rel)
  const allowed = allowedFrom(from)
  const extra = EXCEPTIONS.get(file) ?? []
  const content = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8')
  IMPORT.lastIndex = 0
  let match
  while ((match = IMPORT.exec(content))) {
    const targetRel = path.posix.normalize(path.posix.join(path.posix.dirname(rel), match[1]))
    if (targetRel.startsWith('..')) continue                       // outside admin/src
    const to = layerOf(targetRel)
    if (to === from) continue
    if (allowed.includes('*') || allowed.includes(to) || extra.includes(to)) continue
    const edge = `${file} -> ${SCAN_ROOT}/${targetRel}`
    if (ALLOWLIST.has(edge)) continue
    violations.push(`${edge}   (${from || 'root'} may not import ${to || 'root'})`)
  }
}

if (violations.length > 0) {
  console.error([
    'admin/src imports must run downward through the layer order.',
    'See docs/provider-system-and-frontend-architecture.md §5.3 and the LAYERS table above.',
    'Invert the dependency (move the shared symbol down) rather than allowlisting a new edge.',
    '',
    ...violations,
  ].join('\n'))
  process.exit(1)
}

console.log(`lint-admin-layers: ${scanned} files clean (${ALLOWLIST.size} allowlisted edges)`)
```

Wire it as `"lint:admin-layers": "node scripts/lint-admin-layers.mjs"` and insert `&& node scripts/lint-admin-layers.mjs` into the root `"lint"` chain (`package.json:13`) after `lint-layers`.

One eslint change is still worth making, independently: delete the four redundant `paths` entries at `eslint.config.js:150-176` — the `patterns: [{ group: ['**/hooks/useMediaQuery'] }]` entry beneath them already matches every relative depth, and the four `../`-spellings only exist because there is no alias.

## Appendix 3 — seed allowlist (today's 60 offending edges)

Paste as the `ALLOWLIST` `Set` in `scripts/lint-admin-layers.mjs`. Grouped by the move that deletes the group.

```js
const ALLOWLIST = new Set([
  // (a) Navigation modules filed under layouts/admin-shell. Deleted by moving
  //     local-back/, phone-navigation*.ts, nav-items.ts, PhoneBackButton.tsx
  //     and PhoneNavigationButton.tsx into admin/src/navigation/.  [21 edges]
  'admin/src/navigation/back.ts -> admin/src/layouts/admin-shell/local-back/local-back-registry',
  'admin/src/navigation/back.ts -> admin/src/layouts/admin-shell/phone-navigation-ledger',
  'admin/src/navigation/back.ts -> admin/src/layouts/admin-shell/phone-navigation',
  'admin/src/navigation/history.ts -> admin/src/layouts/admin-shell/phone-navigation-ledger',
  'admin/src/navigation/history.ts -> admin/src/layouts/admin-shell/nav-items',
  'admin/src/navigation/NestedStage.tsx -> admin/src/layouts/admin-shell/local-back/LocalBackContext',
  'admin/src/components/overlays/useOverlay.ts -> admin/src/layouts/admin-shell/local-back/LocalBackContext',
  'admin/src/components/overlays/Sheet.tsx -> admin/src/layouts/admin-shell/phone-navigation-gesture',
  'admin/src/components/overlays/sheet-swipe.ts -> admin/src/layouts/admin-shell/phone-navigation-gesture',
  'admin/src/components/shared/ScreenHeader.tsx -> admin/src/layouts/admin-shell/PhoneBackButton',
  'admin/src/components/shared/ScreenHeader.tsx -> admin/src/layouts/admin-shell/PhoneNavigationButton',
  'admin/src/components/shared/ResponsivePageHeader.tsx -> admin/src/layouts/admin-shell/PhoneBackButton',
  'admin/src/components/shared/column-browser/ColumnBrowserColumn.tsx -> admin/src/layouts/admin-shell/PhoneBackButton',
  'admin/src/components/shared/column-browser/ColumnBrowserColumn.tsx -> admin/src/layouts/admin-shell/PhoneNavigationButton',
  'admin/src/components/shared/column-browser/ColumnBrowserColumn.tsx -> admin/src/layouts/admin-shell/local-back/LocalBackContext',
  'admin/src/components/shared/column-browser/ColumnBrowserViewport.tsx -> admin/src/layouts/admin-shell/local-back/LocalBackContext',
  'admin/src/components/features/channels/ConversationInfoFlow.tsx -> admin/src/layouts/admin-shell/PhoneNavigationButton',
  'admin/src/components/features/channels/thread-panel/ThreadReplyPanel.tsx -> admin/src/layouts/admin-shell/PhoneBackButton',
  'admin/src/components/features/browser-cloud/AgentScreenPanel.tsx -> admin/src/layouts/admin-shell/PhoneBackButton',
  'admin/src/components/features/dashboards/DashboardWorkspacePanel.tsx -> admin/src/layouts/admin-shell/PhoneBackButton',
  'admin/src/components/features/knowledge/KnowledgeWorkspace.tsx -> admin/src/layouts/admin-shell/local-back/LocalBackContext',

  // (b) useIsOwner. Deleted by moving isOwnerSession/useIsOwner from
  //     components/shared/OwnerGate.tsx into facades/auth/.  [5 edges]
  'admin/src/facades/apps/agent-access-hooks.ts -> admin/src/components/shared/OwnerGate',
  'admin/src/facades/integrations/hooks.ts -> admin/src/components/shared/OwnerGate',
  'admin/src/facades/projects/administration.ts -> admin/src/components/shared/OwnerGate',
  'admin/src/facades/search/hooks.ts -> admin/src/components/shared/OwnerGate',
  'admin/src/facades/tool-grants/hooks.ts -> admin/src/components/shared/OwnerGate',

  // (c) Non-React app-connect logic filed under components/features/apps.
  //     Deleted by moving the three modules into facades/apps/.  [3 edges]
  'admin/src/facades/apps/connect-hooks.ts -> admin/src/components/features/apps/connect-error-copy',
  'admin/src/facades/apps/connect-hooks.ts -> admin/src/components/features/apps/connect-flow',
  'admin/src/facades/apps/connect-hooks.ts -> admin/src/components/features/apps/external-auth-launcher',

  // (d) AgentVisibilityPill / agent-scope. Deleted by moving both into
  //     components/shared/.  [4 edges]
  'admin/src/components/shared/AssigneePicker.tsx -> admin/src/components/features/agents/AgentVisibilityPill',
  'admin/src/components/shared/MentionInput.tsx -> admin/src/components/features/agents/AgentVisibilityPill',
  'admin/src/components/shared/channel-members/MemberAgentRow.tsx -> admin/src/components/features/agents/AgentVisibilityPill',
  'admin/src/components/shared/channel-members/MemberAgentRow.tsx -> admin/src/components/features/agents/agent-scope',

  // (e) Facade contracts declared in their consumer. Deleted by declaring the
  //     types in facades/{designer,messages}/types.ts.  [4 edges]
  'admin/src/facades/designer/hooks.ts -> admin/src/components/features/agents/designer/useAgentDesigner',
  'admin/src/facades/designer/hooks.ts -> admin/src/components/features/agents/designer/DesignerAssistantPanelContext',
  'admin/src/facades/designer/agent-designer-identity.ts -> admin/src/components/features/agents/designer/useAgentDesigner',
  'admin/src/facades/messages/hooks.ts -> admin/src/components/shared/MentionInput',

  // (f) components -> pages. Three are type-only page-hook return shapes; the
  //     fourth is a presentation helper filed under pages/.  [4 edges]
  'admin/src/components/features/channels/thread-panel/ThreadReplyPanel.tsx -> admin/src/pages/channels/useReplyThread',
  'admin/src/components/features/settings/ActiveSessionsTable.tsx -> admin/src/pages/settings/session-device',
  'admin/src/components/features/triggers/TriggerListColumn.tsx -> admin/src/pages/triggers/useTriggersPageState',
  'admin/src/components/features/workflow-designer/WorkflowDesignerHeader.tsx -> admin/src/pages/workflow-designer/useWorkflowTestRun',

  // (g) SidebarRow. Deleted by moving it to components/shared/.  [3 edges]
  'admin/src/components/features/knowledge/KnowledgeSidebarPageTree.tsx -> admin/src/layouts/admin-shell/SidebarRow',
  'admin/src/components/features/knowledge/KnowledgeSpaceList.tsx -> admin/src/layouts/admin-shell/SidebarRow',
  'admin/src/components/features/personal-assistant/PersonalAssistantSurface.tsx -> admin/src/layouts/admin-shell/SidebarRow',

  // (h) lib reaching upward.  [6 edges]
  'admin/src/lib/external-auth.ts -> admin/src/providers/ThemeProvider',
  'admin/src/lib/external-auth-completion.ts -> admin/src/providers/external-auth-callback',
  'admin/src/lib/pkce.ts -> admin/src/providers/ThemeProvider',
  'admin/src/lib/avatar.ts -> admin/src/components/primitives/identity-shape',
  'admin/src/lib/mobile-shell.ts -> admin/src/hooks/useViewport',
  'admin/src/lib/mobile-shell.ts -> admin/src/navigation/layout',

  // (i) primitives reaching upward.  [2 edges]
  'admin/src/components/primitives/AvatarBadges.tsx -> admin/src/providers/PresenceProvider',
  'admin/src/components/primitives/TabBar.tsx -> admin/src/components/overlays/Popover',

  // (j) providers rendering product UI (the two viewport mounts are allowed by
  //     the graph, not listed here).  [4 edges]
  'admin/src/providers/AgentIdentityProvider.tsx -> admin/src/components/shared/agent-identity',
  'admin/src/providers/DirectDesktopUpdatePrompt.tsx -> admin/src/components/shared/Dialog',
  'admin/src/providers/IncomingCallProvider.tsx -> admin/src/components/shared/IncomingCallDialog',
  'admin/src/providers/AppProvider.tsx -> admin/src/router',

  // (k) singletons.  [4 edges]
  'admin/src/components/shared/ResponsivePageHeader.tsx -> admin/src/layouts/admin-shell/AccountMenuContext',
  'admin/src/hooks/useSidePanelGeometry.ts -> admin/src/components/features/channels/thread-panel/thread-panel-helpers',
  'admin/src/components/kanban/TaskDocuments.tsx -> admin/src/components/features/knowledge/file-icons',
  'admin/src/components/desktop/DesktopWindowFrame.tsx -> admin/src/layouts/admin-shell/DesktopWindowControls',
])
```

Groups (a)–(d) are 33 of the 60 edges and are four mechanical file moves. Landing the lint with the full seed first means the tree is green from day one and the list can only shrink.
