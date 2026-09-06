# Providers, React context and client state architecture

## Verdict

The identity layer is genuinely single-source and unusually disciplined — one
`AuthSessionProvider`, one `MeResponse`, one token store, with token renewal,
terminal logout, query reset and external auth already split into siblings that
the provider only wires. Everything above that line has accreted: an
authenticated Knowledge page sits inside **21 React contexts** where
`docs/provider-system-and-frontend-architecture.md` §5.1 names five (plus two
optional), and one of them — `KnowledgeProvider` — is exactly the "one Context
per entity" shape §4 forbids, holding URL state and TanStack cache in a third
copy. Roughly a third of `src/providers` (7 of 21 `.tsx`) are not providers at
all but side-effect components that render nothing or children, and there is no
`eslint-plugin-react-hooks` wired despite it being a declared dependency, which
is why five context values are rebuilt on every render and one `useMemo` has
eight missing dependencies.

## Findings

### F1. `useKnowledgePageDeepLink` + the unmemoized `KnowledgeProvider` value form an unbounded re-render / refetch loop on any `?pageId=` deep link

- Severity: high
- Category: state
- Evidence:
  - `admin/src/components/features/knowledge/KnowledgeProvider.tsx:445` — `const value: KnowledgeContextValue = { ... }`, a plain object literal, no `useMemo`; every function on it (`openPageDeepLink` at `:352`, `selectSpace` at `:276`, `savePage` at `:388`, …) is re-created on every provider render.
  - `admin/src/components/features/knowledge/useKnowledgePageDeepLink.ts:49` — the effect's dependency array is `[openPageDeepLink, pageId, serial, spaceId]`.
  - `admin/src/components/features/knowledge/KnowledgeProvider.tsx:362` — `openPageDeepLink` calls `setPagePath([input.pageId])`, allocating a **new array** every call.
  - `admin/src/navigation/intent.ts:5-19` and the comment at `useKnowledgePageDeepLink.ts:30-32` — the captured intent values are held in component state and survive the URL strip, so `pageId` stays truthy for the life of the mount.
- Why it matters: after a deep link lands, `openPageDeepLink` runs → `setPagePath(new array)` → provider re-renders → new `value` object → new `openPageDeepLink` identity → the effect's deps changed → it runs again. Nothing breaks the cycle. In the `?pageId=`-only branch (`:34-42`) the loop is worse: it re-issues `pageLookup.mutateAsync(pageId)` on every iteration, so a single "Open page" link from an approval or a DeepWater run turns into an unbounded POST loop against the API.
- Fix: wrap the context value in `useMemo` in `KnowledgeProvider.tsx:445` and wrap every callback it exposes in `useCallback` (or move them into a reducer whose `dispatch` is stable). Independently, key the effect in `useKnowledgePageDeepLink.ts` on `serial` alone (as the file's own comment already argues for `pageLookup`) rather than on the callback identity, and make `setPagePath` bail when the path is unchanged.
- Fix size: S
- Risk: memoizing the value can expose consumers that were accidentally relying on a fresh object each render; `admin/test/knowledge-displayed-space.test.ts`, `knowledge-page-editor.test.ts` and `knowledge-local-back.test.ts` plus a manual `/knowledge-base?pageId=…` open (watch the network panel) prove the fix.

### F2. `KnowledgeProvider` is the "one Context per entity" anti-pattern §4 forbids, and its navigation state duplicates the URL

- Severity: high
- Category: state
- Evidence:
  - `docs/provider-system-and-frontend-architecture.md:82-103` — "Do not create a React Context provider for every entity"; `:112-127` lists the five permitted app providers.
  - `admin/src/components/features/knowledge/KnowledgeProvider.tsx:42-125` — a 84-line context value carrying spaces, pages, pagination, editor state, history state and 11 mutations.
  - `admin/src/components/features/knowledge/KnowledgeProvider.tsx:180-186` — `selectedSpaceId`, `pagePath`, `openPageId`, `editor`, `historyPageId`, `spaceSettingsOpen`, `activeProductView` in `useState`.
  - `admin/src/router.tsx:228,232,236` — the routes are already `/knowledge-base`, `/knowledge-base/spaces/:spaceId`, `/knowledge-base/views/:productView`.
  - `admin/src/pages/KnowledgeBasePage.tsx:28-38` — two effects whose whole job is to push the route params **into** the context state, i.e. the URL is authoritative and the context is a second copy synced by effect.
  - `admin/src/layouts/AdminShellLayout.tsx:406-410` — the shell mounts it for the whole knowledge route, so the sidebar (`KnowledgeSidebarNav`) and the page share it.
- Why it matters: three stores hold the same facts (URL, context state, TanStack cache). §6.2 forbids "hidden parallel stores for the same records", and the effect-based sync is what makes F1 possible. It is also 511 lines, over the 500-line cap.
- Fix: delete the state that the URL already owns. `selectedSpaceId` becomes `useParams().spaceId` (with the section root resolving to "first space" in a selector), `activeProductView` becomes `useParams().productView`, `pagePath`/`openPageId` become a `?path=`/`?pageId=` search-param pair read through `useSearchParams`. What remains — `editor`, `historyPageId`, `spaceSettingsOpen` — is genuinely ephemeral UI state and belongs in `KnowledgeWorkspace` local state or its own tiny overlay context. Replace the data half of the context with `useKnowledgeSpaces` / `useKnowledgePages` / the mutation hooks that already exist in `admin/src/facades/knowledge/hooks.ts`, called directly by the 9 consumers, plus one `admin/src/facades/knowledge/selectors.ts` for `pagesById`/`pagesByParent`/`validPath` (currently `KnowledgeProvider.tsx:232-264`). The provider then disappears from `AdminShellLayout.tsx:406`.
- Fix size: L
- Risk: the `spaceId`/`agentId`/`projectId` scoping props (`:155-165`, used by `AgentDocumentsTab` and `ProjectDocsTab`) must survive as explicit hook arguments; the knowledge e2e specs and the six `admin/test/knowledge-*.test.ts` files are the proof.

### F3. Two SSE connections to `/api/events/stream` per signed-in tab, and the second one feeds a context nobody reads

- Severity: high
- Category: data-flow
- Evidence:
  - `admin/src/facades/realtime/event-stream.ts:1-10,29-36,61,127-154` — the shared, ref-counted connection with a fanout; its header comment states that duplicate connections previously caused presence flapping because "the route marks presence per connection".
  - Four subscribers on it: `admin/src/facades/calls/hooks.ts:77`, `admin/src/facades/alerts/hooks.ts:172`, `admin/src/facades/threads/activity-hooks.ts:137`, `admin/src/facades/notifications/useMessageNotifications.ts:469`.
  - `admin/src/providers/IncomingCallProvider.tsx:211` — a second, hand-rolled `fetch('${getBaseUrl()}/api/events/stream')` with its own `runStreamConnectionLoop`, mounted in `RootLayout` (`admin/src/layouts/RootLayout.tsx:13`) for every route. Its own doc comment at `:151-155` calls it "the fourth, deliberately independent user-SSE reader".
  - `admin/src/facades/calls/realtime-context.ts:14-16` — `CallRealtimeContext` / `useCallRealtime`. `grep -rn useCallRealtime src` returns **only the definition**: zero consumers.
  - `admin/src/facades/calls/incoming-call-reducer.ts:87-103` — `inviteUpdates` and `updates` are `Map`s that only grow, and `IncomingCallProvider.tsx:351-354` memoizes them into that dead context.
- Why it matters: one tab opens two SSE connections plus two WebSockets (F4), and the second SSE reader exists partly to populate state that no component consumes while the maps leak for the lifetime of the session. The presence-per-connection hazard the shared bus was built to fix is still live.
- Fix: move the incoming-call reader onto the shared bus — replace `IncomingCallProvider.tsx:197-249` with `useEventStream({ enabled: Boolean(token && currentUserId), onFrame })` using the existing `parseIncomingCallEvent`; the `connection.resumed` flag the fanout already passes (`event-stream-fanout.ts:17-20`) is exactly the `reconnecting` signal the current loop derives from `lastEventId`. Then delete `admin/src/facades/calls/realtime-context.ts`, the `inviteUpdates`/`updates` maps from `incoming-call-reducer.ts`, and the `CallRealtimeContext.Provider` wrapper.
- Fix size: M
- Risk: ring-verification-on-reconnect semantics; `admin/test/shared-event-stream.test.ts` and `call-provider-settings.test.ts` cover the seams, plus an e2e that rings a call after a reconnect.

### F4. Two independent WebSockets are opened from the same shell render, because `useAgentRealtime` has no shared connection

- Severity: medium
- Category: data-flow
- Evidence:
  - `admin/src/facades/agents/realtime.ts:29,60,316` — the socket is created inside the hook's own `useEffect`; there is no module-level singleton (contrast `event-stream.ts:36` `let active`).
  - Call site 1: `admin/src/layouts/admin-shell/useAdminShell.ts:90` (channel/thread scopes), mounted by `AuthenticatedAdminShellLayout`.
  - Call site 2: `admin/src/components/features/dashboards/DashboardRealtimeProvider.tsx:49`, which wraps that same component (`admin/src/layouts/AdminShellLayout.tsx:369`).
- Why it matters: `DashboardRealtimeProvider`'s own header comment says it exists so state lives "on one authenticated socket rather than opening a socket per card" — but it achieves that by opening a *second* app-wide socket beside the shell's. Both sockets subscribe, ping, back off and invalidate the same query keys independently. Total realtime transports per tab: 2 SSE + 2 WS.
- Fix: give `facades/agents/realtime.ts` the same module-level connection + scope-registry shape `facades/realtime/event-stream.ts` already has — one socket, subscribers register `{channelIds, dashboardIds, threadId}` and the connection sends the union. `DashboardRealtimeProvider` then keeps only its `register`/`connectionState` API and stops owning a transport.
- Fix size: M
- Risk: subscription-union churn could cause resubscribe storms; the handshake/backoff logic at `realtime.ts:290-340` needs its existing tests plus a new one asserting one socket for two hooks.

### F5. `eslint-plugin-react-hooks` is a declared dependency but is not wired into the flat config, so `exhaustive-deps` never runs

- Severity: medium
- Category: structure
- Evidence:
  - `package.json:33` — `"eslint-plugin-react-hooks": "^7.0.1"`.
  - `grep -c 'react-hooks\|reactHooks' eslint.config.js` → `0`; the string does not appear anywhere under `admin/` either.
  - Consequences visible in this dimension: `admin/src/providers/AuthSessionProvider.tsx:550-581` (see F6), and the five unmemoized context values in F8.
- Why it matters: the repo already ratchets z-index, viewport classification and `useMediaQuery` through custom lint rules (`eslint.config.js:126-175`); the one off-the-shelf rule that would catch this dimension's whole class of defect is installed and inert.
- Fix: register the plugin in `eslint.config.js` for `admin/src/**/*.{ts,tsx}` with `react-hooks/rules-of-hooks: error` and `react-hooks/exhaustive-deps: warn`, then fix or explicitly `eslint-disable-next-line` the existing hits (expect a bounded list — the codebase already has only 5 `eslint-disable`s).
- Fix size: M
- Risk: a large first-run warning count; land it as `warn` and ratchet.

### F6. `AuthSessionProvider`'s context `useMemo` omits eight of the seventeen values it publishes

- Severity: medium
- Category: state
- Evidence: `admin/src/providers/AuthSessionProvider.tsx:550-581` — the value object lists `applyMeResponse, bootstrap, devLogin, login, logout, recoveryExchange, switchContext, switchUoaTeam` but the dependency array (`:570-580`) contains none of them. Those eight are plain `const fn = …` declarations (`:406,414,420,438,443,505,515,525`), re-created every render and captured stale by the memo.
- Why it matters: it is currently *accidentally* correct — `reconcileSession` (`:244-259`) and `refreshAccessToken` (`:261-279`) both depend on `sessionMutations`, so a coordinator-generation bump (`:197,234-236`) invalidates the memo transitively and refreshes the stale closures. Nothing states that invariant, and it is the single most safety-critical object in the app: a future change that stops `reconcileSession` depending on `sessionMutations` silently pins `logout`/`switchUoaTeam` to a retired coordinator.
- Fix: wrap all eight in `useCallback` with real dependencies and list them in the memo — mechanical, and F5's lint rule would then hold the line.
- Fix size: S
- Risk: low; the session-mutation suites plus `admin/test/auth-session-query-reset.test.ts` cover the coordinator handover.

### F7. `FocusModeProvider` polls `/api/auth/me` every 15 s and republishes a fresh `MeResponse`, re-rendering all 115 `useAuthSession` consumers and reverting optimistic sidebar state

- Severity: medium
- Category: performance
- Evidence:
  - `admin/src/providers/FocusModeProvider.tsx:24` `FOCUS_MODE_SYNC_INTERVAL_MS = 15_000`; `:45-56` fetches `/api/auth/me` and calls `applyMeResponse(nextMe)` unconditionally; `:58-74` runs it on an interval plus `focus` and `visibilitychange`.
  - `admin/src/providers/AuthSessionProvider.tsx:406-412` — `applyMeResponse` does `setMe(nextMe)` with no structural equality check; `isCurrentSessionResponse` (`admin/src/providers/auth-session-query-reset.ts:33-36`) only checks the tenant boundary.
  - 115 call sites of `useAuthSession()` across `src` (52 of them destructuring only `token`).
  - Downstream drift: `admin/src/layouts/admin-shell/useStarredItems.ts:80-82` — `useEffect(() => setStarred(initialStarred), [initialStarred])`, where `initialStarred` is memoized on `me?.user.preferences?.starred` (`useAdminShell.ts:107-110`). A star toggled optimistically at `useStarredItems.ts:97-106` is overwritten the moment the 15 s poll lands a `me` that predates the PATCH, and a failed PATCH is never rolled back at all.
- Why it matters: a whole-tree re-render every 15 s while the tab is visible, purely to learn one boolean; and it makes a visible sidebar state flicker/revert.
- Fix: (a) in `applyMeResponse`, bail when the incoming response is deep-equal to the current one (or compare a server-provided revision), so identity only changes on real change; (b) replace the bespoke poll with a `useQuery` on `authKeys.me` with `refetchInterval` inside `facades/auth/hooks.ts`, so the cache — not a provider — owns the polling and dedupes with other readers; (c) drop the `starred` mirror in `useStarredItems.ts` and read it from `me` directly, doing the optimistic update via the mutation's `onMutate`/`onError` rollback in `useUpdatePreferences`.
- Fix size: M
- Risk: focus-mode latency across devices; the focus-mode e2e and a new test asserting `me` identity stability across an unchanged `/me` response.

### F8. Five context values are object literals rebuilt on every render, three of them read by every page header

- Severity: medium
- Category: performance
- Evidence:
  1. `admin/src/components/features/knowledge/KnowledgeProvider.tsx:445` — the 60-key knowledge value (9 consumer files, incl. `KnowledgeSidebarNav`). Worst: it also causes F1.
  2. `admin/src/layouts/admin-shell/AccountMenuContext.tsx:20` — `value={{ onLogout, showHeaderAccountMenu }}`, consumed by `admin/src/components/shared/ResponsivePageHeader.tsx:195`, which 27 files render.
  3. `admin/src/layouts/AdminShellLayout.tsx:381` — `<MobileNavProvider value={{ openDrawer: shell.openMobileDrawer }}>`, consumed by `PhoneNavigationButton` (11 files).
  4. `admin/src/layouts/AdminShellLayout.tsx:174-178` + `:393` — `shellActions` built inline and handed to `ShellActionsProvider`.
  5. `admin/src/components/shared/column-browser/ColumnBrowserViewport.tsx:109,124,176` — `<ColumnBackProvider value={{ index, reportBack }}>` inside a per-column render loop.
- Why it matters: `AuthenticatedAdminShellLayout` re-renders on every location change, every realtime frame that invalidates a shell query, and every 15/20/25 s poll; each of those re-renders forces every `ResponsivePageHeader` and every `PhoneNavigationButton` in the tree to re-render even though the underlying booleans never moved.
- Fix: `useMemo` the value in each of the five sites (and `useCallback` the functions they carry). For `ColumnBrowserViewport` hoist the per-index value into the column component with `useMemo(() => ({index, reportBack}), [index, reportBack])`.
- Fix size: S
- Risk: none functional; React DevTools profiler on a channel navigation is the check.

### F9. `src/providers` conflates five app-wide contexts with seven render-nothing side-effect components and three shell/UI contexts

- Severity: medium
- Category: structure
- Evidence: `admin/src/providers/` holds 21 `.tsx`. Only 9 create a context. Seven render nothing or pass children through: `AttentionDisplayManager.tsx:70 return null`, `PushSurfacePresenceHeartbeat.tsx:169 return null`, `ExternalAuthRouterBridge.tsx:30 return null`, `NativeShellBridge.tsx`, `DirectDesktopUpdatePrompt.tsx`, `NotificationsProvider.tsx:66 return <>{children}</>`, `IncomingCallProvider.tsx` (a dialog + a dead context). Three more contexts live in `admin/src/layouts/admin-shell/` (`AccountMenuContext`, `MobileNavContext`, `ShellActionsContext`, `TransientMenuContext`) and one in `admin/src/components/features/knowledge/`.
- Why it matters: `docs/provider-system-and-frontend-architecture.md:1-16` opens by insisting the two meanings of "provider" must not be conflated; the directory now means "anything mounted near the root". `NotificationsProvider` provides nothing (its own docstring at `:18-22` says the stack lives in `ToastProvider`), and `AttentionDisplayManager` is correctly *not* named a provider while sitting in the same folder as things that are.
- Fix: split the directory. `src/providers/` keeps only what creates an app-wide context (`AuthSession`, `ApiClient`, `Query`, `Theme`, `ShellEnvironment`, `Toast`, `AgentIdentity`, `Presence`, `FocusMode`, `FontScale`). Move the render-nothing bridges to `src/bridges/` (or `src/shell/effects/`) and rename `NotificationsProvider` → `MessageNotificationBridge`. Keep the shell contexts where they are but consolidate them per F10.
- Fix size: M
- Risk: import churn only; typecheck proves it.

### F10. Six shell contexts where two would do; `ShellActionsContext` still carries the "OutletContext" name of the mechanism it replaced

- Severity: medium
- Category: structure
- Evidence:
  - `AccountMenuContext.tsx` (2 fields, 1 consumer), `MobileNavContext.tsx` (1 field, 1 consumer), `ShellActionsContext.tsx` (3 callbacks, 1 consumer: `admin/src/pages/ChannelsPage.tsx:64`), `TransientMenuContext.tsx` (5 fields, 7 consumers), `local-back/LocalBackContext.tsx` (2 contexts in one file: `LocalBackRegistryContext` and `ColumnBackContext`), `PhoneNavigationProvider.tsx` (1 field-rich API, 12 consumers), `FocusModeProvider` (11 consumers, lives in `providers/`).
  - `admin/src/layouts/AdminShellLayout.tsx:368-458` nests eight providers in one JSX ladder, three of them with a single consumer each.
  - `admin/src/layouts/admin-shell/ShellActionsContext.tsx:8` types the context as `AdminShellOutletContext`; `grep useOutletContext src` returns nothing — the outlet mechanism is gone (`AdminShellLayout.tsx:172` uses `useOutlet()`), but the type name still says "Outlet".
  - The good exemplar already exists in the same directory: `local-back/LocalBackContext.tsx:25-53` uses a `useSyncExternalStore` registry, so a registration does not re-render the tree.
- Why it matters: three of these contexts exist only to move one prop past `<Outlet/>`, and each costs a provider layer on every authenticated render (F8).
- Fix: collapse `AccountMenuContext` + `MobileNavContext` + `ShellActionsContext` into one `ShellStateContext` in `layouts/admin-shell/ShellStateContext.tsx` with a `useMemo`d value (`onLogout`, `showHeaderAccountMenu`, `openDrawer`, `onCreateAgent`, `onCreateChannel`, `onSelectAgent`). Rename `AdminShellOutletContext` → `ShellActions` in `layouts/admin-shell/types.ts:59`. Leave `TransientMenuContext`, `PhoneNavigationProvider` and `LocalBackProvider` as they are — each has a real, distinct lifetime. If the combined value proves render-hot, follow `LocalBackContext`'s `useSyncExternalStore` pattern instead of a context.
- Fix size: M
- Risk: `ResponsivePageHeader` and `PhoneNavigationButton` must keep their off-shell null-safe reads (`MobileNavContext.tsx:13`, `AccountMenuContext.tsx:26`); the component tests that render headers in isolation are the guard.

### F11. `ShellEnvironmentProvider` is an app-wide provider with two consumers, both reading one field

- Severity: low
- Category: structure
- Evidence: `admin/src/providers/ShellEnvironmentProvider.tsx:71-91` (provider + `deriveShellEnvironment` + `WEB_ENVIRONMENT`, 91 lines, plus `admin/test/shell-environment.test.ts`), mounted outermost at `admin/src/providers/AppProvider.tsx:18`. `grep -rn useShellEnvironment src` → `admin/src/layouts/admin-shell/TopBar.tsx:39` and `admin/src/components/features/executors/ExecutorDesktopCompanionPanel.tsx:79`, both destructuring only `desktopPlatform`, which `readDesktopPlatform()` (`admin/src/lib/desktop.ts`) already returns synchronously. Its own header comment (`:5-9`) concedes "pages keep using today's hooks until the Phase-4 call-site migration".
- Why it matters: AGENTS.md's "no premature abstraction" — an app-wide provider staged for a migration that has not happened, paying a render layer for two `desktopPlatform` reads.
- Fix: either finish the migration (replace `useMobileLayout`/`useNativeIPadApp`/`isReactNativeWebView` call sites in `AdminShellLayout.tsx:141-150` with `useShellEnvironment()` fields) or drop the provider and let the two call sites use `readDesktopPlatform()`. Do not leave it half-adopted.
- Fix size: S (drop) / L (finish)
- Risk: the native form-factor branch in `deriveShellEnvironment:44-55` is the only place that reads `nativeFormFactor`; keep its test if the provider survives.

### F12. Three user preferences implement the same "server value mirrored into `useState`, synced by effect" pattern three different ways

- Severity: low
- Category: reuse
- Evidence:
  - `admin/src/providers/FocusModeProvider.tsx:34-43` — `serverFocusModeEnabled` → `useState` → `useEffect` sync, plus a bespoke `localChangeVersion`/`localChangeInFlight` ref pair for in-flight protection (`:38-39,76-96`).
  - `admin/src/providers/FontScaleProvider.tsx:82-88` — `serverFontScale` → `useState` → `useEffect` sync, with a localStorage fallback and a `transferred` ref for first-sign-in transfer (`:91-102`).
  - `admin/src/providers/ThemeProvider.tsx:154-155,219-227` — `serverChoice` → `localChoice` state, with the same `transferredTheme` ref pattern, but the resolution itself correctly extracted to the pure `theme-resolution.ts:32-53`.
  - `admin/src/layouts/admin-shell/useStarredItems.ts:80-82` — a fourth instance, with no in-flight protection at all (see F7).
- Why it matters: four copies of one idea, only one of which (theme) is protected against a late server response, and one of which (starred) is actively wrong.
- Fix: extract `admin/src/facades/auth/use-preference.ts` — `usePreference<K extends keyof UserPreferences>(key, fallback)` returning `[value, setValue, pending]`, owning the optimistic write, the rollback and the "ignore responses older than my last local change" rule once. `FocusModeProvider`, `FontScaleProvider` and `useStarredItems` become thin callers; `ThemeProvider` keeps its extra `localChoice`/organization-palette resolution on top.
- Fix size: M
- Risk: preference round-trip regressions; `admin/test/theme-resolution.test.ts` stays valid, and the new hook wants its own table test.

### F13. `FontScaleProvider` writes a localStorage key with no first-paint bootstrap, unlike theme

- Severity: low
- Category: styling
- Evidence: `admin/src/providers/FontScaleProvider.tsx:14` `nessie.fontScale`, applied only in an effect at `:104-109` (`document.documentElement.style.fontSize`). `admin/index.html:19-49` bootstraps `nessie.theme.choice` / `.applied` / `.css` before React runs, precisely so a reload does not flash — but reads nothing for font scale.
- Why it matters: a "Large" reader gets a full page painted at 16 px on every reload, then a reflow. The mechanism to fix it is already in the file next door.
- Fix: add `nessie.fontScale` to the inline bootstrap in `admin/index.html` (three lines, mapping to the same `ROOT_FONT_SIZE` table).
- Fix size: S
- Risk: keep the map in sync with `FontScaleProvider.tsx:38-42`; a comment cross-reference on both sides.

## Conventions observed

- **One identity source, honoured.** `MeResponse` and the bearer exist only in `AuthSessionProvider`; every one of the 115 read sites goes through `useAuthSession()` / `useOptionalAuthSession()`. No page reconstructs the user from a second endpoint. `lib/storage.ts` is the only token writer.
- **Big providers delegate.** `AuthSessionProvider` imports, rather than inlines, its policy: `useAccessTokenRenewal.ts`, `terminal-session-logout.ts`, `auth-session-query-reset.ts`, `ambient-refresh-gate-host.ts`, `lib/imported-session-policy.ts`, and the coordinator from `@nessie/client-core`. External auth is a sibling provider, not a branch.
- **Facades own queries; providers own lifetime.** Providers call facade hooks (`PresenceProvider` → `usePresenceList`, `AgentIdentityProvider` → `useAgents`, `ThemeProvider` → `useCurrentOrganization`) rather than `useQuery` directly. The two exceptions are direct `fetch`/`apiClient` calls in `IncomingCallProvider.tsx:188,211` and `FocusModeProvider.tsx:48`.
- **Contexts throw when misused.** `useAuthSession`, `useFocusMode`, `useTheme`, `useFontScale`, `useShellActions`, `useKnowledge` all throw outside their provider; the deliberately optional ones (`useMobileNav`, `usePhoneNavigation`, `useLocalBackSnapshot`, `useShakeFeedback`, `useOptionalAuthSession`) return `null` or a no-op with a comment explaining why.
- **Realtime "provider" means transport lifetime, not data.** `DashboardRealtimeProvider` and the event-stream fanout both use a registry + ref-count shape rather than putting frames in context.
- **`useSyncExternalStore` is the house pattern for registries.** `local-back/LocalBackContext.tsx:42-53` is the only such store, and it is the right one to copy.
- **Native-bridge components render nothing and live beside providers.** `AttentionDisplayManager`, `PushSurfacePresenceHeartbeat`, `NativeShellBridge`, `ExternalAuthRouterBridge`, `NativeIPadToolbarBridge`, `NativePhoneCreationBridge`, `NativePhoneNavigationBridge` — a consistent, unnamed convention.
- **Theme has one writer and one first-paint reader.** `theme-storage.ts` owns all three keys; `ThemeProvider` is the only writer; `index.html` only reads.

## Not a problem

- **`QueryProvider` being a one-line re-export** (`admin/src/providers/QueryProvider.tsx:1`) — it is the §5.1 seam kept where the doc names it while the implementation is shared with desktop/mobile in `@nessie/client-core`. Correct.
- **`ApiClientProvider` wrapping the core provider** (`admin/src/providers/ApiClientProvider.tsx:6-19`) — it injects the web base URL and the admin refresh callback into an env-agnostic package. That is exactly the layering §5.1 asks for, and the `useApiClient` re-export at `:19` keeps one import path for facades.
- **The theme "double write path"** — `admin/index.html:40-49` setting `dataset.theme` looks like a second writer, but it only *reads* the three keys `theme-storage.ts` owns and paints before React mounts; `ThemeProvider.tsx:201-202` then takes over. One writer, one pre-paint reader. Consistent with `docs/standards/design-system.md`'s token model (the organisation palette is emitted as one `[data-theme="organization"]` rule at `ThemeProvider.tsx:137-148`, never as inline root properties).
- **`AgentIdentityProvider` looking like a per-entity context** — it is a lookup *projection* over one existing query (`useAgents({scope:'all'})`), explicitly identity-only, and its docstring at `:13-29` argues why a second agent list would be wrong. It does not own fetching or mutations. Fine under §4.
- **`ToastProvider` + `NotificationsProvider` as two components** — the split is deliberate and documented (`NotificationsProvider.tsx:18-22`): one owns the viewport, the other is a producer. Only the *name* of the producer is wrong (F9).
- **`local-back` holding two contexts in one file** — `LocalBackRegistryContext` and `ColumnBackContext` are two halves of one mechanism (registry + per-column reporting channel) and are documented as such; splitting them would scatter the priority table at `:117-129`.
- **`useAdminShell` returning ~50 fields** (`admin/src/layouts/admin-shell/useAdminShell.ts`, 489 lines) — it is one component's state extracted to a hook, not a store, and it stays under the 500-line cap. Its prop explosion into `SidebarNav` (`AdminShellLayout.tsx:180-231`, ~40 props) is a componentization concern for that dimension's reviewer, not a state one.
- **Two 25 s heartbeats** (`PresenceProvider.tsx:95-103` → `/api/presence/heartbeat`, `PushSurfacePresenceHeartbeat.tsx:101,165` → `/api/push-surfaces/heartbeat`) — different endpoints answering different questions (am I online vs. what am I looking at). Not duplication.
- **Form drafts seeded from query data** — `StatusesPage.tsx:112-115`, `MemberDetailsDialog.tsx:66`, `SpaceSettingsDialog.tsx:69`, `OrganizationAppearancePage.tsx:63-64`, `TodoInstances.tsx:51-55`, `ExecutorRunLauncherDialog.tsx:121`, `DashboardWorkspacePanel.tsx:34` all mirror server state into `useState` via `useEffect`, but every one of them is an editable draft or a default selection, which is legitimate local state. `useStarredItems.ts:80-82` is the only one of the ten sampled that mirrors state the user does not edit in a form (F7).

---

## Appendix A — the actual provider tree

Indented as mounted, for an authenticated `/knowledge-base/spaces/:spaceId` page.
`ctx` marks a real React context; `fx` marks a component that renders nothing or
passes children through.

```
main.tsx:31              <React.StrictMode>
AppProvider.tsx:18         ShellEnvironmentProvider          ctx  1
AppProvider.tsx:19           QueryProvider (TanStack)        ctx  2
AppProvider.tsx:20             AuthSessionProvider           ctx  3
AppProvider.tsx:21               ExternalAuthProvider        ctx  4  (ExternalAuthNavigationContext)
AppProvider.tsx:22                 ApiClientProvider         ctx  5  (@nessie/client-core)
AppProvider.tsx:23                   ThemeProvider           ctx  6
AppProvider.tsx:24                     FontScaleProvider     ctx  7
AppProvider.tsx:25                       FocusModeProvider   ctx  8
AppProvider.tsx:26                         DesktopWindowFrame
AppProvider.tsx:27                           RouterProvider
RootLayout.tsx:12                              ShakeFeedbackProvider        ctx  9
RootLayout.tsx:13                                IncomingCallProvider       ctx 10  (CallRealtimeContext — 0 consumers)
RootLayout.tsx:14                                  NativeShellBridge        fx
RootLayout.tsx:15                                  ExternalAuthRouterBridge fx
RootLayout.tsx:16                                  DirectDesktopUpdatePrompt fx
RootLayout.tsx:17                                  <Outlet/>
AdminShellLayout.tsx:101                             LocalBackProvider      ctx 11
AdminShellLayout.tsx:105                               PhoneNavigationProvider ctx 12
AdminShellLayout.tsx:369                                 DashboardRealtimeProvider ctx 13  (WebSocket #2)
AdminShellLayout.tsx:370                                   AgentIdentityProvider   ctx 14
AdminShellLayout.tsx:371                                     PresenceProvider      ctx 15
AdminShellLayout.tsx:372                                       AttentionDisplayManager      fx
AdminShellLayout.tsx:373                                       PushSurfacePresenceHeartbeat fx
AdminShellLayout.tsx:374                                       ToastProvider       ctx 16
AdminShellLayout.tsx:375                                         NotificationsProvider      fx
AdminShellLayout.tsx:376                                           TransientMenuProvider    ctx 17
AdminShellLayout.tsx:377                                             AccountMenuProvider    ctx 18
AdminShellLayout.tsx:381                                               MobileNavProvider    ctx 19
AdminShellLayout.tsx:393                                                 ShellActionsProvider ctx 20
AdminShellLayout.tsx:407                                                   KnowledgeProvider  ctx 21
                                                                            (+ NestedStageHostContext,
                                                                               ColumnBackContext deeper)
```

**21 contexts** wrap an authenticated page, against the five §5.1 permits.
`useAdminShell` (`AdminShellLayout.tsx:125`) opens WebSocket #1 and four
`useEventStream` subscribers ride the shared SSE bus; `IncomingCallProvider`
opens SSE #2 and `DashboardRealtimeProvider` opens WebSocket #2.

### Classification table

| # | Provider | File:line | Class | Verdict |
|---|---|---|---|---|
| 1 | ShellEnvironmentProvider | `providers/ShellEnvironmentProvider.tsx:71` | app-wide | Allowed in spirit, but 2 consumers reading 1 field — F11 |
| 2 | QueryProvider | `providers/QueryProvider.tsx:1` | app-wide (§5.1) | Correct |
| 3 | AuthSessionProvider | `providers/AuthSessionProvider.tsx:107` | app-wide (§5.1/§6.1) | Correct; memo deps wrong — F6 |
| 4 | ExternalAuthProvider | `providers/ExternalAuthProvider.tsx:149` | app-wide (auth sub-concern) | Correct — a documented sibling of AuthSession, not a fork |
| 5 | ApiClientProvider | `providers/ApiClientProvider.tsx:6` | app-wide (§5.1) | Correct |
| 6 | ThemeProvider | `providers/ThemeProvider.tsx:150` | app-wide (§5.1) | Correct |
| 7 | FontScaleProvider | `providers/FontScaleProvider.tsx:79` | app-wide (a11y preference) | Legitimate; should share one preference hook — F12; no first-paint bootstrap — F13 |
| 8 | FocusModeProvider | `providers/FocusModeProvider.tsx:30` | app-wide (preference) | Legitimate as a context; its 15 s `/me` poll is not — F7 |
| 9 | ShakeFeedbackProvider | `providers/ShakeFeedbackContext.tsx:12` | shell/UI coordination | Legitimate: a one-field handoff between a native bridge and one composer. Could be a module-level store, but the cost is nil |
| 10 | IncomingCallProvider | `providers/IncomingCallProvider.tsx:158` | **entity/domain state (forbidden §4)** + own transport | Split: transport → shared bus, dialog → a `useIncomingCall()` facade hook + one dialog host. Context is dead — F3 |
| 11 | LocalBackProvider | `layouts/admin-shell/local-back/LocalBackContext.tsx:25` | shell/UI coordination | Correct, and the model to copy (`useSyncExternalStore`) |
| 12 | PhoneNavigationProvider | `layouts/admin-shell/PhoneNavigationProvider.tsx:~120` | shell/UI coordination | Legitimate — one navigation framework, 12 consumers, value is `useMemo`d |
| 13 | DashboardRealtimeProvider | `components/features/dashboards/DashboardRealtimeProvider.tsx:29` | shell/UI coordination (registry) | Registry shape is right; owning a second WebSocket is not — F4 |
| 14 | AgentIdentityProvider | `providers/AgentIdentityProvider.tsx:30` | app-wide projection | Fine — identity-only lookup over one existing query, not a second entity store |
| 15 | PresenceProvider | `providers/PresenceProvider.tsx:52` | app-wide (cross-cutting) | Legitimate: a lookup function avoids one hook per row. Value churns every 20 s poll (inherent) |
| 16 | ToastProvider | `providers/ToastProvider.tsx:46` | app-wide UI (§5.1a) | Correct — one toast surface, many producers |
| 17 | NotificationsProvider | `providers/NotificationsProvider.tsx:23` | **fx — renders `<>{children}</>`, provides nothing** | Rename to `MessageNotificationBridge`, move out of `providers/` — F9 |
| 18 | TransientMenuProvider | `layouts/admin-shell/TransientMenuContext.tsx:39` | shell/UI coordination | Legitimate — one interaction lane, 7 consumers, `useMemo`d |
| 19 | AccountMenuProvider | `layouts/admin-shell/AccountMenuContext.tsx:11` | shell/UI coordination | Fold into one ShellStateContext — F10; unmemoized — F8 |
| 20 | MobileNavProvider | `layouts/admin-shell/MobileNavContext.tsx:9` | shell/UI coordination | Same — F10/F8 |
| 21 | ShellActionsProvider | `layouts/admin-shell/ShellActionsContext.tsx:10` | shell/UI coordination | Same — F10/F8; type name still says "OutletContext" |
| 22 | KnowledgeProvider | `components/features/knowledge/KnowledgeProvider.tsx:155` | **entity/domain state (forbidden §4)** | Replace with facade hooks + URL state — F2; unmemoized value causes a loop — F1 |
| — | AttentionDisplayManager | `providers/AttentionDisplayManager.tsx:70` | fx (native badge bridge) | Fine; wrong directory — F9 |
| — | PushSurfacePresenceHeartbeat | `providers/PushSurfacePresenceHeartbeat.tsx:169` | fx (heartbeat) | Fine; wrong directory — F9 |
| — | NativeShellBridge | `providers/NativeShellBridge.tsx` | fx (native bridge) | Fine; wrong directory — F9 |
| — | ExternalAuthRouterBridge | `providers/ExternalAuthRouterBridge.tsx:30` | fx (router↔auth bridge) | Fine; wrong directory — F9 |
| — | DirectDesktopUpdatePrompt | `providers/DirectDesktopUpdatePrompt.tsx:31` | fx (update prompt) | Fine; wrong directory — F9 |

---

## Appendix B — identity read-path trace

**Question: is there one source of truth for current user, session token and current team/org?**
**Answer: yes for all three, with one qualification (a second `/me` fetcher) and one duplicated constant.**

### Current user (`me: MeResponse`)

| # | Path | Site | Authority? |
|---|---|---|---|
| 1 | `authApi.fetchSession(token)` → `setMe` | `providers/AuthSessionProvider.tsx:306,331-333` | **canonical** — the startup restore |
| 2 | `sessionMutations.run(...)` → `applySession` → `setMe` | `providers/AuthSessionProvider.tsx:145-155` | **canonical** — login / bootstrap / devLogin / switchContext / switchUoaTeam / recovery |
| 3 | `applyMeResponse(nextMe)` | `providers/AuthSessionProvider.tsx:406-412` | canonical, guarded by `isCurrentSessionResponse` (`auth-session-query-reset.ts:33`) |
| 4 | `useUpdatePreferences().onSuccess → applyMeResponse` | `facades/auth/hooks.ts:40-42` | funnels into #3 — correct |
| 5 | `useUpdateMyAvatar().onSuccess → applyMeResponse` | `facades/auth/hooks.ts:88-90` | funnels into #3 — correct |
| 6 | **`apiClient.get<MeResponse>('/api/auth/me')` every 15 s** | `providers/FocusModeProvider.tsx:48` | **second fetcher** — funnels into #3, so not a second *store*, but it is a second read path with its own dedupe/version logic (`:38-39,49`) that TanStack Query would give for free. See F7 |
| 7 | Every consumer | `useAuthSession().me` — 115 call sites | reads only |
| 8 | Derived roles | `useAdminShell.ts:57-63` (`isAdmin`, `isSuperAdmin`, `isUoaSession`), `components/shared/OwnerGate.tsx:41` (`useIsOwner`) | pure derivations of #7 — correct |
| 9 | Off-shell read | `useOptionalAuthSession()?.me` — `KnowledgeProvider.tsx:168` only | reads only |

**Verdict:** one store. `MeResponse` lives in exactly one `useState`. No page reconstructs the user; §6.1's "never reconstruct current user from multiple endpoints" holds. The only blemish is #6.

### Session token

| # | Path | Site | Authority? |
|---|---|---|---|
| 1 | `localStorage['nessie.admin.token']` | `lib/storage.ts:1,7,28,36` | **canonical persistence** — the only writer |
| 2 | `useState(() => loadStoredToken())` + `tokenRef` | `providers/AuthSessionProvider.tsx:110,113-114` | **canonical in-memory** |
| 3 | Mode marker `nessie.admin.token-mode` | `lib/storage.ts:2,9-26,32` | token-bound, fail-closed; read once at `AuthSessionProvider.tsx:116` |
| 4 | **Duplicated key constant** `const STORED_TOKEN_KEY = 'nessie.admin.token'` | `lib/session-debug-import.ts:5` | a second literal for the same key, outside `lib/storage.ts`. Low severity, but it is the only place the single-writer rule is stated twice |
| 5 | Bulk dump for debugging | `components/shared/DebugTokenButton.tsx:30-32` | enumerates all of `localStorage`; read-only, deliberate |
| 6 | Injected into the API client | `providers/ApiClientProvider.tsx:7-14` | reads #2 |
| 7 | Raw bearer for SSE/WS/uploads | `facades/realtime/event-stream.ts:131,55`; `facades/agents/realtime.ts:35,316`; `providers/IncomingCallProvider.tsx:160,209`; `providers/PushSurfacePresenceHeartbeat.tsx:70,101`; `lib/uploads.ts` via `facades/auth/hooks.ts:114,118` and `facades/team/hooks.ts:35,39` | all read #2 through `useAuthSession()` — no second store, but 52 components destructure `{ token }` directly, which is the widest raw-credential surface in the app |
| 8 | Renewal | `providers/useAccessTokenRenewal.ts:20-122` | driven by #2, writes through #2's `refreshAccessToken` |
| 9 | Cross-tab / remount fence | `providers/ambient-refresh-gate.ts` + `ambient-refresh-gate-host.ts` | persisted beside the token; not an identity store |

**Verdict:** one store, one persistence key, one writer. The duplicated constant (#4) and the 52 direct `{ token }` destructures (#7) are the only things worth tightening — the latter by giving `lib/uploads.ts`-style helpers and the SSE/WS transports their own `useAuthedFetch()` so components stop handling the bearer.

### Current team / org / project

| # | Path | Site | Authority? |
|---|---|---|---|
| 1 | `me.context.{organizationId, teamId, projectId}` | `AuthSessionProvider` state | **canonical** — carried inside the same `MeResponse`; there is no separate team store |
| 2 | Switching | `switchContext` / `switchUoaTeam` → `sessionMutations.run(authApi.switchContext\|switchUoaTeam)` → `applySession` | `providers/AuthSessionProvider.tsx:505-523` | canonical, single-queued through the coordinator |
| 3 | Hostname → team on cold load | `facades/team/host-sync.ts:45-76` — resolves `/api/hosts/resolve` then calls #2 | correct: resolution is not authorization, and it runs once per hostname |
| 4 | Invitations / provisioning | `facades/team/invitations.ts:20`, `facades/team/provisioning.ts:88` | both call #2 |
| 5 | Boundary guard | `hasSessionBoundaryChanged` on `user.id`/`organizationId`/`projectId`/`teamId` | `providers/auth-session-query-reset.ts:14-25` | resets the TanStack cache before a new tenant is exposed — this is what makes #1 safe as the sole store |
| 6 | Native display mirror | `nessie:team` / `nessie:workspace` `postMessage` | `layouts/admin-shell/TeamSwitcher.tsx:234,239` | **not a store** — a one-way name+avatar push to the native shell chrome. No read-back path exists |
| 7 | Org record | `useCurrentOrganization()` (`facades/organization/hooks.ts`), read by `ThemeProvider.tsx:153` and `useAdminShell.ts:64` | a TanStack-cached *record* keyed off #1, not a second identity store |

**Verdict:** one source. Team/org identity is a field of `MeResponse`, not a parallel store; every mutation path goes through the one session coordinator; the cache boundary is reset on change. `nessie:team`/`nessie:workspace` are display messages, not state.

### Canonical path, stated

```
backend /api/auth/{me,session,login,bootstrap,switch-*}
  → @nessie/client-core createAuthSessionApi + createSessionMutationCoordinator
    → AuthSessionProvider  (the one MeResponse + the one token + the one token store)
      → useAuthSession()   (user, roles, team/org context, bearer, session state)
      → ApiClientProvider  (bearer + refresh)
        → facades/*        (every entity, one TanStack cache path each)
```

Anything that reads identity outside this chain is a defect. Today there is
exactly one: `FocusModeProvider.tsx:48`.
