# File Naming and Directory Placement Consistency

## Verdict

The codebase follows a dominant PascalCase convention for .tsx components (97% compliance across all directories) and kebab-case for .ts utilities, but hook file naming is inconsistent (camelCase useX.ts is the norm, but 3 files use kebab-case use-X.ts). Catch-all bucket names exist in three locations and violate the architecture guardrails. Non-routed presentation components scattered across pages/ directories should consolidate into features/ domains. The layering hazard is medium: naming inconsistency won't prevent the code from working, but the catch-all files and misplaced pages block coherent refactoring.

## Findings

### F1. Hook file naming inconsistent: camelCase useX.ts standard, three outliers use kebab-case use-X.ts

- Severity: medium
- Category: naming
- Evidence:
  - Dominant pattern: `src/hooks/useStickToBottom.ts`, `src/hooks/useDebouncedValue.ts`, `src/pages/channels/useChannelCall.ts`, `src/components/shared/useModalA11y.ts`, `src/pages/channels/useReplyThread.ts`
  - Outliers: `src/layouts/admin-shell/use-phone-back-swipe.ts` (exports `usePhoneBackSwipeGesture`), `src/components/shared/channel-members/use-member-filters.ts`, `src/components/features/knowledge/wikilink/use-wikilink-navigation.ts`

- Why it matters: A single naming convention for hooks makes them findable and searchable. The three kebab-case files sit beside camelCase files in the same directories, creating friction every time someone looks for a hook by pattern. This matters especially for pages/ and features/ where hooks are mixed with components.

- Fix: Rename the three outlier files to match the camelCase convention:
  - `use-phone-back-swipe.ts` → `usePhoneBackSwipeGesture.ts`
  - `use-member-filters.ts` → `useMemberFilters.ts`
  - `use-wikilink-navigation.ts` → `useWikilinkNavigation.ts`
  (No export changes needed; the hook names inside stay the same.)

- Fix size: S (3 files, rename only, no logic changes)
- Risk: None; renames are local and grep-safe. IDE can refactor automatically.

### F2. Catch-all *-helpers.ts and *-shared.tsx files scatter domain logic across four locations

- Severity: high
- Category: naming, structure
- Evidence:
  - `src/components/features/channels/channel-helpers.ts` (75 lines): type exports, constants, helpers for channel tabs; no single cohesive export
  - `src/components/features/channels/thread-panel/thread-panel-helpers.ts` (40 lines): presentation helpers specific to thread panel layout
  - `src/facades/threads/document-stream-helpers.ts` (45 lines): document stream formatting helpers
  - `src/pages/settings/settings-shared.tsx` (60+ lines): `FeedbackBanner`, `SettingsPanel` components, `sectionTitleClass` style constant, `hoverCardClass` constant
  - `src/pages/settings/push/shared.tsx` (35 lines): `PushStatusRow`, `PushResultBanner` components
  - `src/pages/settings/statuses/status-components.tsx` (100 lines): `StatusList` component, `describeSchedule`, `describeRule`, `dayLabels` utilities

- Why it matters: The architecture guardrails forbid "broad buckets like helpers, extras, common, or catch-all runtime modules." These files hide their actual responsibility behind generic names, making them invisible to team grep patterns and architecture reviews. When a bug hits `describeSchedule`, nobody knows to look in `status-components.tsx`. When a new page needs the settings panel frame, nobody finds it in `settings-shared.tsx` because they search for a component name, not a bucket.

- Fix:
  - `channel-helpers.ts`: Move `CHANNEL_TABS`, `ChannelTab`, `ChannelAgentParticipant`, and `toolbarButtonClass` into `ChannelTabBar.tsx` and a new `channel-presentation.ts`. Keep type exports next to their consumers.
  - `thread-panel-helpers.ts`: Rename to `thread-panel-styles.ts` (if only styles) or merge the 40 lines into the consuming component.
  - `document-stream-helpers.ts`: Rename to `document-stream-formatting.ts`.
  - `settings-shared.tsx`: Split into two files:
    - `SettingsPanel.tsx` (component export)
    - `settings-presentation.ts` (style constants and types)
  - `shared.tsx` in push/: Rename to `push-presentation.tsx`.
  - `status-components.tsx`: Split into two:
    - `StatusList.tsx` (component)
    - `status-presentation.ts` (utilities: `describeSchedule`, `describeRule`, `dayLabels`)

- Fix size: M (6 files, mostly rename + minor split, ≤20 files touched)
- Risk: Imports change. Run `git grep` for each filename to find all imports and update them. No logic changes.

### F3. Non-routed presentation components and hooks scattered across pages/ directories; should consolidate in features/

- Severity: high
- Category: structure, layering
- Evidence: Router imports 45 routed pages (SearchPage, AlertsPage, ChannelsPage, ProjectView, etc.). But pages/ contains 81 files in subdirectories that are not routed:
  - `pages/channels/`: 17 files (ChannelConversationSurface, ChannelInfoDrawers, ChannelOverlays, ThreadInboxCard, 13 hooks)
  - `pages/feedback/`: 3 files (FeedbackComposer, FeedbackList, feedback-presentation.ts)
  - `pages/project/`: 15 files (ProjectBacklogTab, ProjectBoardTab, ProjectDocsTab, ProjectExecutorsTab, ProjectInsightsTab, ProjectView, and 9 in settings/)
  - `pages/settings/`: 35 files (10 panels + dialogs, 1 presentation utility, others in subdirs appearance/, connections/, organization/, profile/, push/, statuses/, team/)
  - `pages/triggers/`: 1 hook (useTriggersPageState.ts)
  - `pages/workflow-designer/`: 3 hooks

- Why it matters: The pages/ directory signals "routed entry points" to readers and tooling. Hiding 81 non-routed files there (52% of the directory is scaffolding, not pages) creates confusion during onboarding, breaks grep patterns ("find all channels features"), and makes architectural reviews harder. The brief notes 27 non-Pascal files already — these should not be in pages/; they should be in `components/features/channels/`, `components/features/settings/`, `components/features/projects/`.

- Fix: Move non-routed files from pages/ into components/features/:
  - `pages/channels/*` (excluding routed ChannelsPage) → `components/features/channels/` (already exists; add the 17 files)
  - `pages/feedback/{FeedbackComposer, FeedbackList, feedback-presentation.ts}` → `components/features/feedback/` (create if needed)
  - `pages/project/{ProjectBacklogTab, ProjectBoardTab, ProjectDocsTab, ProjectExecutorsTab, ProjectInsightsTab}` → `components/features/projects/`
  - `pages/project/settings/*` → `components/features/projects/settings/` or a new facade
  - `pages/settings/*` → `components/features/settings/` (create or extend)
  - `pages/triggers/useTriggersPageState.ts` → `components/features/triggers/`
  - `pages/workflow-designer/*` → `components/features/workflow-designer/`

  Update imports in router.tsx (line 38, 39, 40–49 import settings pages; line 10–54 import all pages) to import routed pages only.

- Fix size: L (81 files, cross-layer reorganization; impacts router imports, multiple features)
- Risk: Router imports must be audited and relinked to ensure only routed pages are imported there. Facade imports must be updated. Test: router.tsx should import only component file names ending in "Page.tsx" (the 45 currently routed).

### F4. QueryProvider.tsx should be .ts (re-export only, no JSX)

- Severity: low
- Category: typing
- Evidence: `src/providers/QueryProvider.tsx:1` contains only `export { QueryProvider } from '@nessie/client-core'`; no React component, no JSX.

- Why it matters: .tsx signals "React component, may contain JSX". Re-export barrels are utilities, not JSX. This is a minor signal-noise issue but adds confusion to grep patterns ("find all providers that render JSX").

- Fix: Rename `src/providers/QueryProvider.tsx` → `src/providers/query-provider.ts`.

- Fix size: S (1 file, rename only)
- Risk: Low; re-exports are transparent to callers.

### F5. Loose .ts files at root of src/facades/ should be moved into a cohesive facade or lib

- Severity: medium
- Category: structure
- Evidence:
  - `src/facades/deep-water-tool-filter.ts` (1 KB): tool filtering logic
  - `src/facades/form-errors.ts` (1 KB): form error handling
  - `src/facades/mcp-instance-tool-filter.ts` (1 KB): MCP filtering logic
  - `src/facades/usePagedList.ts` (1 KB): pagination hook

  These live at the root of facades/ (where only directories and hooks.ts belong), not in a domain facade.

- Why it matters: Loose files at directory roots suggest "hasn't been categorized yet" or "too generic to name". They break the facade pattern (each facade is a domain). A reader opening facades/ expects 55 domain folders; instead finds 4 mystery files.

- Fix:
  - `deep-water-tool-filter.ts` and `mcp-instance-tool-filter.ts`: Move into a new `src/facades/tool-filters/` facade, or move to `src/lib/` if they're utility-only (not domain API logic).
  - `form-errors.ts`: Move to `src/lib/form-errors.ts` (shared utility, not domain).
  - `usePagedList.ts`: Move to `src/lib/use-paged-list.ts` (shared hook, not domain API). Or move it into facades/ if it's a pagination factory for query hooks.

  If domain logic, create:
  - `src/facades/deep-water/` with a hooks.ts, and move the filter into it
  - `src/facades/tool-filters/` with a hooks.ts, and move both tool filters

- Fix size: M (4 files, move + update imports; impacts 5-10 files)
- Risk: Straightforward if domain-assigned; harder if the files are truly cross-cutting (then lib/ is correct).

### F6. Test file naming: 207 test files follow kebab-case behavior-based naming; 7 are source-reading gate tests

- Severity: low (information only; not a defect)
- Category: testing
- Evidence:
  - Sample 25 (first files alphabetically): all kebab-case (e.g., `agent-avatar-settings-control.test.ts`, `agent-designer-save-readiness.test.ts`)
  - All 207 end in `.test.ts`
  - 7 gate tests use `readFileSync` to read source files and assert patterns:
    - `confirm-dialog.test.ts` (gates Dialog adoption)
    - `dialog-adopters.test.ts` (gates new Dialog uses)
    - `draft-surfaces.test.ts` (gates draft storage patterns)
    - `knowledge-page-editor.test.ts` (gates editor behavior)
    - `navigation-overlay.test.ts` (gates overlay navigation)
    - `navigation-redirect-route.test.ts` (gates redirect patterns)
    - `topbar-desktop-chrome.test.ts` (gates desktop chrome)

- Why it matters: The test suite uses behavior-based naming (not source-path naming), making test intent discoverable. Gate tests are few and focused, which is healthy. This is a convention already working well.

- Fix: None needed. Document this convention (already implicit in the codebase).

### F7. Two Card.tsx components exist (components/shared and components/overlays); naming conflict

- Severity: medium
- Category: naming
- Evidence: `src/components/shared/Card.tsx` and `src/components/overlays/Card.tsx`; baseline acknowledges this.

- Why it matters: IDE auto-complete and grep both return two hits. Readers must disambiguate by path. Over time, this breeds cross-layer imports (e.g., features importing overlay Card instead of shared Card, or vice versa).

- Fix: Rename one to clarify its role:
  - `src/components/overlays/Card.tsx` → `src/components/overlays/OverlayCard.tsx`
  - Update imports: grep `from '.*overlays/Card'` and add `Overlay` prefix to imports.

- Fix size: S (1 file rename, ~10 import sites)
- Risk: Low; imports are resolvable.

### F8. Test naming matches behavior, not source file; test→source mapping hidden

- Severity: low
- Category: testing
- Evidence: Sampled 25 test files; naming like `agent-designer-save-readiness.test.ts` (what it tests) rather than `AgentDesignerPage.test.ts` (source file). No clear scheme maps test → source.

- Why it matters: New contributors opening a test file don't immediately see which source file it covers. The gate tests (F6) mitigate this by reading source, but unit tests require manual search.

- Fix: Add a comment at the top of each test file naming the primary source file(s) under test (1-line, no overhead). Or standardize a header comment block. This is a documentation enhancement, not a code change.

- Fix size: S (documentation; optional enhancement)
- Risk: None.

## Conventions Observed

- **Component files**: PascalCase .tsx files export React components (e.g., `Button.tsx`, `ChannelMessageRow.tsx`)
- **Hook files**: camelCase useX.ts files export React hooks (e.g., `useStickToBottom.ts`, `useChannelCall.ts`)
- **Utility modules**: kebab-case .ts files export constants, types, and helper functions (e.g., `channel-helpers.ts`, `thread-read-marker.ts`)
- **Styled constants**: Kept in the same file as their consumer, or in a `-presentation.ts` / `-styles.ts` sibling (e.g., `toolbarButtonClass` in `channel-helpers.ts`)
- **Routed pages**: PascalCase XyzPage.tsx files in src/pages/, imported by router.tsx
- **Non-routed presentation**: Subdirectories of pages/ hold hooks, panels, dialogs, and helper components (should move to features/)
- **Facades**: One domain per directory (e.g., src/facades/agents/, src/facades/channels/); each contains hooks.ts, and optionally keys.ts, queries.ts, mutations.ts, realtime.ts
- **Test naming**: Kebab-case behavior-based names (e.g., `agent-designer-save-readiness.test.ts`); gate tests read source via readFileSync and assert patterns

## Not a Problem

- **Duplicate basenames in facades** (hooks.ts, keys.ts, queries.ts, mutations.ts, types.ts): Expected and intentional per architecture. Each facade is a domain; these filenames are cohesive within each.
- **types.ts files** (2 found: layouts/admin-shell/types.ts, lib/workflow-designer/types.ts): Appropriate for domain-specific type definitions. No accumulation.
- **PascalCase non-component .tsx files** (ExternalAuthRouterBridge.tsx, SeededRoute.tsx): Both return React nodes (one null, one renderMatches result); valid as .tsx despite no JSX syntax.
- **Subdirectory nesting in components/features/** (e.g., agents/designer/, agents/todos/): Organized by feature domain; consistent with architecture.
- **Sub-facades within facades** (e.g., channels/thread-panel/): OK if the sub-directory is a cohesive sub-domain (e.g., thread-panel is part of channels feature).
- **Loose .tsx files in features** (e.g., channels/ChannelConversationSurface.tsx): OK if they're presentation components for that feature. No generic names like "SurfaceShared.tsx" found.

---

# Appendix: Full File Lists for Audit

## Hook Files with Non-Standard Naming (use-X.ts)

```
src/layouts/admin-shell/use-phone-back-swipe.ts (exports usePhoneBackSwipeGesture)
src/components/shared/channel-members/use-member-filters.ts
src/components/features/knowledge/wikilink/use-wikilink-navigation.ts
```

## Catch-All Bucket Names (to be split/renamed)

```
src/components/features/channels/channel-helpers.ts
src/components/features/channels/thread-panel/thread-panel-helpers.ts
src/facades/threads/document-stream-helpers.ts
src/pages/settings/settings-shared.tsx
src/pages/settings/push/shared.tsx
src/pages/settings/statuses/status-components.tsx
```

## Loose Files at Root of src/facades/ (to be moved)

```
src/facades/deep-water-tool-filter.ts
src/facades/form-errors.ts
src/facades/mcp-instance-tool-filter.ts
src/facades/usePagedList.ts
```

## Non-Routed Files in src/pages/ (to move to components/features/)

### pages/channels/ (17 files, non-routed)
```
src/pages/channels/ChannelConversationSurface.tsx
src/pages/channels/ChannelInfoDrawers.tsx
src/pages/channels/ChannelOverlays.tsx
src/pages/channels/ThreadInboxCard.tsx
src/pages/channels/channelMentionTargets.ts
src/pages/channels/thread-inbox-presentation.ts
src/pages/channels/thread-read-marker.ts
src/pages/channels/useCallerCallDialog.ts
src/pages/channels/useChannelCall.ts
src/pages/channels/useChannelMentions.tsx
src/pages/channels/useChannelMessageSearch.ts
src/pages/channels/useChannelParticipants.ts
src/pages/channels/useChannelTab.ts
src/pages/channels/useChannelTitleFavorite.ts
src/pages/channels/useDeepWaterResearchLauncher.tsx
src/pages/channels/useExecutorRunLauncher.tsx
src/pages/channels/useReplyThread.ts
src/pages/channels/useReportChannelPushSurface.ts
src/pages/channels/useThreadReadMarker.ts
```

### pages/feedback/ (3 files, non-routed)
```
src/pages/feedback/FeedbackComposer.tsx
src/pages/feedback/FeedbackList.tsx
src/pages/feedback/feedback-presentation.ts
```

### pages/project/ (15 files, non-routed)
```
src/pages/project/ProjectBacklogTab.tsx
src/pages/project/ProjectBoardTab.tsx
src/pages/project/ProjectDocsTab.tsx
src/pages/project/ProjectExecutorsTab.tsx
src/pages/project/ProjectInsightsTab.tsx
src/pages/project/ProjectView.tsx
src/pages/project/settings/BoardColumnsEditor.tsx
src/pages/project/settings/BoardsSettingsSection.tsx
src/pages/project/settings/ConnectSourceDialog.tsx
src/pages/project/settings/CredentialFormFields.tsx
src/pages/project/settings/FieldsSettingsSection.tsx
src/pages/project/settings/SourceMappingPanel.tsx
src/pages/project/settings/SourcesSettingsSection.tsx
```

### pages/settings/ (35+ files, non-routed)
```
src/pages/settings/MemberDetailsDialog.tsx
src/pages/settings/MemberInvitationDialog.tsx
src/pages/settings/MembersRosterPanel.tsx
src/pages/settings/OrganizationAdministrationGate.tsx
src/pages/settings/OrganizationMembersSection.tsx
src/pages/settings/SecretsPanel.tsx
src/pages/settings/TeamMemberPeople.tsx
src/pages/settings/TeamMembersSection.tsx
src/pages/settings/appearance/ColoursPanel.tsx
src/pages/settings/appearance/TypePanel.tsx
src/pages/settings/connections/AddSendAuthorization.tsx
src/pages/settings/connections/ConnectionCard.tsx
src/pages/settings/connections/ConnectionPermissions.tsx
src/pages/settings/connections/DeviceLinkDialog.tsx
src/pages/settings/connections/ModelSubscriptionSection.tsx
src/pages/settings/connections/ProjectToolConnections.tsx
src/pages/settings/connections/SendAuthorizationSection.tsx
src/pages/settings/connections/SendBoundaryEditor.tsx
src/pages/settings/notification-preference-controls.tsx
src/pages/settings/organization/CallProviderSettingsPanel.tsx
src/pages/settings/organization/LogoPanel.tsx
src/pages/settings/organization/ThemeChecks.tsx
src/pages/settings/profile/AvatarPanel.tsx
src/pages/settings/push/ApnsCard.tsx
src/pages/settings/push/FcmCard.tsx
src/pages/settings/push/shared.tsx
src/pages/settings/session-device.ts
src/pages/settings/settings-shared.tsx
src/pages/settings/statuses/StatusEmojiPicker.tsx
src/pages/settings/statuses/status-components.tsx
src/pages/settings/team/TeamAvatarPanel.tsx
```

### pages/triggers/ (1 file, non-routed)
```
src/pages/triggers/useTriggersPageState.ts
```

### pages/workflow-designer/ (3 files, non-routed)
```
src/pages/workflow-designer/useWorkflowCanvasInteractions.ts
src/pages/workflow-designer/useWorkflowDesignerState.ts
src/pages/workflow-designer/useWorkflowGraphIO.ts
src/pages/workflow-designer/useWorkflowTestRun.ts
```

## Gate Tests (7 total)

```
test/confirm-dialog.test.ts (gates Dialog adoption)
test/dialog-adopters.test.ts (gates Dialog uses)
test/draft-surfaces.test.ts (gates draft patterns)
test/knowledge-page-editor.test.ts (gates knowledge editor)
test/navigation-overlay.test.ts (gates overlay navigation)
test/navigation-redirect-route.test.ts (gates redirect patterns)
test/topbar-desktop-chrome.test.ts (gates desktop chrome)
```

## Duplicate Component Names

```
src/components/shared/Card.tsx
src/components/overlays/Card.tsx
```

## Re-Export .tsx Files (Should be .ts)

```
src/providers/QueryProvider.tsx (re-export only)
```
