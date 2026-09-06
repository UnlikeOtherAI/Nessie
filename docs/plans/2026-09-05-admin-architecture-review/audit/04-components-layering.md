# Component reuse and the primitives → shared → features → pages/layouts layering

## Verdict

The four-layer split (primitives / shared / features / pages) is real and the
large majority of the ~640 files in `admin/src/components`, `layouts`, `pages`
sit on the correct side of it; the biggest wins the architecture doc asks for
(one `IdentityTile`, one `TabBar`, one `ChoiceGroup`, one `SidePanelShell`)
already happened and say so in their own header comments. The leaks are
concentrated in exactly the places the doc's §5.3 tree diagram doesn't model:
two undocumented top-level buckets (`components/overlays`, `components/kanban`,
`components/desktop`) sit beside `primitives/shared/features` with no stated
rule for what belongs there; a family of "phone navigation" modules that only
`components/` and the navigation framework need is stranded one layer too high
in `layouts/admin-shell`, producing a literal upward import from
`navigation/back.ts` into `layouts/`; and a handful of `components/shared` and
`components/features` files reach sideways/upward in exactly the counts the
baseline names (shared→features 4, components→layouts 20, components→pages 4).
None of this needs a public API change — every fix below is a file move plus
import-path edits — but it is roughly 25-30 files out of position, which is
enough that a new contributor cannot infer "features live in `features/`" from
the tree as it stands today.

## Findings

### F1. `TriggerTypePicker` reinvents the exact hand-rolled radio-card grid `ChoiceGroup` was built to delete, and reintroduces the keyboard bug it fixed
- Severity: high
- Category: reuse / a11y
- Evidence: `components/features/triggers/TriggerTypePicker.tsx:45-84` renders
  a `role="radiogroup"` of `<button role="radio">` cards with
  `border-[color:var(--accent)] bg-[var(--accent-soft)]` for the selected
  state — hand-assembled ARIA, no real `<input type="radio">`. Compare
  `components/shared/ChoiceGroup.tsx:6-20,49-55,86-119`, whose own header
  comment says: *"Five hand-rolled versions existed... radio cards in the
  appearance panels... only the appearance panels used real radios, so the
  rest were unreachable by keyboard as a group."* `ChoiceGroup`'s `card`
  variant (lines 86-119) is the identical shape — label + description card,
  selected state drawn with the same two class strings — built on a visually
  hidden real `<input type="radio">` for exactly the reason `TriggerTypePicker`
  lacks: arrow-key navigation and a single announced group value.
- Why it matters: this is not a style nit — `TriggerTypePicker`'s cards are
  `Tab`-stoppable individually but not arrow-key-navigable as a group, which is
  the specific defect `ChoiceGroup`'s comment says was fixed everywhere else.
  It is also the fourth "shape" for the same "pick one, with an explanation"
  problem the plan didn't audit (it audited pills/tables/forms, not choice
  widgets).
- Fix: replace `TriggerTypePicker`'s body with
  `<ChoiceGroup variant="card" label="Trigger type" options={...} value={value} onChange={onChange} />`.
  `ChoiceGroup`'s `ChoiceOption` has no icon slot; add one optional
  `icon?: ReactNode` field to `ChoiceOption`/the card renderer
  (`components/shared/ChoiceGroup.tsx:22-28,107-109`) rather than forking a
  second card component. Delete `TriggerTypePicker.tsx`'s custom markup.
- Fix size: S (<1h, 2 files: `ChoiceGroup.tsx` + `TriggerTypePicker.tsx`)
- Risk: visual change to the trigger-type step of trigger creation only
  (`components/features/triggers/TriggerTypePicker.tsx`'s single call site);
  confirm with a screenshot and that arrow keys now move selection.

### F2. The navigation framework imports upward into the shell it is supposed to sit under
- Severity: high
- Category: layering
- Evidence: `navigation/back.ts:1-6` imports
  `LocalBackSnapshot` from `../layouts/admin-shell/local-back/local-back-registry`,
  `resolvePhoneLedgerBackAction`/`PhoneHistoryLedger` from
  `../layouts/admin-shell/phone-navigation-ledger`, and
  `getPhoneNavigationBackTarget` from `../layouts/admin-shell/phone-navigation`
  — i.e. `navigation/`, the doc-mandated single framework
  (`AGENTS.md` → "Navigation — one framework"), depends on `layouts/admin-shell`.
  The same four files are *also* imported downward by
  `components/overlays/Sheet.tsx:13`, `components/overlays/sheet-swipe.ts:8`,
  `components/overlays/useOverlay.ts:2`, and five `components/features/*`
  files (`browser-cloud/AgentScreenPanel.tsx:5`,
  `personal-assistant/PersonalAssistantSurface.tsx:7`,
  `knowledge/KnowledgeWorkspace.tsx:13`, `knowledge/KnowledgeSidebarPageTree.tsx:4`,
  `knowledge/KnowledgeSpaceList.tsx:3`, `dashboards/DashboardWorkspacePanel.tsx:8`,
  `channels/ConversationInfoFlow.tsx:6`, `channels/thread-panel/ThreadReplyPanel.tsx:20`).
  Every one of those four files is pure decision/state logic with no shell
  rendering — `phone-navigation-gesture.ts:1-3` says so explicitly ("Pure
  decision logic... so the behaviour can be tested without a browser").
- Why it matters: two different directories both claim to be "the" Back
  authority (`navigation/back.ts` and `layouts/admin-shell/local-back/*`), and
  the import direction is backwards from what the doc's layering implies
  (framework code should not depend on the shell that consumes it). This is
  also *why* 8 of the 20 `components→layouts` imports exist — components
  reaching for navigation state have nowhere lower to get it from.
- Fix: move `layouts/admin-shell/local-back/local-back-registry.ts`,
  `layouts/admin-shell/local-back/LocalBackContext.tsx`,
  `layouts/admin-shell/phone-navigation.ts`,
  `layouts/admin-shell/phone-navigation-gesture.ts`, and
  `layouts/admin-shell/phone-navigation-ledger.ts` into `navigation/` (e.g.
  `navigation/local-back-registry.ts`, `navigation/local-back.tsx`,
  `navigation/phone-navigation.ts`, `navigation/phone-navigation-gesture.ts`,
  `navigation/phone-navigation-ledger.ts`). Update the ~13 importers'
  paths (`navigation/back.ts`, `navigation/history.ts`, the 8 files above,
  plus the layouts files that still need them:
  `PhoneNavigationProvider.tsx`, `use-phone-back-swipe.ts`,
  `PhoneNavigationLayer.tsx`, `KnowledgeSidebarNav.tsx`, `AdminShellLayout.tsx`,
  `PhoneNavigationViewport.tsx`). Leave `phone-navigation-stack.ts` in
  `layouts/admin-shell` — its only two consumers
  (`PhoneNavigationViewport.tsx`, `PhoneNavigationLayer.tsx`) are genuine
  shell-rendering code.
- Fix size: M (one session, ~18 files, all import-path edits — no logic changes)
- Risk: purely a move; typecheck catches every broken import. Behaviourally
  inert if done as a straight relocation.

### F3. Two whole files are dead: superseded by the UOA migration and never deleted
- Severity: high
- Category: structure
- Evidence: `pages/settings/OrganizationMembersSection.tsx` (170+ lines,
  wired to `useOrganizationMembers`/`useSetOrganizationMemberActivation`/
  `useUpdateOrganizationMemberRole` from `facades/users/organization-members.ts`)
  has **zero importers** anywhere in `admin/src` — confirmed by
  `grep -rl OrganizationMembersSection admin/src` returning only the
  definition file itself. `pages/settings/SettingsMembersPage.tsx:186-191`
  shows what replaced it: on a UOA session it renders
  `<MembersRosterPanel scope="organization" />` instead, and the non-UOA
  branch (`SettingsMembersPage.tsx:159-172`) builds the local roster inline
  with `buildPeopleAgentsTree` rather than delegating to
  `OrganizationMembersSection`. `facades/users/organization-members.ts`'s
  three hooks are therefore also dead — nothing else calls them
  (`grep -rl useOrganizationMembers admin/src` → only the facade and the
  orphaned section). Separately, `pages/channels/useCallerCallDialog.ts`
  (a full hook, `UseCallerCallDialogParams`/`UseCallerCallDialogResult`) has
  no importers at all (`grep -rl useCallerCallDialog admin/src` → only its own
  file); the live call-dialog path is `components/features/channels/CallerCallDialog.tsx`,
  wired directly into `pages/channels/ChannelOverlays.tsx:18-20,241`.
- Why it matters: `AGENTS.md` → "Documentation & Goals": *"When a feature is
  removed or superseded, delete or move its doc... do not leave stale specs
  describing code that no longer exists"* — the same principle applies to the
  component itself. A second, unreachable implementation of the org roster is
  exactly the risk Rule zero check 4 warns about (a second implementation is a
  defect), just inverted: this one lost the race silently instead of being
  reachable from two doorways.
- Fix: delete `pages/settings/OrganizationMembersSection.tsx` and the three
  now-unused exports in `facades/users/organization-members.ts` (delete the
  file if nothing else in it survives); delete
  `pages/channels/useCallerCallDialog.ts`.
- Fix size: S (<1h, 2-3 files)
- Risk: none if the "zero importers" grep is re-verified at fix time (a
  dynamic import or test-only reference would be the only way to be wrong);
  run `pnpm --filter @nessie/admin typecheck` after deleting to confirm.

### F4. `MembersRosterPanel` is Rule-zero-correct reuse (one component, parameterised by `scope`) stranded under `pages/`
- Severity: medium
- Category: structure
- Evidence: `pages/settings/MembersRosterPanel.tsx` is rendered from two
  different routed pages —
  `pages/settings/SettingsMembersPage.tsx:189` (`scope="organization"`) and
  `pages/settings/TeamMembersPage.tsx:32` (`scope="team"`) — the exact
  "one component parameterised by scope" pattern Rule zero check 4 names as
  correct (`AGENTS.md` → "the project Docs tab reuses the knowledge team").
  Its two dialogs, `pages/settings/MemberDetailsDialog.tsx` and
  `pages/settings/MemberInvitationDialog.tsx`, are each imported only by
  `MembersRosterPanel.tsx`. Separately, `pages/settings/profile/AvatarPanel.tsx`
  is imported by three different page-level files:
  `pages/settings/SettingsProfilePage.tsx`,
  `pages/settings/team/TeamAvatarPanel.tsx`, and
  `pages/settings/team/TeamProfilePage.tsx`. The architecture doc's §5.3 tree
  puts `pages/` as page shells only, with reusable pieces under
  `components/features/<domain>/`.
- Why it matters: correctly-parameterised reuse is undermined by living in the
  one directory the doc says should hold shells, not shared views — the next
  person adding a third roster consumer has no naming signal that
  `MembersRosterPanel` is meant to be reused versus `pages/settings/AppearancePage.tsx`,
  which genuinely is a one-off shell.
- Fix: move `MembersRosterPanel.tsx`, `MemberDetailsDialog.tsx`,
  `MemberInvitationDialog.tsx`, and `profile/AvatarPanel.tsx` into
  `components/features/settings/`. Update the 5 importers
  (`SettingsMembersPage.tsx`, `TeamMembersPage.tsx`,
  `SettingsProfilePage.tsx`, `team/TeamAvatarPanel.tsx`,
  `team/TeamProfilePage.tsx`).
- Fix size: S (<1h, 4 files moved + 5 import-path edits)
- Risk: none beyond import paths; no behaviour change.

### F5. `AvatarBadges` (and, conditionally, `UserAvatar`) are primitives that depend on a provider
- Severity: medium
- Category: layering
- Evidence: `components/primitives/AvatarBadges.tsx:2` imports
  `useUserPresence` from `../../providers/PresenceProvider` and calls it
  unconditionally at line 33 — the only import from `providers/` anywhere
  under `components/primitives` (`grep -n "providers/" components/primitives/*`
  returns exactly this one hit). `components/primitives/UserAvatar.tsx:134-144`
  conditionally wraps its tile in `<AvatarBadges>` whenever a caller opts into
  `showPresence`/`showStatus` with a `userId`, so `UserAvatar` — used from 27
  files — transitively requires `PresenceProvider` to be mounted for that path.
  By contrast `components/shared/AgentAvatar.tsx:4` needs
  `providers/AgentIdentityProvider` and correctly lives in `shared/`, not
  `primitives/`, for exactly this reason — the codebase already knows the rule
  for one avatar family and not the other.
- Why it matters: doc §5.3's primitives bucket (`Avatar/`, `Badge/`, etc.) is
  implicitly "no data dependencies" — that's what makes a primitive safe to
  import from anywhere, including other primitives, without pulling in a
  provider tree. `AvatarBadges` breaks that contract silently.
- Fix: move `AvatarBadges.tsx` to `components/shared/AvatarBadges.tsx` next to
  `AgentAvatar.tsx` (2 importers: `UserAvatar.tsx`, `channel-members/MemberUserRow.tsx`).
  The more complete fix — since `UserAvatar` itself becomes primitives→shared
  once `AvatarBadges` moves — is to move `UserAvatar.tsx` alongside it into
  `components/shared/`, matching `AgentAvatar`'s placement; that touches all 27
  current importers' paths (mechanical, no logic change).
- Fix size: S for the minimal move (`AvatarBadges.tsx` only, 3 files); M if
  `UserAvatar.tsx` moves too (~27 files, import-path only)
- Risk: none behaviourally; typecheck catches any missed import path.

### F6. Two components named `Card` do unrelated things
- Severity: medium
- Category: naming
- Evidence: `components/shared/Card.tsx:47-63` is "the admin's one card" —
  a content container with `variant: 'row' | 'section'` and a runtime
  nesting guard (`Card.tsx:74-79` throws in dev if a `Card` renders inside
  another `Card`). `components/overlays/Card.tsx:5-20` is a completely
  different thing — its own header comment calls it "the ambient overlay
  kind... a toast, a call banner, a ring" — an animated, `role="status"`
  notification shell built on `runOverlayTransition`, composed only by
  `components/overlays/CardViewport.tsx:5,32` and consumed through
  `providers/ToastProvider.tsx:11,41` (which calls it "the Card kind of
  overlay"). Today's only import of `overlays/Card` is `CardViewport.tsx`
  itself, so there is no live ambiguity at a call site, but the two files sit
  one directory apart with the same name and no import currently
  disambiguates them by alias.
- Why it matters: editor auto-import and future `git grep Card` both surface
  the wrong file at least half the time; a future contributor adding a direct
  import of the toast card (rather than going through `CardViewport`) would
  silently import the content card by mistake if they didn't check the path,
  and vice versa.
- Fix: rename `components/overlays/Card.tsx` → `components/overlays/OverlayCard.tsx`
  (its own doc comment's language — "ambient overlay kind" — fits `OverlayCard`
  or `ToastCard` equally; `OverlayCard` keeps it generic to "toast, call
  banner, ring" per the comment). Update the one import in
  `components/overlays/CardViewport.tsx:5`.
- Fix size: S (<1h, 2 files)
- Risk: none; internal rename with one call site.

### F7. `components/kanban/` is a single-feature directory masquerading as a top-level layer
- Severity: medium
- Category: structure
- Evidence: all 16 files under `components/kanban/` are imported exclusively
  from the projects domain: `layouts/admin-shell/ProjectsSidebarNav.tsx`,
  `pages/project/ProjectView.tsx`, `pages/project/ProjectBoardTab.tsx`,
  `pages/project/ProjectBacklogTab.tsx`, and
  `pages/project/settings/BoardColumnsEditor.tsx`,
  `BoardsSettingsSection.tsx`, `SourceMappingPanel.tsx`
  (`grep -rl "components/kanban" admin/src` confirms no other feature touches
  it). The doc's §5.3 tree has exactly three buckets under `components/` —
  `primitives/`, `shared/`, `features/` — with no fourth sibling for a
  single-domain widget family.
- Why it matters: a directory that reads as "a layer of the app" (sibling of
  `primitives`/`shared`/`features`) but is actually one feature's internals
  hides the real dependency graph — `kanban` looks reusable but isn't, and its
  real owner (`projects`) is one level removed from where its board/task code
  actually lives.
- Fix: move `components/kanban/` → `components/features/projects/kanban/`.
  Update the 7 external importers listed above; internal relative imports
  between the 16 kanban files are unaffected (they move together).
- Fix size: M (one session, ~23 files: 16 moved + 7 import-path edits)
- Risk: none behavioural; pure relocation. Confirm with a project board
  screenshot after the move.

### F8. `components/desktop/` is one call site, not a layer
- Severity: low
- Category: structure
- Evidence: `components/desktop/DesktopWindowFrame.tsx` and
  `desktop-window-adapter.ts` have exactly one importer,
  `providers/AppProvider.tsx` (`grep -rl "components/desktop" admin/src`).
  `DesktopWindowFrame.tsx:2` itself imports
  `layouts/admin-shell/DesktopWindowControls` (also one of the 20
  components→layouts hits) and its own comment says it "lives above the
  router" — i.e. it is app-chrome mounted at the same level as
  `layouts/RootLayout.tsx`, not a feature or a reusable component family.
- Why it matters: same problem as F7 at smaller scale — a top-level
  `components/` sibling that exists for one caller obscures rather than
  clarifies the layering, and it already depends on `layouts/`, so keeping it
  under `components/` guarantees the reverse-dependency this dimension is
  measuring.
- Fix: move `components/desktop/DesktopWindowFrame.tsx` and
  `desktop-window-adapter.ts` into `layouts/` (e.g. `layouts/DesktopWindowFrame.tsx`),
  alongside `RootLayout.tsx`/`AdminShellLayout.tsx`. Update
  `providers/AppProvider.tsx`'s one import and
  `DesktopWindowFrame.tsx`'s own import of `DesktopWindowControls` (becomes a
  same-directory-family import).
- Fix size: S (<1h, 3 files)
- Risk: none; pure relocation.

### F9. `components→pages` imports (4) are page-local hooks a feature component needs the shape of
- Severity: medium
- Category: layering
- Evidence: `components/features/settings/ActiveSessionsTable.tsx:5` imports
  `describeSessionDevice` from `pages/settings/session-device.ts` (a pure
  formatter, zero React/facade dependency —
  `pages/settings/session-device.ts:45-55`).
  `components/features/triggers/TriggerListColumn.tsx:9` imports from
  `pages/triggers/useTriggersPageState.ts` (a 279-line hook composing
  `facades/triggers`, `facades/agents`, `facades/channels`,
  `facades/workflows`, `components/shared/OwnerGate`, and
  `navigation/intent`/`navigation/useTabParam` —
  `pages/triggers/useTriggersPageState.ts:1-20`).
  `components/features/workflow-designer/WorkflowDesignerHeader.tsx:3` imports
  the `WorkflowTestRunState` type from
  `pages/workflow-designer/useWorkflowTestRun.ts` (155 lines, composes
  `facades/workflows`). `components/features/channels/thread-panel/ThreadReplyPanel.tsx:11`
  imports the `useReplyThread` type from `pages/channels/useReplyThread.ts`
  (210 lines, composes `facades/threads`, `providers/AgentIdentityProvider`,
  `layouts/admin-shell/PhoneNavigationProvider`). Each of these hooks already
  has only 2-4 total importers, all within one page's own composition chain
  plus the one feature file above.
- Why it matters: a feature component needing the *shape* of a page's state
  hook is the tell that the hook is feature-level orchestration that got
  filed under `pages/` by proximity to its first caller, not page-shell logic.
  It is the mirror image of F4.
- Fix: move each hook down one level and update its 2-4 importers:
  `pages/settings/session-device.ts` → `lib/session-device.ts` (pure utility,
  no page/feature coupling — belongs beside other formatters in `lib/`);
  `pages/triggers/useTriggersPageState.ts` →
  `components/features/triggers/useTriggersPageState.ts`;
  `pages/workflow-designer/useWorkflowTestRun.ts` →
  `components/features/workflow-designer/useWorkflowTestRun.ts`;
  `pages/channels/useReplyThread.ts` →
  `components/features/channels/useReplyThread.ts`.
- Fix size: S (<1h total, 4 files moved + ~10 import-path edits across all four)
- Risk: none; pure relocation, confirmed by the small, closed importer sets
  above.

### F10. `AgentVisibilityPill` (shared→features, 4 imports) and `AgentStatusDot` are feature components serving multiple features
- Severity: medium
- Category: reuse / layering
- Evidence: `components/shared/AssigneePicker.tsx:6`,
  `components/shared/MentionInput.tsx:19`, and
  `components/shared/channel-members/MemberAgentRow.tsx:3-4` import
  `AgentVisibilityPill` (and `getAgentScope`) from
  `../features/agents/AgentVisibilityPill` / `../../features/agents/agent-scope`
  — 4 import statements across 3 `components/shared` files, matching the
  baseline exactly (`grep -rn "from '\.\./features/\|from '\.\./\.\./features/" components/shared`).
  Separately, `components/features/agents/AgentStatusDot.tsx` (`agent-presentation.ts`
  color map, zero facade/provider dependency) is imported not just within
  `features/agents` but also by `components/features/projects/ProjectAgentsSection.tsx:6`
  and `components/features/channels/panels/ChannelAgentsPanel.tsx`.
- Why it matters: both components are pure, provider-free presentational
  pieces (`AgentVisibilityPill` takes a `visibility` enum and a boolean;
  `AgentStatusDot` takes an `AgentStatus` enum) — nothing about them requires
  the `agents` feature's facades. Their current location forces three
  unrelated features (`shared` call sites, `projects`, `channels`) to reach
  into `agents`' internals instead of a shared location.
- Fix: move `components/features/agents/AgentVisibilityPill.tsx` and
  `AgentStatusDot.tsx` (plus `agent-scope.ts`, which `AgentVisibilityPill`'s
  `getAgentScope` caller needs) to `components/shared/`. Update the 3 shared
  importers (drop the `shared→features` edge entirely) and the 2 cross-feature
  importers (`ProjectAgentsSection.tsx`, `ChannelAgentsPanel.tsx`), which
  become `features→shared` (correct direction).
- Fix size: S (<1h, 3 files moved + ~9 import-path edits)
- Risk: none; both components are presentational with no internal state tied
  to their old location.

### F11. `PhoneBackButton` and `sidebarAriaCurrent` are pure helpers stuck in `layouts/admin-shell`
- Severity: medium
- Category: layering
- Evidence: `layouts/admin-shell/PhoneBackButton.tsx:1-35` has exactly one
  dependency, `useNativeIOSPhoneApp` from `lib/mobile-shell` — no shell state,
  no context. It's imported by `components/shared/ScreenHeader.tsx:3`
  ("the one header every screen renders" per that file's own comment,
  lines 13-38) and 4 `components/features/*` files
  (`browser-cloud/AgentScreenPanel.tsx:5`, `dashboards/DashboardWorkspacePanel.tsx:8`,
  `channels/ConversationInfoFlow.tsx:6` via `PhoneNavigationButton`, and
  `channels/thread-panel/ThreadReplyPanel.tsx:20`).
  `layouts/admin-shell/SidebarRow.tsx:11-12` exports `sidebarAriaCurrent`, a
  one-line pure function (`active ? 'page' : undefined`), consumed by 9 files
  inside `layouts/admin-shell` (its natural home) but also by 3
  `components/features/*` files building their own sidebar-shaped trees
  (`knowledge/KnowledgeSidebarPageTree.tsx:4`, `knowledge/KnowledgeSpaceList.tsx:3`,
  `personal-assistant/PersonalAssistantSurface.tsx:7`).
- Why it matters: `ScreenHeader` is the doc-mandated single header (per its
  own comment, replacing `AdminPageHeader`/`MobileSectionHeader`), so
  `components/shared` reaching into `layouts/admin-shell` for its Back button
  is not a one-off mistake, it is baked into the one component every screen
  uses. Same for the three feature files rebuilding sidebar-row ARIA
  semantics — they found the right convention, just imported it from the
  wrong layer.
- Fix: move `PhoneBackButton.tsx` into `navigation/` alongside the F2 move
  (it belongs with `PhoneNavigationButton`'s eventual home, since both render
  the resolver's answer). Extract `sidebarAriaCurrent` into a new
  `components/shared/row-a11y.ts` and update all 12 current importers'
  paths (9 in `layouts/admin-shell`, 3 in `components/features`).
- Fix size: M (one session, ~17 files: 5 for `PhoneBackButton` + 12 for
  `sidebarAriaCurrent`, all import-path edits)
- Risk: none; both are pure, no behaviour change.

### F12. "Drawer" names three different shapes; two of the six don't use `Sheet`
- Severity: low
- Category: naming
- Evidence: `AgentDetailDrawer.tsx:2`, `ChannelAgentInfoDrawer.tsx:11`,
  `ChannelUserInfoDrawer.tsx:14`, and `AttachmentsDrawer.tsx:14` all import
  `components/overlays/Sheet` — the canonical drawer. But
  `components/features/workflow-tools/ToolDetailDrawer.tsx:1-81` has no
  `Sheet`/`Dialog`/overlay import at all: it's a plain `<div>` of `<dl>` +
  collapsible `<details>` sections, rendered directly inside a
  `ColumnBrowserColumn` at its only call site
  (`pages/ToolsPage.tsx:233-243`) — not an overlay of any kind.
  `components/features/agents/designer/DesignerAssistantDrawer.tsx:20-49` is a
  third shape again: a persistent, always-mounted `<aside>` with its own
  hand-written width/height Tailwind transition, toggled open/closed by local
  state rather than dismissed like an overlay — built on neither `Sheet` nor
  `components/shared/SidePanel.tsx`.
- Why it matters: not a functional duplicate (no code is copy-pasted), but the
  name promises overlay behaviour (focus handling, Escape, backdrop) that
  `ToolDetailDrawer` and `DesignerAssistantDrawer` don't have, which is exactly
  the kind of drift the design-system plan's Dialog section
  (`docs/plans/2026-09-01-content-design-system/overview.md` §2 row `Dialog`,
  "11 hand-rolled modal shells") is trying to prevent one level up.
- Fix: rename `ToolDetailDrawer.tsx` → `ToolDetailSection.tsx` (it's a content
  section, not a drawer) and `DesignerAssistantDrawer.tsx` → keep as a docked
  panel but rename to `DesignerAssistantDock.tsx` to stop it reading as a
  `Sheet`-family component. No behaviour change, naming only.
- Fix size: S (<1h, 2 files + their 2 import sites: `pages/ToolsPage.tsx`,
  wherever `DesignerAssistantDrawer` is mounted)
- Risk: none; pure rename.

## Conventions observed

- **One identity renderer, cleanly layered.** `IdentityTile`
  (`components/primitives/IdentityTile.tsx`) is composed, never
  reimplemented, by `Avatar`, `UserAvatar`, `TeamAvatar`, `ProjectAvatar`
  (primitives) and `AgentAvatar` (shared, because it needs
  `AgentIdentityProvider`) — confirmed by reading all six files. The one place
  this discipline slips is `AvatarBadges`/`UserAvatar`'s presence dependency
  (F5) — everywhere else, "needs a provider → lives in `shared`, not
  `primitives`" is followed exactly.
- **`tone` + `size` is the vocabulary for status/coloring primitives.** `Pill`,
  `Notice`, and `StatTile` all use `tone` (required or defaulted) plus an
  optional `size`; `Switch` and `TabBar` have neither `tone` (not applicable)
  nor `className` passthrough (an outlier — see below).
- **A card never nests, enforced at runtime.** `components/shared/Card.tsx`
  tracks "inside a card" via context and throws in dev
  (`Card.tsx:74-79`) rather than relying on convention.
- **Self-documenting consolidation.** Components built specifically to
  replace N hand-rolled versions say so in their own header comment and name
  what they replaced: `ChoiceGroup.tsx:8-14`, `SidePanel.tsx:6-8`,
  `SidePanelShell.tsx:36-40`. This is the established way to record a
  collapse in this codebase, and it is reliable evidence when auditing.
- **`className` passthrough is inconsistent.** `Pill`, `Notice`, `StatTile`,
  `Dialog`, and `Card` all accept `className`; `Switch` and `TabBar` do not.
- **Event-handler naming is `onChange` almost everywhere a component reports
  "the user picked a value."** `Switch`, `TabBar`, `ChoiceGroup`,
  `AssigneePicker`, `AgentVisibilityPicker`, `TriggerTypePicker`,
  `StatusEmojiPicker` all use `onChange`. `EmojiPickerPanel.tsx:45,55` alone
  uses `onSelect` for the same "user picked a value" event — a lone outlier,
  not a competing convention.
- **`children: ReactNode` is standard; `QueryState` deliberately uses a
  render prop instead** (`children: () => ReactNode`,
  `components/shared/QueryState.tsx:19-25`), and its own comment explains why
  (the body must not run — and dereference `query.data` — outside the success
  branch). This is a documented, intentional exception, not drift.

## Not a problem

- **`AgentRow` (shared) vs `AgentListRow` (features/agents).** Different DOM
  containers for different lists — `AgentRow` is a bordered card/button
  (`components/shared/AgentRow.tsx:56-68`), `AgentListRow` is a `<tr>` inside
  `AgentsTable` (`components/features/agents/AgentListRow.tsx:27-41`). Not the
  same shape; no fix needed.
- **`MemberAgentRow`/`MemberUserRow` (channel-members popup) vs
  `AgentRow`/`AgentListRow`.** These share a local `rowClass` from
  `components/shared/channel-members/styles.ts` and are correctly scoped to
  the member-management popup's own compact-row shape — distinct from both of
  the above. Correctly-scoped local reuse, not a cross-cutting duplicate.
- **`components/shared/SidePanel.tsx` vs
  `components/features/channels/side-panel/SidePanelShell.tsx`.** The brief
  flagged the name overlap, but they solve different problems: `SidePanel` is
  a fixed-width, dismissible aside with its own header/close button (used by
  `AddWidgetPanel`/`DashboardVersionsPanel`, both dashboards); `SidePanelShell`
  is a resizable, breakpoint-responsive docked-panel frame with a drag/keyboard
  resize handle, explicitly extracted from `ThreadReplyPanel` when
  `AgentScreenPanel` needed the same frame
  (`SidePanelShell.tsx:36-40`). Not a duplicate; no fix needed.
- **`StatusEmojiPicker` (pages/settings/statuses).** Composes
  `components/overlays/Popover` + `components/shared/EmojiPickerPanel`
  correctly rather than reimplementing an emoji grid or its own popover
  dismissal. Clean composition; the only note is the `onChange`/`onSelect`
  naming split already covered in Conventions.
- **`ReviewPanel` (components/features/knowledge).** Named "Panel" but is a
  diff-review content widget with a Publish/Request-changes action row, not a
  side panel or overlay — same generic-suffix looseness as F12 but no
  functional duplicate exists to fix it against; not worth a separate finding.
- **pages/channels/*, pages/project/*, pages/settings/connections/*,
  pages/settings/organization/*, pages/settings/appearance/*,
  pages/settings/push/*, pages/settings/team/* (other than `AvatarPanel`).**
  Verified by import count: every file in these groups has 1 importer, and
  that importer is itself the routed page (or a sub-view chain terminating in
  one routed page) for that same page. These are correctly-scoped
  page-composition sub-views per the doc's "pages hold shells" intent, not
  reuse violations — `pages/settings/settings-shared.tsx` (24 importers,
  all within `pages/settings/`) and `pages/settings/statuses/status-components.tsx`
  (1 importer) are catch-all *names* worth fixing under a naming pass, but
  they are not layering violations: nothing outside `pages/settings/` imports
  them.

## Appendix: full move table

| Current path | Proposed path | Reason | # importers to update |
|---|---|---|---|
| `components/overlays/Card.tsx` | `components/overlays/OverlayCard.tsx` | F6: name collision with `components/shared/Card.tsx` | 1 |
| `layouts/admin-shell/local-back/local-back-registry.ts` | `navigation/local-back-registry.ts` | F2: framework (`navigation/back.ts`) already depends on it upward | ~6 |
| `layouts/admin-shell/local-back/LocalBackContext.tsx` | `navigation/local-back.tsx` | F2: same cluster; consumed by `components/overlays`, `components/features/knowledge`, `components/shared/column-browser` | ~7 |
| `layouts/admin-shell/phone-navigation.ts` | `navigation/phone-navigation.ts` | F2: pure decision logic; `navigation/back.ts` imports it upward today | ~4 |
| `layouts/admin-shell/phone-navigation-gesture.ts` | `navigation/phone-navigation-gesture.ts` | F2: "Pure decision logic" per its own header comment; used by `components/overlays/Sheet.tsx` | 2 |
| `layouts/admin-shell/phone-navigation-ledger.ts` | `navigation/phone-navigation-ledger.ts` | F2: same cluster; `navigation/back.ts` and `navigation/history.ts` depend on it | ~4 |
| `layouts/admin-shell/PhoneBackButton.tsx` | `navigation/PhoneBackButton.tsx` | F11: pure presentational button, consumed by `components/shared/ScreenHeader.tsx` and 4 feature files | 5 |
| `layouts/admin-shell/SidebarRow.tsx` (`sidebarAriaCurrent` export only) | `components/shared/row-a11y.ts` | F11: one-line pure helper used by 9 shell files and 3 feature files | 12 |
| `components/kanban/*` (16 files) | `components/features/projects/kanban/*` | F7: single-feature (projects) directory sitting as a top-level components sibling | 7 |
| `components/desktop/DesktopWindowFrame.tsx`, `desktop-window-adapter.ts` | `layouts/DesktopWindowFrame.tsx`, `layouts/desktop-window-adapter.ts` | F8: one call site (`AppProvider.tsx`); already depends on `layouts/admin-shell` | 1 |
| `pages/settings/MembersRosterPanel.tsx` | `components/features/settings/MembersRosterPanel.tsx` | F4: reused by 2 routed pages, correctly parameterised by `scope` | 2 |
| `pages/settings/MemberDetailsDialog.tsx` | `components/features/settings/MemberDetailsDialog.tsx` | F4: moves with `MembersRosterPanel`, its only importer | 1 |
| `pages/settings/MemberInvitationDialog.tsx` | `components/features/settings/MemberInvitationDialog.tsx` | F4: moves with `MembersRosterPanel`, its only importer | 1 |
| `pages/settings/profile/AvatarPanel.tsx` | `components/features/settings/AvatarPanel.tsx` | F4: reused by 3 different page-level files | 3 |
| `pages/settings/session-device.ts` | `lib/session-device.ts` | F9: pure formatter with a feature-component consumer, zero page coupling | 1 |
| `pages/triggers/useTriggersPageState.ts` | `components/features/triggers/useTriggersPageState.ts` | F9: state hook a feature component needs the shape of | 2 |
| `pages/workflow-designer/useWorkflowTestRun.ts` | `components/features/workflow-designer/useWorkflowTestRun.ts` | F9: same pattern | 2 |
| `pages/channels/useReplyThread.ts` | `components/features/channels/useReplyThread.ts` | F9: same pattern | 4 |
| `components/features/agents/AgentVisibilityPill.tsx` | `components/shared/AgentVisibilityPill.tsx` | F10: pure, provider-free; imported by 3 `shared` files and used across `agents`/`triggers`/`projects`/`knowledge`/`executors`/`members`/`mailbox-connections`/`channels` | ~19 |
| `components/features/agents/agent-scope.ts` | `components/shared/agent-scope.ts` | F10: `getAgentScope` needed alongside `AgentVisibilityPill` by `MemberAgentRow` | 1 |
| `components/features/agents/AgentStatusDot.tsx` | `components/shared/AgentStatusDot.tsx` | F10: pure; consumed by `features/agents`, `features/projects`, `features/channels` | ~6 |
| `components/primitives/AvatarBadges.tsx` | `components/shared/AvatarBadges.tsx` | F5: depends on `providers/PresenceProvider`, breaking primitive purity | 2 (3 if `UserAvatar` moves too) |
| `components/primitives/UserAvatar.tsx` (optional, full fix for F5) | `components/shared/UserAvatar.tsx` | F5: transitively needs `PresenceProvider` via `AvatarBadges`; matches `AgentAvatar`'s precedent | 27 |
| `pages/settings/OrganizationMembersSection.tsx` | delete | F3: zero importers, superseded by `MembersRosterPanel scope="organization"` | 0 |
| `facades/users/organization-members.ts` (3 hooks) | delete if nothing else survives | F3: only consumer was the dead file above | 0 |
| `pages/channels/useCallerCallDialog.ts` | delete | F3: zero importers; live path is `components/features/channels/CallerCallDialog.tsx` | 0 |
| `components/features/workflow-tools/ToolDetailDrawer.tsx` | rename to `ToolDetailSection.tsx` | F12: not an overlay, no `Sheet`/`Dialog` — misnamed | 1 |
| `components/features/agents/designer/DesignerAssistantDrawer.tsx` | rename to `DesignerAssistantDock.tsx` | F12: persistent docked aside, not `Sheet`-based | 1 (mount site) |
