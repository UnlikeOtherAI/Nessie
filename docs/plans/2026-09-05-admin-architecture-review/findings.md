# Findings register

Every finding that survived synthesis, grouped by theme. IDs are
`<audit report>-F<n>` and link to the evidence. Disposition: **fixed** (this
change), **follow-up** (planned, see [fix-plan.md](fix-plan.md)), **decision**
(needs a call from the team), **not a problem** (checked and cleared).

## Table of Contents

- [Defects](#defects)
- [State and providers](#state-and-providers)
- [Layering and placement](#layering-and-placement)
- [Navigation and screen headers](#navigation-and-screen-headers)
- [Data boundary and errors](#data-boundary-and-errors)
- [File size and cohesion](#file-size-and-cohesion)
- [Naming and hygiene](#naming-and-hygiene)
- [Performance](#performance)
- [Tests and docs](#tests-and-docs)
- [Discarded](#discarded)

## Defects

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| [07-F1](audit/07-providers-state.md) | high | `KnowledgeProvider`'s context value is a plain object literal; `useKnowledgePageDeepLink` depends on `openPageDeepLink`, which is recreated every render and calls `setPagePath([...])` with a new array — an unbounded re-render, and in the `?pageId=`-only branch an unbounded `POST` lookup loop. Verified in source. | fixed |
| [07-F3](audit/07-providers-state.md) / [03-F3](audit/03-facades.md) | high | `IncomingCallProvider` opens its own `/api/events/stream` beside the shared fan-out (reproducing the documented presence-flapping bug) to feed `CallRealtimeContext`, which has zero consumers; its `Map`s grow for the session. Verified. | fixed |
| [07-F4](audit/07-providers-state.md) | medium | Two independent agent-realtime WebSockets per tab (`useAdminShell` and `DashboardRealtimeProvider`), each subscribing, pinging and invalidating alone. | fixed |
| [07-F6](audit/07-providers-state.md) | medium | `AuthSessionProvider`'s value memo omits eight of the seventeen functions it publishes; correct today only by transitive dependency. Verified. | fixed |
| [07-F7](audit/07-providers-state.md) | medium | `FocusModeProvider` polls `/api/auth/me` every 15 s and republishes a new object, re-rendering 115 consumers and reverting optimistic sidebar stars in `useStarredItems`. | fixed |
| [04-F3](audit/04-components-layering.md) | high | Dead code: `pages/settings/OrganizationMembersSection.tsx`, its three facade hooks in `facades/users/organization-members.ts`, and `pages/channels/useCallerCallDialog.ts` have zero importers. Verified. | fixed |
| [05-F4](audit/05-pages-routing.md) | high | `ProjectsIndexPage` has no error branch; a failed query renders "No projects yet". | fixed |
| [05-F3](audit/05-pages-routing.md) | high | `OpsHealthPage` returns its refusal before `ScreenHeader`, so a phone user has no Back — the §9 defect class already fixed once elsewhere. | fixed |
| [09-F3](audit/09-boundary-errors-tests.md) | high | 43 of 144 mutation-bearing components surface nothing on failure; no `MutationCache.onError`; six unhandled `void mutateAsync`. | default + gate fixed; 43-file cleanup follow-up |
| [06-F11](audit/06-file-cap-seams.md) | medium | `lib/workflow-designer/serialization.ts` couples its load and save passes through a module-level mutable singleton. | fixed |
| [07-F5](audit/07-providers-state.md) | medium | `eslint-plugin-react-hooks` is a declared dependency but never registered, so `rules-of-hooks`/`exhaustive-deps` never run. Verified. | fixed (wave 3) |
| — (found by CI after 07-F7) | medium | `ConnectedMailCompose` derives a time-based outcome (`sendAfter` in the future → "queued") at render time and had no timer for the moment it elapses; it re-derived only because the 15 s `/me` poll republished a new object and re-rendered the whole tree. Stopping that churn (07-F7) exposed it: the connected-mail e2e stalled on "queued". | fixed (explicit timer; the suite passed on `main` by accident) |

## State and providers

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| [07-F2](audit/07-providers-state.md) | high | `KnowledgeProvider` is the "one Context per entity" shape §4 forbids and duplicates URL state (`spaceId`, `productView`) by effect. | split into navigation + mutation hooks and memoised now; URL-state rewrite follow-up |
| [07-F8](audit/07-providers-state.md) | medium | Five context values rebuilt every render (`Knowledge`, `AccountMenu`, `MobileNav`, `ShellActions`, `ColumnBack`). | fixed |
| [07-F9](audit/07-providers-state.md) | medium | `src/providers` mixes 9 real contexts with 7 render-nothing bridges and a mis-named `NotificationsProvider`. | fixed (wave 2 move to `src/bridges/`) |
| [07-F10](audit/07-providers-state.md) | medium | Six shell contexts where two would do; `AdminShellOutletContext` names a mechanism that no longer exists. | fixed (three collapsed into `ShellStateContext`) |
| [07-F11](audit/07-providers-state.md) | low | `ShellEnvironmentProvider` is half-adopted (two consumers, one field). | decision |
| [07-F12](audit/07-providers-state.md) | low | Four copies of "server preference mirrored into `useState`", one unprotected. | follow-up (`usePreference`) |
| [07-F13](audit/07-providers-state.md) | low | Font scale has no first-paint bootstrap in `index.html`, unlike theme. | fixed |
| [05-F8](audit/05-pages-routing.md) / [05-F9](audit/05-pages-routing.md) | medium | `StatusesPage` (25 `useState`, four forms) and `NotificationsPage` (11 fields hydrated by a ref-guarded effect). | fixed (split; preferences form keyed by user id) |
| [05-F5](audit/05-pages-routing.md) / [05-F11](audit/05-pages-routing.md) / [08-F5](audit/08-navigation-dependency-rules.md) | medium | Selection/search state in `useState`/`location.state` on `WorkflowsPage`, `TriggersPage`, and two hand-rolled `useSearchParams` tab strips (`MembersRosterPanel`, `ConnectedMailPage`) the tab gate cannot see. | fixed |
| [03-F7](audit/03-facades.md) | low | Optimistic updates exist in 3 facades but are undocumented as a pattern. | fixed (documented) |

## Layering and placement

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| [08-F14](audit/08-navigation-dependency-rules.md) | medium | No layering enforcement; 60 imports run backwards (components→layouts 21, facades→components 12, lib→up 6, navigation→layouts 5, providers→components 4, components→pages 4, shared→features 4, primitives→up 2). | fixed (`scripts/lint-admin-layers.mjs` + four moves delete 33 edges; residual seeded) |
| [04-F2](audit/04-components-layering.md) | high | `navigation/back.ts` imports the local-back registry and phone-navigation ledger from `layouts/admin-shell` — the framework depends on the shell. | fixed (modules moved into `navigation/`) |
| [04-F11](audit/04-components-layering.md) | medium | `PhoneBackButton`, `PhoneNavigationButton`, `sidebarAriaCurrent` consumed from `components/` but live in `layouts/admin-shell`. | fixed (moved) |
| [03-F6](audit/03-facades.md) | medium | Facades import from `components/`: `useIsOwner` (5), designer types (3), `AgentMention` via `MentionInput` (1), apps connect helpers (3). | fixed (moved down) |
| [04-F10](audit/04-components-layering.md) | medium | `AgentVisibilityPill`, `agent-scope`, `AgentStatusDot` are pure and used by three features and three shared files but live in `features/agents`. | fixed (moved to shared) |
| [04-F5](audit/04-components-layering.md) | medium | `AvatarBadges` (primitive) depends on `PresenceProvider`. | fixed (moved to shared) |
| [04-F9](audit/04-components-layering.md) / [05-F10](audit/05-pages-routing.md) | medium | Four components import from `pages/` (`session-device`, `useTriggersPageState`, `useWorkflowTestRun`, `useReplyThread`). | fixed (moved) |
| [04-F4](audit/04-components-layering.md) | medium | `MembersRosterPanel` (+ two dialogs) and `AvatarPanel` are multi-page reuse stranded in `pages/settings`. | fixed (moved to `features/settings`) |
| [04-F7](audit/04-components-layering.md) / [04-F8](audit/04-components-layering.md) | medium | `components/kanban` (projects-only) and `components/desktop` (one caller) pose as top-level layers. | fixed (moved) |
| [01-F3](audit/01-naming-placement.md) | high→re-scoped | "81 non-routed files in `pages/`" — the layering audit checked importer counts: single-consumer page sub-views are correctly scoped; only the reused ones move. | fixed for the reused set; rest not a problem |
| [01-F5](audit/01-naming-placement.md) | medium | Four loose files at the root of `src/facades`. | fixed (moved) |
| [08-F9](audit/08-navigation-dependency-rules.md) | medium | Two facades navigate on mutation success (`team/invitations`, `team/provisioning`, `channels/dm-navigation`). | follow-up |

## Navigation and screen headers

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| [08-F2](audit/08-navigation-dependency-rules.md) / [05-F2](audit/05-pages-routing.md) | high | `ColumnBrowserColumn` gives four routes (`/agents/tools`, `/agents/triggers`, `/agents/workflows`, integrations) an `h3` bar with an arbitrary `ReactNode` action slot and no title publication; the header gate walks `pages/**` only. | fixed (+ gate widened) |
| [08-F3](audit/08-navigation-dependency-rules.md) | high | `ConversationInfoFlow` is the bespoke 58 px header §9 deleted, inside `components/`. | fixed |
| [08-F4](audit/08-navigation-dependency-rules.md) | high | `SidePanelShell` is a third overlay family (three consumers, breakpoint branching, no Back registration, no Escape in one). | follow-up (needs an overlay-band design) |
| [08-F1](audit/08-navigation-dependency-rules.md) | high | The `navigate()` admission gate is permanently off because `PhoneNavigationApi` has no `push`; 143 call sites in 72 files sit outside the controller. | follow-up (L; plan item added to §16) |
| [08-F7](audit/08-navigation-dependency-rules.md) | medium | One hand-rolled `role="dialog"` emoji menu written twice; two of three bespoke-dialog allowlist entries. | fixed (`EmojiReactionButton`) |
| [08-F8](audit/08-navigation-dependency-rules.md) | medium | `useReplyThread` keeps the geometry `useSidePanelGeometry` was extracted to unify. | fixed |
| [08-F10](audit/08-navigation-dependency-rules.md) | medium | `flowPresentation` is declared and never read. | fixed (deleted) |
| [08-F11](audit/08-navigation-dependency-rules.md) | medium | Surface lint checks router→registry only; 14 paths match two rows, first-match-wins, order unasserted. | fixed (shadow assertion) |
| [05-F6](audit/05-pages-routing.md) | medium | Three entitlement-gate shapes; super-admin check is ad hoc inline. | fixed (`SuperAdminGate`) |
| [08-F12](audit/08-navigation-dependency-rules.md) | low | `WorkflowDesignerHeader` renders `ResponsivePageHeader` directly (no `h1`, no title). | fixed (sanctioned in §9 with reason) |
| [05-F7](audit/05-pages-routing.md) | low | Route paths declared twice (router string + registry regex) — a tested, deliberate trade-off. | decision |

## Data boundary and errors

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| [03-F1](audit/03-facades.md) / [09-F2](audit/09-boundary-errors-tests.md) | high | `ChannelRecord`, `AgentRecord`, `ProjectRecord`, `TeamRecord` are hand-written in `client-core/api-types.ts` beside canonical zod schemas, and have drifted (`metadata` client-only, `lastMessageAt` optionality, branded ids erased, `voiceName` widened). | follow-up (touches the shared package and desktop/mobile) |
| [09-F1](audit/09-boundary-errors-tests.md) / [03-F4](audit/03-facades.md) | high | Responses are cast, not parsed: 18 parse sites against ~428 calls; `ApiErrorSchema` unused on the client. | follow-up (schema-by-schema, `executors` facade is the template) |
| [09-F4](audit/09-boundary-errors-tests.md) | medium | Twelve local `errorMessage` helpers discard `code`/`details`; two structural casts to reach `ApiClientError` fields. | fixed (`formErrorMessage`) |
| [09-F8](audit/09-boundary-errors-tests.md) | medium | `FormField` documents a `useFormSubmit` hook that does not exist; label markup hand-rolled beside kit inputs. | hook fixed; conversions follow-up |
| [03-F2](audit/03-facades.md) | medium | Five facades keep private query-key factories invisible to the invariant test. | fixed (per-facade `keys.ts`, test globs them) |
| [03-F5](audit/03-facades.md) | low | `facades/agents/keys.ts` holds WebSocket helpers, not keys. | fixed (renamed) |

## File size and cohesion

| ID | File (lines) | Seam | Disposition |
|---|---|---|---|
| [06-F1](audit/06-file-cap-seams.md) | `AdminSidebarNav.tsx` (599) | `ADMIN_NAV` table → `admin-nav-items.tsx` (precedent: `nav-items.tsx`) | fixed |
| [06-F5](audit/06-file-cap-seams.md) | `ProjectsSidebarNav.tsx` (675) | `ProjectSectionRows`, `ProjectRow`, `ProjectsNavDialogs`, expansion cookies; shared `useSidebarRowMenu` with `SidebarProjectsSection` | fixed |
| [06-F6](audit/06-file-cap-seams.md) | `StatusesPage.tsx` (589) | `StatusScheduleForm`, `StatusRuleForm` | fixed |
| [06-F4](audit/06-file-cap-seams.md) | `NotificationsPage.tsx` (508) | `BrowserNotificationsSection`, `NotificationPreferencesForm` | fixed |
| [06-F8](audit/06-file-cap-seams.md) | `ResponsivePageHeader.tsx` (547) | `useResponsivePageHeaderOverflow` | fixed |
| [06-F3](audit/06-file-cap-seams.md) | `MentionInput.tsx` (541) | `mention-input-dom.ts`, `MentionEntityAvatar`, `MentionSuggestionList` | fixed |
| [06-F2](audit/06-file-cap-seams.md) | `ChannelMessageFeed.tsx` (506) | `useCollapsedFeedDates`, `ChannelLiveStreamTail` | fixed |
| [06-F9](audit/06-file-cap-seams.md) | `KnowledgeProvider.tsx` (511) | `useKnowledgeNavigation`, `useKnowledgeMutations` | fixed |
| [06-F10](audit/06-file-cap-seams.md) | `AuthSessionProvider.tsx` (597) | `useSessionRestoration`, `useTeamSessionRecovery` | fixed |
| [06-F11](audit/06-file-cap-seams.md) | `serialization.ts` (598) | `canvas-structure`, `template-parsing`, `graph-serialization`; singleton → explicit parameter | fixed |
| [06-F7](audit/06-file-cap-seams.md) | `WorkflowsPage.tsx` (568) | `WorkflowFailedRunsColumn`, `WorkflowsListColumn` | fixed |
| [06-F13](audit/06-file-cap-seams.md) | `lib/query-keys.ts` (596) | per-domain seam documented | fixed (per-facade `keys.ts`; central file keeps `paginationKeys`) |
| [06-F12](audit/06-file-cap-seams.md) | `ChannelsPage.tsx` (615) | composition root; needs a prop-contract decision for its two consumers | decision |
| [06-F14](audit/06-file-cap-seams.md) | `voice-call-client.ts` (528) | one stateful socket controller; needs a connection-handle design | decision |

## Naming and hygiene

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| [01-F2](audit/01-naming-placement.md) | high | Six catch-all files (`channel-helpers`, `thread-panel-helpers`, `document-stream-helpers`, `settings-shared`, `push/shared`, `status-components`). | fixed (renamed/split by responsibility) |
| [01-F1](audit/01-naming-placement.md) | medium | Three `use-x.ts` hooks beside `useX.ts`. | fixed |
| [01-F7](audit/01-naming-placement.md) / [04-F6](audit/04-components-layering.md) | medium | Two `Card.tsx`. | fixed (`OverlayCard`) |
| [04-F12](audit/04-components-layering.md) | low | Two "Drawer"s are not overlays. | fixed (renamed) |
| [04-F1](audit/04-components-layering.md) | high | `TriggerTypePicker` reinvents `ChoiceGroup`'s fake-radio grid, reintroducing the keyboard bug. | fixed |
| [02-F1](audit/02-escape-hatches.md) / [02-F2](audit/02-escape-hatches.md) | high | 22 hex literals in the workflow designer; named Tailwind colours in `PhoneBackButton`, `FileNodeViewer`. | fixed (existing semantic tokens; no new tokens) |
| [02-F3](audit/02-escape-hatches.md) | high | All 28 z-index allowlist files still offend. | follow-up (per-file conversion) |
| [02-F7](audit/02-escape-hatches.md) | medium | `window.prompt` in `RichTextEditor`, `window.alert` in `ProjectsSidebarNav`. | fixed |
| [02-F9](audit/02-escape-hatches.md) | medium | Timers without cleanup in 11 files (claim; each verified at fix time). | fixed where a lifecycle owns the timer |
| [02-F5](audit/02-escape-hatches.md) | medium | Non-null assertions where a guard would narrow. | fixed |
| [02-F6](audit/02-escape-hatches.md) | medium | 14 files read `localStorage` directly outside `lib/storage.ts`. | follow-up |
| [02-F11](audit/02-escape-hatches.md) | low | Date/number formatting scattered across ~40 sites. | follow-up |
| [08-F15](audit/08-navigation-dependency-rules.md) | low | No `@/` alias: only 62 of 3589 imports reach depth 4. Four redundant `useMediaQuery` eslint `paths` entries. | alias rejected; eslint cleanup fixed |

## Performance

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| [05-F1](audit/05-pages-routing.md) / [09-F5](audit/09-boundary-errors-tests.md) | high | Every route eagerly imported; one 2.58 MB entry chunk; only three lazy boundaries. | fixed (route-level `lazy`) |
| [09-F6](audit/09-boundary-errors-tests.md) | medium | 242 `useMemo` / 290 `useCallback` against 1 `memo`; no React Compiler; no windowing. | decision (compiler) |

## Tests and docs

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| [09-F7](audit/09-boundary-errors-tests.md) | medium | 26 % of tests are source-regex gates; the directory-walking ones are healthy, the exact-string ones brittle. | follow-up (triage) |
| [09-F9](audit/09-boundary-errors-tests.md) | low | Route changes move no focus and announce nothing; one `matchMedia` reduced-motion bypass. | bypass fixed; route focus follow-up |
| [08-F6](audit/08-navigation-dependency-rules.md) / [08-F12](audit/08-navigation-dependency-rules.md) / [08-F13](audit/08-navigation-dependency-rules.md) | medium | Docs drift: overlays carve-out list three entries stale; `architecture.md` names deleted `AdminPageHeader`; §1 tab-exception count wrong. | fixed |
| — | — | `docs/provider-system-and-frontend-architecture.md` §5.2 prescribes a facade shape one facade follows. | fixed (rewritten to the real convention) |

## Discarded

- [02-F10](audit/02-escape-hatches.md) "listeners without cleanup in seven
  providers": every cited file has a matching `removeEventListener` count;
  false positive.
- [02-F7](audit/02-escape-hatches.md) part: `DeviceLinkDialog.tsx:221`
  `confirm()` is a local callback, not the browser dialog.
- [01-F3](audit/01-naming-placement.md) as stated (move all 81 files): see
  the re-scoped row above.
- [02](audit/02-escape-hatches.md) "Not a problem" claim that SVG cannot read
  CSS custom properties: incorrect, but moot — the fix reuses existing tokens
  via `var()`.
