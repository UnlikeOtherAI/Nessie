# The 500-line file cap and cohesive split seams

## Verdict

All 14 files over the cap were read in full. None is a case where the cap is
wrong — every one has at least one real, nameable domain seam, and in most
cases (10 of 14) part of the split has already happened: a sibling file with
the missing piece already exists (`useAccessTokenRenewal.ts`,
`facades/knowledge/hooks.ts`, `nav-items.tsx`, `SidebarDialogs.tsx`,
`mention-input-agents.ts`, `voice-audio.ts`, etc.), and the file over the cap
is either the last un-split remainder or a second, independently-grown
instance of a pattern that already has a name elsewhere. Two files
(`voice-call-client.ts`, `ChannelsPage.tsx`) are genuinely hard to shrink
further without a design decision, because their size comes from one
irreducible stateful controller / composition root rather than from
undifferentiated bulk. `lib/query-keys.ts` is not entangled at all — it is
already organized by domain, one `const` per domain — so splitting it is pure
line-count arithmetic across many files, which is exactly why the S1 reviewer
should decide the target shape before anyone moves code.

## Findings

### F1. `layouts/admin-shell/AdminSidebarNav.tsx` (599) — static nav data crowds out the component

- Severity: medium
- Category: structure
- Evidence: `layouts/admin-shell/AdminSidebarNav.tsx:97-437` is the `ADMIN_NAV`
  declarative table (6 groups, ~20 items, each with an inline `icon(...)` SVG)
  plus the `icon` helper (`:91-95`) and the `AdminNavItem`/`AdminNavGroup`/
  `AdminNavViewer` types (`:14-89`). Component logic — `isAdminNavItemVisible`
  /`isAdminNavGroupVisible`/`isAdminNavItemActive` (`:442-460`),
  `AdminNavSection` (`:470-516`), and `AdminSidebarNav` itself (`:518-599`) —
  is only ~180 lines.
- Why it matters: the file's size is 100% static configuration, not logic; a
  reviewer has to scroll past 340 lines of SVG paths to find the one
  component that actually renders. The repo already has the exact right
  pattern for this: `layouts/admin-shell/nav-items.tsx` holds the *top-level*
  rail's `NAV_ITEMS` table (channels/projects/knowledge/admin/search) as a
  sibling data file to whatever consumes it — `AdminSidebarNav.tsx` just never
  got the same treatment for its own sub-nav.
- Fix: move `AdminNavItem`, `AdminNavGroup`, `AdminNavGroupId`, `icon`, and
  `ADMIN_NAV` into a new `layouts/admin-shell/admin-nav-items.tsx` (must stay
  `.tsx`: `icon()` returns JSX). `AdminSidebarNav.tsx` imports `ADMIN_NAV` and
  the two types back. Optionally also move the three pure predicates
  (`isAdminNavItemVisible`/`isAdminNavGroupVisible`/`isAdminNavItemActive`)
  alongside the data, since they operate on it. Result: `admin-nav-items.tsx`
  ~350 lines of data, `AdminSidebarNav.tsx` ~250 lines of component.
- Fix size: S — pure code motion, no behavior change, no new interface.
- Risk: none beyond import paths; `AdminNavViewer` (the exported type other
  files may import) should stay re-exported from `AdminSidebarNav.tsx` or be
  moved with clear re-export to avoid breaking `import type { AdminNavViewer }
  from '.../AdminSidebarNav'` call sites — grep before moving.

### F2. `components/features/channels/ChannelMessageFeed.tsx` (506) — visibility bookkeeping and the live-stream tail can leave the row renderer

- Severity: low
- Category: structure
- Evidence: the component already delegates rows to `ChannelMessageRow`
  (`:386-418`), reactions to `useResolveReactorName`, attachments to
  `useAttachmentViewer`, and two dialogs to `useDocumentStreamDialog`/
  `useThoughtProcessDialog` — the file is the thinnest of the fourteen
  relative to its responsibility. What's left and separable: the
  date-collapse state and `visibleFeedItems` filter (`:268-299`, pure, no JSX)
  and the "Live" bottom-pending-entries block (`:235-241` logic + `:437-477`
  JSX), which renders `ThinkingBubble`/`StreamingMessageRow` for in-flight
  runs independent of everything above it.
- Why it matters: at 506 lines this is the smallest overage and closest to
  healthy; the two extractions below are the difference between "just over"
  and comfortably under, with no coupling cost.
- Fix: move `collapsedDateKeys`/`visibleFeedItems`/`toggleDateKey`
  (`:268-299`) into a small hook `useCollapsedFeedDates(feedItems)` in
  `components/features/channels/useCollapsedFeedDates.ts`, returning
  `{ visibleFeedItems, collapsedDateKeys, toggleDateKey }`. Move the "Live"
  separator + `bottomPendingEntries.map(...)` block (`:437-477`) plus
  `bottomPendingEntries` (`:235-241`) into a new
  `components/features/channels/ChannelLiveStreamTail.tsx` taking
  `pendingMessages`, `thinkingSurface`, `resolveAgentIdentity`,
  `renderContent`, `token`, `isDedicatedAgentConversation` as props.
- Fix size: S.
- Risk: `renderThinkingBubble` closes over `openThoughtProcess`/`token` —
  pass it down as a prop or reconstruct it in the new component from the same
  inputs; either way no behavior change. Existing feed snapshot/interaction
  tests should catch a wiring mistake.

### F3. `components/shared/MentionInput.tsx` (541) — DOM-range helpers and the suggestion popup are separable from the contentEditable controller

- Severity: low
- Category: structure
- Evidence: pure, non-hook helper functions `clearChildren`,
  `getLastTextNode`, `getSelectionTextNode`, `getMentionContext`,
  `matchesEntityQuery` (`:77-150`, `:185-189`) touch only `Node`/`Range`/
  `Selection` and have zero dependency on component state. `MentionEntityAvatar`
  (`:157-183`) is a fully self-contained subcomponent. The suggestion-list JSX
  (`:394-436`) is a third distinct block. The remaining `MentionInput` render
  function (`:195-539`) is the genuinely irreducible part: one
  `contentEditable` div, one `ref`, and the imperative handle that has to see
  all of it.
- Why it matters: the file already reuses `decorateMarkdownEditor`/
  `extractEditorText`/`insertMarkdownEditorText` from `lib/markdown-editor`
  and `readAgentMentions` from `./mention-input-agents` — the DOM-range math
  is the one piece that never got the same treatment despite being equally
  self-contained.
- Fix: move the five pure functions to
  `components/shared/mention-input-dom.ts` (exports: `getMentionContext`,
  `matchesEntityQuery`, plus the two node-walking helpers as needed
  internally). Move `MentionEntityAvatar` to
  `components/shared/MentionEntityAvatar.tsx`. Move the suggestion popup JSX
  (`:394-436`) into `components/shared/MentionSuggestionList.tsx`, taking
  `filtered`, `selectedIdx`, `onHover`, `onPick` as props.
- Fix size: S.
- Risk: `getMentionContext`/`matchesEntityQuery` are called from both the
  imperative handlers and the render body — keep them as named exports, not
  a default export, so both call sites stay simple imports. No test changes
  needed if signatures are preserved verbatim.

### F4. `pages/settings/NotificationsPage.tsx` (508) — an already-isolated section just needs its own file

- Severity: low
- Category: structure
- Evidence: `BrowserNotificationsSection` (`:96-193`) is already written as a
  fully self-contained component with its own state, effect, and submit
  handler — it takes no props and reads only its own hooks
  (`useWebPushConfig`, `useSubscribeWebPush`, `useUnsubscribeWebPush`). It
  simply lives in the same file as `NotificationsPage` instead of beside it.
  The remaining `NotificationsPage` body owns three concerns: preferences
  hydration/save (`:204-244`, `:255-294`), the quiet-hours block (`:388-445`),
  and the muted-channels list (`:296-315`, `:452-504`).
- Why it matters: this is the cheapest win in the batch — the seam is already
  drawn, it just isn't a file boundary yet.
- Fix: move `BrowserNotificationsSection` verbatim to
  `pages/settings/BrowserNotificationsSection.tsx`. Optionally also extract
  the quiet-hours fieldset (`:388-445`) into
  `pages/settings/QuietHoursCard.tsx` (props: the six quiet-hours state
  values + setters + `timeZoneOptions` + `disabled`), following the same
  pattern as the already-extracted `PushPreferenceCard` used at `:365-386`.
- Fix size: S.
- Risk: none for the `BrowserNotificationsSection` move (zero shared state
  with the page). The `QuietHoursCard` extraction needs ~10 props threaded
  through — mechanical, same shape as `PushPreferenceCard` already sitting in
  `notification-preference-controls.tsx` one import away.

### F5. `layouts/admin-shell/ProjectsSidebarNav.tsx` (675, largest) — near-duplicate of `SidebarProjectsSection.tsx` inside one file, not yet reused

- Severity: medium
- Category: reuse | structure
- Evidence: `ProjectSectionRows` (`:104-250`, ~150 lines) is already a
  self-contained subcomponent rendering one project's sections/boards list.
  `renderProjectRow` (`:420-576`, ~155 lines) is a closure, not a component,
  doing project-row JSX + the portal-based "⋯" action menu
  (`:490-555`). The cookie-parsing trio `parseExpandedProjectIds`/
  `retainExpandedProjectIds`/`serializeExpandedProjectIds` (`:58-79`) is pure.
  The four dialogs (`CreateProjectDialog`/`BoardCreateDialog`/
  `EditProjectDialog`/`ConfirmDialog`, `:637-673`) are one JSX block.
  Comparing against `layouts/admin-shell/SidebarProjectsSection.tsx` (398
  lines, read in full): it is the *other* sidebar's projects list (used
  inside `SidebarNav.tsx` for the channels/DM shell) and independently
  re-implements the same four things — cookie-backed expand/collapse
  (`SidebarProjectsSection.tsx:29-67`, note the *inverted* cookie semantics:
  `COLLAPSED_PROJECT_IDS_COOKIE` stores what's closed, while
  `ProjectsSidebarNav.tsx` stores `EXPANDED_PROJECT_IDS_COOKIE` — what's
  open), the identical portal action-menu positioning
  (`SidebarProjectsSection.tsx:165-180`, `299-347`), and a near-identical
  project-row JSX shape (avatar + name + chevron + star + "⋯"). They do
  **not** overlap in rendering (one shows project sections + boards routed by
  React Router `Link`s for the agents/admin shell; the other shows project
  channels via callback props for the channels shell), so this is not a
  redundant file to delete — but it is the same UI pattern written twice at
  full size instead of once as a shared primitive.
- Why it matters: at 675 lines this is the single largest file in the app,
  and roughly a third of it (the menu-positioning boilerplate and the
  cookie-set bookkeeping) is logic that already exists, word-for-word, in
  `SidebarProjectsSection.tsx`. Fixing only the split-seam without touching
  the duplication would still leave two ~250-line files carrying the same
  menu-positioning bug surface twice.
- Fix: (1) extract `ProjectSectionRows` to
  `layouts/admin-shell/ProjectSectionRows.tsx` (exports `ProjectSectionRows`;
  imported only by `ProjectsSidebarNav.tsx`) — pure move. (2) extract
  `renderProjectRow`'s body into `layouts/admin-shell/ProjectRow.tsx` (props:
  `project`, `listId`, `isOwner`, `isStarred`, `isExpanded`, `isActive`,
  `currentSectionId`, callbacks) — the menu-open state (`menuRowId`/
  `menuPosition`/`menuButtonRefs`) currently lives in the parent and would
  need to either move down into `ProjectRow` (one row owns its own menu) or
  stay lifted and be passed down; moving it down is the cleaner boundary and
  matches how each row already tracks its own `isMenuOpen`. (3) move the
  cookie-parsing trio to `layouts/admin-shell/projects-nav-expansion.ts`
  (already-exported pure functions, likely used by tests — grep before
  moving). (4) move the four dialogs into
  `layouts/admin-shell/ProjectsNavDialogs.tsx`, mirroring the existing
  `SidebarDialogs.tsx` file in the same directory, which is the identical
  pattern for the channels-shell sidebar's dialogs. (5) separately from this
  cap fix: factor the portal action-menu positioning (getBoundingClientRect +
  keydown/scroll/resize close-on-outside-change, duplicated at
  `ProjectsSidebarNav.tsx:374-403` and `SidebarProjectsSection.tsx:165-180`)
  into one `useSidebarRowMenu()` hook shared by both files — this is the real
  fix for the duplication, filed separately since it touches both files'
  logic, not just line count.
- Fix size: M — (1)/(3)/(4) are S-sized pure moves; (2) is a small interface
  change (menu state relocates); the shared-hook dedup in (5) is a second,
  separate M-sized change touching both this file and
  `SidebarProjectsSection.tsx`.
- Risk: moving menu-open state into `ProjectRow` changes when
  `menuButtonRefs` entries are created/destroyed — verify the
  Escape/scroll/resize-closes-menu behavior still works per-row rather than
  globally. Existing sidebar interaction tests (if any) should cover this;
  otherwise smoke-test the "⋯" menu manually.

### F6. `pages/settings/StatusesPage.tsx` (589) — three independent forms share one state block

- Severity: medium
- Category: structure | state
- Evidence: 24 `useState` hooks declared together (`:70-93`) back three
  unrelated forms rendered as three `Card`s: status create/detail
  (`:230-268`, `:270-340`), schedules (`:342-454`), and contact rules
  (`:456-570`). Each has its own submit handler
  (`createStatusSubmit`/`saveStatusSubmit`/`scheduleSubmit`/`ruleSubmit`,
  `:119-203`) that touches only its own state slice and one mutation. The
  only shared value across all three is `selectedStatus`.
- Why it matters: a change to the schedule form's fields currently requires
  scrolling past the rule form's 6 state variables and the detail form's 5 to
  find them; the three forms have no data dependency on each other beyond
  the parent status.
- Fix: extract `StatusScheduleForm` (state: `scheduleKind`/`scheduleLabel`/
  `startsAt`/`endsAt`/`dayOfWeek`/`startTime`/`endTime`/`timezone`/
  `scheduleError`, the `scheduleSubmit` handler, and the schedules `RowList`,
  `:342-454`) into `pages/settings/statuses/StatusScheduleForm.tsx`, props
  `{ selectedStatus, createSchedule, deleteSchedule }`. Extract
  `StatusRuleForm` (state: `ruleScope`/`ruleChannelId`/`ruleProjectId`/
  `ruleAgentId`/`ruleAgentEnabled`/`ruleInstructions`/`ruleError`, `ruleSubmit`,
  `:456-570`) into `pages/settings/statuses/StatusRuleForm.tsx`, props
  `{ selectedStatus, channels, projects, agents, createRule, deleteRule }`.
  Leave the status list + detail form (create/edit/delete) in
  `StatusesPage.tsx`, which drops to roughly 300 lines.
- Fix size: M — each extraction moves ~10 `useState` hooks and their submit
  handler down into a new component; this is an interface change (props
  replace closure access) but entirely mechanical, no logic changes.
- Risk: the "seed once per selected status" effect (`:111-117`) only resets
  the detail form's fields today; verify the two new components manage their
  own reset-on-`selectedStatus.id`-change semantics for schedule/rule inputs
  (they currently have none — schedule/rule inputs are already always blank
  between statuses since they're "add new" forms, not edit forms, so this is
  low risk). Existing settings e2e tests for statuses should catch a
  regression.

### F7. `pages/WorkflowsPage.tsx` (568) — two of five drill-down columns are dense enough to be their own files

- Severity: low
- Category: structure
- Evidence: the failed-runs `ColumnBrowserColumn` (`:244-305`) and the main
  workflows list column (`:323-471`, including the "What failed?"/
  "Demonstration drafts" toggle rows and the search input) are each
  self-contained JSX blocks reading only page-level state passed as
  arguments, exactly like the already-separate
  `WorkflowInstallationDetail`/`WorkflowRunDetail`/`WorkflowTemplateDetail`
  components used at `:481`, `:529`, `:550`.
- Why it matters: the file is a `ColumnBrowserViewport` composing five
  columns (`:242-553`); three of the five already delegate to a named
  component and two do not, for no evident reason — they're just as
  separable.
- Fix: extract the failed-runs column (`:244-305`) into
  `components/features/workflows/WorkflowFailedRunsColumn.tsx` (props:
  `failedRunsList`, `failedRuns`, `onBack`, `onSelectRun`). Extract the main
  list column (`:323-471`) into
  `components/features/workflows/WorkflowsListColumn.tsx` (props:
  `isWorkflowAdmin`, `templatesList`, `sortedTemplates`, `filteredTemplates`,
  `searchQuery`, `setSearchQuery`, `selectedTemplate`, `onSelectTemplate`,
  `onImported`, `currentWorkflowLocationState`, navigate callback).
- Fix size: S — same shape as the three columns already extracted; no new
  state, only prop threading.
- Risk: low; the column-browser pattern (`activeColumn` index at `:555-561`)
  is unaffected since columns remain JSX elements pushed into the same array.

### F8. `components/shared/ResponsivePageHeader.tsx` (547) — the overflow-measurement engine is a self-contained hook wearing the component's clothes

- Severity: medium
- Category: structure
- Evidence: `visibleIds`/`overflowIds`/`openMenu` state, all the refs
  (`headerRef`, `measurementRef`, `leadingMeasureRef`, `actionMeasureRefs`,
  `moreMeasureRef`, `triggerRefs`, `anchorRefs`), the `anchorRefFor` helper,
  the `useLayoutEffect` that measures and calls
  `partitionPageHeaderActions` (`:228-283`, delegating to the already-split
  `responsive-page-header-layout.ts`), the two focus-management `useEffect`s
  (`:289-302`), and the menu keyboard/open/close handlers
  (`:304-339`) together are ~150 lines of state machine that produces exactly
  three values consumed by render: `visibleActions`, `overflowActions`,
  `openMenu`/`closeMenu`/`toggleMenu`/`handleMenuKeys`. The render body
  proper (`:409-547`) and `renderAction`/`actionClassName`/`toggleClassName`
  (`:155-178`, `:340-407`) are a second, presentational half.
- Why it matters: the measurement engine has zero JSX of its own — it is a
  custom hook that happens to be typed inline in the component, which is why
  the file reads as one 547-line block instead of "a hook + a renderer."
- Fix: extract into
  `components/shared/useResponsivePageHeaderOverflow.ts`, a hook taking
  `{ actions, onBack, showHeaderAccountMenu }` and returning
  `{ headerRef, measurementRef, leadingMeasureRef, actionMeasureRefs,
  moreMeasureRef, triggerRefs, anchorRefFor, visibleActions, overflowActions,
  openMenu, closeMenu, toggleMenu, handleMenuKeys, selectMenuItem,
  menuIdPrefix }`. `ResponsivePageHeader.tsx` keeps `actionClassName`/
  `toggleClassName`/`renderAction` and the JSX, now ~380 lines.
- Fix size: M — many refs cross the boundary, which is an interface change
  (a hook return object with ~13 fields) even though no logic changes; worth
  doing as one careful pass rather than S-sized because a missed ref breaks
  the overflow measurement silently (wrong widths, not a crash).
- Risk: the effect closes over `actions`/`onBack`/`showHeaderAccountMenu` from
  the enclosing scope (`:283`) — confirm the extracted hook's dependency
  array is identical after the move. This component has no visible unit
  test; verify by hand on a narrow viewport that overflow still collapses
  into "More" correctly (docs/navigation/overview.md's header contract).

### F9. `components/features/knowledge/KnowledgeProvider.tsx` (511) — navigation state and CRUD wrapping are two hooks pretending to be one provider

- Severity: medium
- Category: state | structure
- Evidence: the query/mutation wiring (`:169-199`) correctly delegates to
  `facades/knowledge/hooks.ts` (316 lines, read in full — a clean TanStack
  Query facade with no UI state, no overlap with the provider). What remains
  inside the provider is two distinct concerns bundled into one component:
  (a) a **drill-path navigation state machine** — `selectedSpaceId`/
  `pagePath`/`openPageId`/`editor`/`historyPageId`/`spaceSettingsOpen`/
  `activeProductView` (`:180-186`) plus every setter that resets several of
  them together (`selectSpace`/`selectProductView`/`browseTo`/`openPagePath`/
  `openRootPage`/`openPageDeepLink`/`drillTo`/`popTo`/`openCreate`/`openEdit`/
  `closeEditor`, `:276-386`), and (b) **CRUD wrappers** that call a facade
  mutation and then reset a slice of that same navigation state
  (`createSpace`/`updateSpace`/`savePage`/`createFolder`/`publishPage`/
  `archivePage`/`restoreVersion`, `:296-443`).
- Why it matters: `facades/knowledge/*` is the correctly-layered data facade
  (per `docs/provider-system-and-frontend-architecture.md` §4/§5) and should
  not be touched; the cap breach is entirely in the UI-state layer above it,
  which grew two unrelated responsibilities (navigation vs. mutation
  side-effects) into one file because both happen to read/write the same
  `pagePath`/`openPageId`/`editor` fields.
- Fix: extract the navigation slice into
  `components/features/knowledge/useKnowledgeNavigation.ts` — a hook owning
  the seven state values and the ten navigation setters, returning them as an
  object. Extract the CRUD wrappers into
  `components/features/knowledge/useKnowledgeMutations.ts`, which takes the
  navigation hook's setters as input (since e.g. `savePage` must call
  `setPagePath`/`setOpenPageId`/`setEditor` on success) and returns
  `{ createSpace, updateSpace, savePage, createFolder, publishPage,
  archivePage, restoreVersion, ...Pending flags }`. `KnowledgeProvider`
  becomes composition: call both hooks, merge into the context value.
- Fix size: M — the reset-multiple-fields-together pattern means the two
  hooks are not fully independent (mutations need navigation setters), so
  this needs one coordinated pass rather than two unrelated PRs, but no
  behavior changes and no public `useKnowledge()` contract changes.
- Risk: the `KnowledgeContextValue` shape (`:42-125`) must stay identical
  since every knowledge UI component consumes it — this is an internal
  refactor of the provider's implementation, not its exported surface.
  Sibling check requested by the brief: **not a problem** —
  `facades/knowledge/*` (7 files: `hooks.ts`, `backlinks-hooks.ts`,
  `comment-hooks.ts`, `file-hooks.ts`, `recent-pages-hooks.ts`,
  `task-docs-hooks.ts`, `wikilink-hooks.ts`) is the data layer and
  `KnowledgeProvider.tsx` is the UI-state layer; they don't overlap and the
  layering is exactly what the architecture doc asks for.

### F10. `providers/AuthSessionProvider.tsx` (597) — already split four ways; the remainder is still two separable concerns

- Severity: medium
- Category: structure | state
- Evidence: this file already delegates to four sibling files —
  `useAccessTokenRenewal.ts` (124 lines, read in full: token-renewal timer
  logic, called at `AuthSessionProvider.tsx:399-404`),
  `auth-session-query-reset.ts` (67 lines, read in full: tenant query-cache
  boundary, used at `:137-143`, `:55-65`), `terminal-session-logout.ts` (55
  lines, read in full: native-cleanup + logout sequencing, used at
  `:533-547`), and `ambient-refresh-gate-host.ts` (not read; imported at
  `:53`, used at `:210`) — so the file is the *last remainder*, not an
  unsplit monolith. What's left inside it: (a) core session state + the
  mutation-coordinator wiring that almost every method touches
  (`applySession`/`commitSessionClear`/`clearSession`/`clearImportedSession`/
  `sessionMutations`, `:107-243`), (b) `reconcileSession`/`refreshAccessToken`/
  `refreshSessionFor`/`refreshSession` (`:244-339`), (c) two mount-time
  effects — pageshow-triggered reconcile (`:341-353`) and the
  network-outage retry loop (`:355-397`) — that exist purely to call (b) and
  touch nothing else, and (d) three UOA-team-specific entry points —
  `recoveryExchange` (`:443-503`, 60 lines), `switchContext`/`switchUoaTeam`
  (`:505-523`) — that are self-contained given `tokenRef`/`meRef`/
  `sessionMutations`/`ambientRefreshGate`/`authApi`.
- Why it matters: this answers the brief's specific question — yes, the file
  is already partly split, and the cap breach persists because (c) and (d)
  are both separable but neither has been pulled out yet, while (a)/(b) are
  the genuinely irreducible core (nearly every value in the file is a
  `useCallback` closing over `tokenRef`/`meRef`/`sessionMutations`).
- Fix: extract (c) into `providers/useSessionRestoration.ts`, a hook taking
  `{ readSessionCredential, refreshSessionFor, ambientRefreshGate }` and
  owning both effects — pure move, no state crosses back out. Extract (d)
  into `providers/useTeamSessionRecovery.ts`, a hook taking
  `{ tokenRef, meRef, sessionMutations, ambientRefreshGate, authApi }` and
  returning `{ recoveryExchange, switchContext, switchUoaTeam }`. This
  removes roughly 140 lines, landing the provider around 460 lines.
- Fix size: M — both extractions need refs/coordinators passed in as
  parameters (an interface change, since today they're closure captures),
  but the logic itself moves verbatim; this is the same shape as the four
  extractions already done in this file, so it is low-novelty work.
- Risk: `recoveryExchange`'s `capturedSource` closure variable (`:457`) must
  stay lexically scoped to one call of the hook's returned function, not
  hoisted to hook-level state — a naive extraction that turns it into a
  `useRef` instead of a per-call `let` would reintroduce the exact
  cross-request race the comment at `:450-456` describes avoiding. Get a
  second pair of eyes on this one specifically.

### F11. `lib/workflow-designer/serialization.ts` (598) — three passes (analyze / save / load) share one hidden module-level singleton

- Severity: medium
- Category: structure | state
- Evidence: three cohesive groups: **(a) canvas structure analysis** —
  `readSerializedNode`, `WorkflowCanvasStructure`,
  `analyzeWorkflowCanvasStructure`, `getLinearWorkflowNodes`,
  `buildExecutableNodeConfig`, `readWorkflowStepConfig` (`:20-192`, pure,
  no shared state); **(b) save path** — `buildWorkflowGraph`,
  `WorkflowCanvasStructureError`, `WorkflowPreservedStep`,
  `buildWorkflowTriggers` (`:254-434`); **(c) load path** —
  `readWorkflowTemplateTriggers`, `ParsedWorkflowTemplate`,
  `parseWorkflowTemplate` (`:194-252`, `:436-598`). Groups (b) and (c) are
  connected by module-level mutable state — `currentLoadedStepOrder`/
  `currentLoadedStepOrderSet` (`:393-406`) — which `parseWorkflowTemplate`
  (load) writes via `setLoadedWorkflowStepOrder` (`:455`) and
  `buildWorkflowGraph` (save) reads via `currentLoadedStepOrderSet.has(...)`
  (`:296`, `:314`, `:380`) and `loadedCanvasIndex` (`:403-406`).
- Why it matters: this is the one file in the batch whose size comes with a
  genuine correctness caveat, not just bulk — the comment at `:388-392`
  states outright "module state is acceptable here because the designer
  edits exactly one template at a time," which is an assumption about the
  call site, not something the type system enforces. It is also why a
  three-way file split can't be a pure code-motion: (b) and (c) would import
  from a state module neither of them "owns."
- Fix: split into `lib/workflow-designer/canvas-structure.ts` (group a, no
  dependency on the other two), `lib/workflow-designer/template-parsing.ts`
  (group c), and `lib/workflow-designer/graph-serialization.ts` (group b).
  For the module state: the mechanical option is a fourth tiny module
  `lib/workflow-designer/loaded-step-order.ts` exporting
  `setLoadedWorkflowStepOrder`/`loadedCanvasIndex`/a `has` check, imported by
  both (b) and (c) — behavior-preserving, same singleton risk as today. The
  better option, worth flagging to whoever owns the workflow designer: change
  `buildWorkflowGraph`'s signature to accept `loadedStepOrder: string[]`
  explicitly (returned by `parseWorkflowTemplate` as part of
  `ParsedWorkflowTemplate`) instead of reading a module singleton — this
  closes the two-designer-instances-corrupt-each-other's-state risk as a side
  effect of the split.
- Fix size: M for the three-way file split with the state left as a
  singleton; L if bundled with removing the singleton (touches the
  designer's calling code wherever `buildWorkflowGraph`/`parseWorkflowTemplate`
  are invoked, which needs a search before scoping).
- Risk: `disconnectedNewNode` (`:294-302`) and the `allLoaded` fallback
  (`:311-320`) both depend on `currentLoadedStepOrderSet` reflecting the
  *currently open* template — any timing change (e.g., an accidental
  re-order of split-file initialization) would silently misclassify a
  disconnected node. Cover with the existing workflow-designer serialization
  tests before landing either version of the fix.

### F12. `pages/ChannelsPage.tsx` (615) — a composition root that is already maximally decomposed; the size is in the wiring, not the logic

- Severity: low
- Category: structure
- Evidence: the page already delegates to ~15 extracted hooks under
  `pages/channels/*` (`useChannelCall`, `useChannelTab`, `useChannelMentions`,
  `useReplyThread`, `useChannelMessageSearch`, `useAlertMessageHighlight`,
  `useThreadReadMarker`, `useReportChannelPushSurface`,
  `useChannelParticipants`, `useDeepWaterResearchLauncher`,
  `useExecutorRunLauncher`, `useChannelTitleFavorite`, `useChannelMentions`)
  plus `useChannelComposer`/`useChannelMessageActions` from
  `components/features/channels/*`, and renders exactly two consumer
  components, `ChannelConversationSurface` (`:414-517`) and
  `ChannelOverlays` (`:519-599`), each fed a ~30-40-key prop object. Lines
  `51-403` are hook orchestration; `404-615` is almost entirely those two
  prop-object literals.
- Why it matters: unlike the other 13 files, there is no undifferentiated
  block left to extract — every remaining line is either a hook call or a
  named field in a prop object for one of two already-separate components.
  Shrinking this further means changing what "wiring a channel screen" looks
  like, which is a design decision about `ChannelConversationSurface`'s and
  `ChannelOverlays`' own prop contracts, not a mechanical split of
  `ChannelsPage.tsx` alone.
- Fix: no mechanical fix recommended. If pursued, group related loose state
  before it reaches the two consumers — e.g. the voice/call cluster
  (`activeCall`, `callActionError`, `callActionPending`, `callStarting`,
  `callerDialogCall`, `onProviderCallButton`, `onCloseCallerDialog`,
  `onCloseStartCallFailure`, `onFinishCall`, `startCallFailureCode`,
  `voiceCall`, `voiceCapability`, `voiceCallSupported`, `voiceDialogOpen`,
  `onCallButton`, `:153-186`) is currently split between a hook
  (`useChannelCall`) and ~8 lines of ad hoc local state/derivation in the
  page — folding all of it into one `useChannelCallSurface` hook would remove
  the derivation lines from the page without changing what
  `ChannelConversationSurface`/`ChannelOverlays` receive. This only trims
  the page, though; it does not reduce the two consumers' prop-list size,
  which is the real driver of the wiring bulk.
- Fix size: L — any change that meaningfully shrinks this file changes the
  prop contract of `ChannelConversationSurface` and/or `ChannelOverlays`
  (both un-read in this pass, both likely large themselves), so it needs a
  plan, not a mechanical move.
- Risk: unassessed without reading the two consumer components; flag for
  whichever reviewer owns `components/features/channels/` structure broadly.

### F13. `lib/query-keys.ts` (596) — not entangled; a documentation task, not a refactor

- Severity: low
- Category: structure
- Evidence: the file is already organized as one `const` object per domain,
  in alphabetical order, with zero cross-domain logic — every export is
  either a plain key array or a small pure function building one. This is
  the opposite of the other 13 files: there is no undifferentiated bulk to
  find a seam in, only a decision about whether 40+ independent objects
  belong in one file or 40+ separate `keys.ts` files beside their facades.
- Why it matters / seam-by-domain (line ranges as read, for whichever
  decision the S1 reviewer makes):
  - `agentKeys`, `agentTodoKeys` (`:35-70`) → `facades/agents/keys.ts`
  - `alertKeys` (`:72-77`) → `facades/alerts/keys.ts`
  - `appKeys`, `appConnectionRequestKeys` (`:79-114`) → `facades/apps/keys.ts`
  - `agentCardKeys` (`:116-118`) → `facades/agents/keys.ts` (or its own; small)
  - `approvalKeys` (`:120-126`) → `facades/approvals/keys.ts`
  - `demonstrationKeys` (`:128-131`) → `facades/demonstrations/keys.ts`
  - `auditLogKeys` (`:133-135`) → an ops/audit facade (no dedicated facade dir
    seen; would need one or join `opsHealthKeys`)
  - `automaticMembershipKeys` (`:139-142`) → `facades/organization/keys.ts` or
    its own automatic-membership facade
  - `authKeys` (`:144-148`) → `facades/auth/keys.ts`
  - `billingKeys` (`:155-160`, roots only by the file's own header comment,
    `:30-32`) → stays partly in `facades/billing/hooks.ts` per existing
    convention; roots could join it fully
  - `budgetKeys` (`:162-164`) → `facades/budgets/keys.ts`
  - `callKeys` (`:166-169`) → `facades/voice/keys.ts` or a calls facade
  - `channelKeys` (`:171-175`) → `facades/channels/keys.ts`
  - `commsKeys` (`:177-181`) → `facades/comms` or `facades/integrations/keys.ts`
  - `dashboardKeys` (`:183-210`) → `facades/dashboards/keys.ts`
  - `executorKeys` (`:212-226`) → `facades/executors/keys.ts`
  - `favoriteKeys` (`:228-230`) → `facades/favorites/keys.ts`
  - `feedbackKeys` (`:232-234`) → `facades/feedback/keys.ts`
  - `iterationKeys` (`:236-239`) → `facades/projects/keys.ts` (iterations are
    project-scoped) or `facades/iterations/keys.ts`
  - `knowledgeKeys` (`:241-274`) → `facades/knowledge/keys.ts` (facade dir
    already exists — this is the most obvious single move)
  - `mcpKeys`, `mcpToolRegistryKey`, `toolPolicyTargetsKey*` (`:276-278`,
    `:327-356`) → `facades/integrations/keys.ts` (sits beside the
    `IntegrationQueryScope` type, `:286-298`)
  - `integrationManifestKey`, `integratedProductsKey*`,
    `deepWaterResearchRunsKey*`, `deepWaterAgentAccessKey*` (`:280-325`) →
    `facades/integrations/keys.ts`
  - `opsHealthKeys`, `opsTelemetryKeys` (`:358-371`) → `facades/ops/keys.ts`
  - `organizationKeys` + `organizationMembersKey` (`:373-395`) →
    `facades/organization/keys.ts`
  - `personalAssistantKeys` (`:397-399`) → `facades/personal-assistant/keys.ts`
  - `voiceKeys` (`:401-404`) → `facades/voice/keys.ts`
  - `platformPushKeys` (`:406-408`) → `facades/ops/keys.ts` (super-admin push
    credentials surface) or its own
  - `policyKeys` (`:410-412`) → `facades/policy/keys.ts` (or ops)
  - `presenceKeys` (`:414-416`) → belongs beside `providers/PresenceProvider`
    if that ever gets a facade, else stays central
  - `projectKeys`, `boardSourceKeys` (`:418-457`) → `facades/projects/keys.ts`,
    `facades/boards/keys.ts` (boards are their own connection concern per the
    file's own comment, `:446-450`)
  - `runKeys` (`:459-462`) → `facades/agents/keys.ts` (agent runs) — verify
    against actual facade usage before deciding
  - `searchKeys` (`:464-471`) → `facades/search/keys.ts`
  - `secretKeys` (`:473-475`) → `facades/secrets/keys.ts`
  - `statusKeys` (`:477-479`) → `facades/statuses/keys.ts`
  - `taskKeys` (`:481-498`) → `facades/tasks/keys.ts` (kanban)
  - `teamKeys` + `teamMembersKey` (`:500-509`) → `facades/team/keys.ts`
  - `threadKeys` (`:511-531`) → `facades/threads/keys.ts`
  - `toolKeys` (`:533-535`) → `facades/tools/keys.ts` (agent tools)
  - `triggerKeys` (`:537-543`) → `facades/triggers/keys.ts`
  - `userKeys` (`:545-547`) → `facades/users/keys.ts`
  - `webPushKeys` (`:549-551`) → `facades/web-push/keys.ts`
  - `workflowKeys` (`:553-571`) → `facades/workflows/keys.ts`
  - `mailboxConnectionKeys` (`:573-575`) → `facades/mailbox` or connected-mail
    facade
  - `browserCloudKeys` (`:577-584`) → a browser-cloud facade
  - `teamProvisioningKeys` (`:586-596`) → `facades/organization/keys.ts` or
    `facades/team/keys.ts`
  - `paginationKeys` (`:377-385`) is a cross-cutting helper (builds a page key
    from *any* resource key), not a domain — it should stay central
    regardless of what the reviewer decides for everything else.
- Fix size: L if decentralized — not because any one move is hard, but
  because `test/query-key-invariants.test.ts` scans every file under
  `admin/src` for literal-array key usage (per the file's own header
  comment, `:14-25`) and every one of the ~40 facades' call sites currently
  imports from `lib/query-keys`; moving keys out would touch >20 files and
  the invariant test's own scanning logic. Keeping it central and just
  accepting the 500-line cap doesn't apply to config-shaped files is also a
  legitimate call — that's the S1 reviewer's decision to make, not this
  review's.
- Risk: whichever direction is chosen, `paginationKeys` and any key spread
  with `...` (e.g. `...appsRoot`, `...dashboardWidgetDataKey(widgetId)`,
  `:189-190`, `:207-209`) must keep resolving to literal arrays at the same
  identity, since the invariant test computes prefixes structurally.

### F14. `facades/voice/voice-call-client.ts` (528) — a single stateful controller; already well-decomposed everywhere except its own core

- Severity: medium
- Category: structure | state
- Evidence: `createVoiceCall` (`:85-495`) already delegates protocol framing
  to `gemini-live-protocol.ts`, audio I/O to `voice-audio.ts`, offline usage
  reporting to `voice-usage-outbox.ts`, transcript assembly to
  `voice-transcript-collector.ts`, and PA hand-off to
  `voice-assistant-handoff.ts` — five sibling modules, all imported at the
  top (`:1-29`). What's left is one factory function whose ~15 inner
  functions (`publish`, `send`, `speakThroughModel`, `failCall`,
  `handleToolCall`, `handleEvent`, `stashCurrentTranscript`, `recordUsage`,
  `openSocket`, `reconnect`, `rotate`, `scheduleRotation`, `teardown`, plus
  the returned `start`/`end`/`setMuted`/`dispose`) all close over the same
  seven mutable `let` bindings (`state`, `socket`, `capture`, `playback`,
  `credential`, `resumptionHandle`, `rotateTimer`, `usageSequence`,
  `collector`, `handoff`, `:96-106`).
- Why it matters: this is a real state machine (idle → connecting → live →
  ending/held/failed, plus reconnect/rotate sub-transitions) where nearly
  every function both reads and writes several of the shared bindings —
  e.g. `reconnect` reads `credential`/`state.phase`, calls `rotate` which
  writes `credential` and calls `openSocket` which writes `socket` and calls
  `handleEvent` which writes `state` via `publish`. There is no line range
  that can be lifted out without carrying 4-5 of those bindings with it.
- Fix: no mechanical split recommended without a design pass. If pursued,
  the least-entangled boundary is the socket lifecycle
  (`openSocket`/`reconnect`/`rotate`/`scheduleRotation`, `:272-378`, ~105
  lines) versus the event/tool dispatch (`handleToolCall`/`handleEvent`/
  `stashCurrentTranscript`/`recordUsage`, `:141-270`, ~130 lines) — but both
  still need read/write access to `credential`, `socket`, and `state`, so
  extracting either as a standalone module means passing a small mutable
  "connection handle" object between them instead of closure capture, which
  is a real interface redesign, not a code move.
- Fix size: L — needs a design decision (what owns `credential`/`socket`
  after the split: a shared object? an explicit class? two hooks talking
  through callbacks?) before any code moves.
- Risk: this is a live WebSocket + microphone controller with careful
  ordering guarantees called out in comments throughout (e.g. "Never await
  inside the socket handler," `:217-218`; the binary-frame gotcha,
  `:283-289`); any restructuring must be verified against the voice-call
  test suite (if present) and manually against a real call, not just
  type-checked.

## At risk (440-500 lines)

Not read in full this pass — flagged by line count only
(`find src -name '*.ts*' | xargs wc -l | awk '$1>=440 && $1<=500'`), with a
one-line seam guess from the filename/directory pattern established above.
Confirm before acting.

- `components/features/budgets/BudgetManager.tsx` (446) — likely a
  list-plus-detail-form page; candidate seam is a `BudgetForm`/`BudgetRow`
  split, same shape as F6.
- `components/features/channels/useChannelComposer.ts` (449) — a single hook
  behind `ChannelsPage.tsx`'s composer state (attachments, mentions, secret
  capture, send); candidate seam is separating attachment/paste handling
  from send/mention-invite handling.
- `components/kanban/TaskDialog.tsx` (450) — likely one dialog covering
  create + edit + several task fields; candidate seam is per-field-group
  subforms (assignee/dates, description, subtasks) if it has them.
- `layouts/AdminShellLayout.tsx` (459) — the shell layout that presumably
  chooses between `SidebarNav`/`AdminSidebarNav`/`ProjectsSidebarNav`;
  candidate seam is extracting the sidebar-choice logic from the layout
  chrome (header/rail/content grid).
- `components/features/knowledge/KnowledgeWorkspace.tsx` (469) — the
  consumer of `KnowledgeProvider` (F9); candidate seam mirrors the
  provider's own split (navigation-driven column rendering vs. editor/history
  dialogs).
- `facades/notifications/useMessageNotifications.ts` (470) — candidate seam
  is separating permission/subscription bookkeeping from the actual
  notification-dispatch logic, similar to F4's browser-notifications split.
- `facades/apps/connect-hooks.ts` (474) — a facade file at nearly 500 lines;
  candidate seam is per-provider connect flows if it covers more than one
  app-connection type in one file.
- `pages/IntegrationsPage.tsx` (488) — candidate seam is list vs. detail
  panel, same shape as F6/F7.
- `layouts/admin-shell/useAdminShell.ts` (489) — sibling to
  `AdminSidebarNav.tsx`/`ProjectsSidebarNav.tsx`/`SidebarNav.tsx`; candidate
  seam is separating shell-selection logic (which sidebar/section is active)
  from whatever else it computes for the shell chrome.
- `facades/threads/document-stream.ts` (492) — consumed by `ChannelsPage.tsx`
  (`useThreadStream`); candidate seam is separating stream-connection
  lifecycle from document-store update logic.
- `pages/ChannelConversationComposePage.tsx` (492) — sibling to
  `ChannelsPage.tsx`'s compose route; candidate seam likely mirrors F12's
  hook-orchestration-plus-prop-wiring shape.
- `components/features/apps/agent-access-view.ts` (495) — candidate seam is
  separating pure view-model construction from any query/mutation wiring it
  does inline.
- `pages/channels/ChannelConversationSurface.tsx` (496) — the primary
  consumer of `ChannelsPage.tsx`'s giant prop object (F12); candidate seam is
  breaking its own prop list into the same logical groups (call surface,
  composer, search, message actions) that `ChannelsPage.tsx` already groups
  them into when calling it.
- `components/features/connected-mail/ConnectedMailCompose.tsx` (500) —
  candidate seam is separating recipient/subject/body form state from
  send-attempt/error handling.
- `pages/AgentDesignerPage.tsx` (500) — candidate seam is separating the
  designer's canvas-hosting page shell from whatever list/detail chrome
  wraps it (agent picker, save/publish actions).

## Conventions observed

- The dominant, healthy pattern in this codebase is "peel off the reusable
  piece as a sibling file with a domain name, leave the orchestrator in the
  page/provider." 10 of the 14 files over the cap already show this pattern
  partway done (`AuthSessionProvider.tsx`, `KnowledgeProvider.tsx`,
  `MentionInput.tsx`, `voice-call-client.ts`, `serialization.ts`,
  `ChannelsPage.tsx`, `ChannelMessageFeed.tsx`, `WorkflowsPage.tsx`,
  `ProjectsSidebarNav.tsx` all import at least one sibling that used to be
  part of them).
- Data tables (nav items, ADMIN_NAV-shaped constants) are meant to live in
  their own file beside the component that renders them —
  `layouts/admin-shell/nav-items.tsx` is the precedent; `AdminSidebarNav.tsx`
  just hasn't followed it yet for its own table.
- Cookie-backed expand/collapse UI state is a recurring pattern
  (`SidebarMenuSection`'s `useCookieBackedSidebarSections`,
  `ProjectsSidebarNav.tsx`'s two ad hoc `Set<string>` cookies,
  `SidebarProjectsSection.tsx`'s own ad hoc `Set<string>` cookie) — there is
  no single shared implementation for "a `Set<string>` of ids persisted to a
  cookie," and three call sites have each written it independently with
  slightly different polarity (expanded vs. collapsed).
- Query keys are the one deliberate exception to per-domain-file: the header
  comment in `lib/query-keys.ts` explains the choice (one file, one
  invariant test) and the file lives up to it — it is internally consistent
  even though it is long.

## Not a problem

- `facades/knowledge/*` vs. `KnowledgeProvider.tsx`: correctly layered (data
  facade vs. UI-state provider), not a duplicate — see F9.
- `AdminSidebarNav.tsx` vs. `SidebarNav.tsx`: not the same nav. Per
  `layouts/admin-shell/nav-items.tsx:115-154`, they belong to two different
  top-level rail sections (`admin` vs. `channels`) and never render at the
  same time; the generic name `SidebarNav.tsx` (vs. the prefixed
  `AdminSidebarNav.tsx`) is a minor naming inconsistency but not a
  duplicate-responsibility problem.
- `ProjectsSidebarNav.tsx` vs. `SidebarProjectsSection.tsx`: also not a
  duplicate file to merge — one drives the `projects` rail section (sections
  + boards, React Router `Link`s), the other is embedded in the `channels`
  rail section's `SidebarNav.tsx` (project's channels, callback-driven). They
  should share a menu-positioning hook (see F5) but are not redundant
  components.
- `voice-call-client.ts`'s five sibling modules (`gemini-live-protocol.ts`,
  `voice-audio.ts`, `voice-usage-outbox.ts`, `voice-transcript-collector.ts`,
  `voice-assistant-handoff.ts`): already correctly extracted; the remaining
  528 lines are the irreducible controller, not neglected splitting (F14).
- `lib/query-keys.ts`'s internal organization: not entangled, not a
  "-helpers" dump — it is one `const` per domain in alphabetical order with a
  documented, enforced invariant (F13). The 500-line cap simply wasn't
  designed with a config-shaped file like this in mind; that's a decision to
  make, not a defect to fix.
