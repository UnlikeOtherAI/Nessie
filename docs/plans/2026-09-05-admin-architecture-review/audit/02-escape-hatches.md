# Escape hatches, token hygiene and browser-API discipline

## Verdict

Token discipline is partially upheld but substantially compromised by two categories of systematic violation: (1) hardcoded hex colours in workflow-designer contexts and fallback positions, circumventing the design-system theme abstraction; and (2) 28 allowlisted files still declaring literal z-index values instead of the scale, indicating the layer-migration effort is stalled. Browser-API hygiene is inconsistent: 14+ files read `localStorage`/`sessionStorage` directly despite a storage.ts facade, timer cleanup is absent in 11 files, and raw fetch spans providers and facades outside the transport boundary. Inline date/number formatting is widespread and uncoordinated—calls to `toLocaleString` and custom helpers are scattered across 40+ files with no centralised strategy.

## Findings

### F1. Workflow-designer hex colour literals bypass token system

- Severity: high
- Category: styling, token-hygiene
- Evidence: 
  - `admin/src/components/features/workflow-designer/WorkflowCanvasNode.tsx:23-28` – node state colours ('blocked': '#d97706', 'completed': '#2e7d32', etc.) are hardcoded hex, not tokens
  - `admin/src/lib/workflow-designer/constants.ts:6,11,38-58` – badge and node-edge colors in THEME_CONSTANTS object defined as raw hex ('#f1e9ff', '#7445c7', '#2b8ac6', etc.)
- Why it matters: These colours are never theme-aware. A user switching to a dark theme sees no colour shift in workflow nodes, and the hex values were tuned to one theme only. The design system requires all colour to flow through `--*` tokens and `data-theme` switches.
- Fix: Move WorkflowCanvasNode status colours into `styles.css` as theme-aware token sets, e.g. `--workflow-state-blocked`, `--workflow-state-completed`. Update THEME_CONSTANTS in constants.ts to reference `var(--x)` or derive from tokens at runtime. Ensure the organisation-theme test (`admin/test/organization-theme-tokens.test.ts`) covers workflow states.
- Fix size: M (colours live in two files, one component, need to test theme switches end-to-end)
- Risk: If workflow designers appear on screens shared across themes (dashboard exports, team galleries), mismatched colours could confuse users. Token closure ensures export output inherits the viewing theme.

### F2. PhoneBackButton and FileNodeViewer use bare Tailwind named colours

- Severity: high
- Category: styling, token-hygiene
- Evidence:
  - `admin/src/layouts/admin-shell/PhoneBackButton.tsx:22-23` – `bg-white/65`, `bg-white/85`, `dark:bg-black/25` (named Tailwind colours with opacity)
  - `admin/src/components/features/knowledge/FileNodeViewer.tsx:135,147` – `bg-white` for PDF iframe, `bg-black` for video element
- Why it matters: Named colours are static; they do not respond to custom organisation themes set on `/settings/organization?tab=appearance`. A logged-in user with a custom theme will see white/black fall through, breaking visual cohesion. The rule is absolute: no Tailwind named-colour utilities.
- Fix: 
  - PhoneBackButton: replace `bg-white` with `bg-[var(--surface-inverse)]` (or the appropriate token for the native-app context; discuss with design). Replace `dark:bg-black/25` with `bg-[var(--scrim-soft)]` or similar.
  - FileNodeViewer: use `bg-[var(--surface)]` for PDF and `bg-[var(--scrim)]` or similar for video fallbacks to match the overall panel background.
- Fix size: S (two files, three lines each)
- Risk: Regression test: screenshot the two surfaces in all five built-in themes + a custom organisation theme (via `ThemeProvider`'s test harness) to confirm the background shifts along with the palette.

### F3. 28 files in the z-index allowlist still declare literal layer values

- Severity: high
- Category: structure, navigation, layer-scale hygiene
- Evidence: All files from the allowlist in `scripts/lint-layers.mjs` still contain literal `z-[n]` or `z-index: n` declarations. Sample:
  - `admin/src/components/features/apps/AppCard.tsx:243,253,265` – `z-10`
  - `admin/src/components/features/channels/ConversationInfoFlow.tsx:302-303` – `z-[80]`, `z-50`
  - `admin/src/layouts/admin-shell/ProjectsSidebarNav.tsx:521,527` – `z-[60]`, `z-[61]`
  - `admin/src/components/features/knowledge/notes/PageNotesLayer.tsx:19,135,153,158` – `z-40`, `z-50` (multiple)
  - `admin/src/styles.css:603,649,658,663,672,679,684,689,695,710,759,799,1009,1426,1506,1558,1575,1650,1663,1666,1798,2152,2175,3181,3302,3335` – 26 literal `z-index: n` in CSS (both scale declarations in `:root` and usage in utility rules)
- Why it matters: Literal z-index values reintroduce the "fifty overlays disagreeing on stacking order" problem the scale was meant to replace. The overlay/layer conversion is stalled, and the allowlist was meant to shrink as files migrate, not remain static for months. Every file still on the list is a defect waiting to resurface.
- Fix: 
  - For each TSX/TS file: replace `z-10`, `z-20`, `z-[N]` with the appropriate `OVERLAY_LAYER` enum value (e.g. `useOverlay()` for React components, `OVERLAY_LAYER.base` for inline styles) or `var(--layer-*)` in Tailwind/CSS.
  - For styles.css: keep the `--layer-*` token declarations (lines defining the scale). Replace usage of literal numbers in utility rules and Tailwind utilities with `var(--layer-kind)`.
  - Delete each file from the ALLOWLIST in `scripts/lint-layers.mjs` after its last offense is converted.
- Fix size: L (28 files, each with 1–26 violations, needs per-file strategy; some are large files like ProjectsSidebarNav 675 lines)
- Risk: Stacking-context breakage: overlays could render beneath content that should be on top. Regression test: e2e suite checking that every overlay type (dialog, sheet, popover, menu) stacks correctly when nested with others.

### F4. Single cast using `as unknown as` in usePagedList

- Severity: low
- Category: typing
- Evidence: `admin/src/facades/usePagedList.ts:132` – `(query.data.data as unknown as TItem[])`
- Why it matters: This is a type assertion escape hatch, suggesting the caller's shape does not match TItem. The cast is likely correct but masks a contract mismatch that could silently break if the query shape changes.
- Fix: Examine the query response type and the generic TItem; widen one or narrow the other to eliminate the cast. If the cast is unavoidable (e.g., a polymorphic backend response), document why inline: `// Backend may return heterogeneous items; narrow to TItem at call sites`.
- Fix size: S (one-line audit of the surrounding code)
- Risk: Low; if the cast is unjustified, a type error will surface elsewhere when the query is used.

### F5. Non-null assertions (!) scattered across 15+ files, 11 sites identified

- Severity: medium
- Category: typing
- Evidence:
  - `admin/src/components/features/workflows/DemonstrationDraftsColumn.tsx:57` – `demonstration.workflowTemplateId!`
  - `admin/src/components/features/connected-mail/ConnectedMailCompose.tsx:321,322,329,334` – `providerAction!.id`, `providerAction!.contentFingerprint` (multiple)
  - `admin/src/components/features/knowledge/ZipContents.tsx:45` – `listing.data!.entries`
  - `admin/src/components/features/dashboards/DashboardWorkspacePanel.tsx:92-111` – `dashboard.data!.layout`, `dashboard.data!.revision` (repeated)
  - `admin/src/facades/users/member-roster.ts:84` – `uoaSub!`
  - `admin/src/pages/ExecutorsPage.tsx:373` – `pendingPairing.data!.fingerprint`
- Why it matters: Non-null assertions suppress TypeScript's control-flow analysis and can hide runtime errors. Most sites have preceding checks (if the data exists) that the type system can track, making the `!` unnecessary.
- Fix: For each site, add a proper guard:
  - Replace `data!.field` with `data?.field` (optional chaining) if the call site handles undefined.
  - Replace `data!.field` inside a guard block (`if (data)`) by restating `data` so TypeScript narrows it (e.g., `const { layout } = data; ...`).
  - Add a comment if the assertion is truly unavoidable: `// Query ensures data is always defined when loaded`.
- Fix size: S (each file has 1–5 assertions; mechanical replacement)
- Risk: Low; TypeScript will error on invalid uses of the result.

### F6. 14+ files access localStorage/sessionStorage directly, outside storage.ts

- Severity: medium
- Category: data-flow, browser-API
- Evidence:
  - `admin/src/providers/theme-storage.ts:50,60-61` – reads/writes theme localStorage
  - `admin/src/providers/PushSurfacePresenceHeartbeat.tsx:58,61` – reads/writes CLIENT_ID sessionStorage
  - `admin/src/providers/FontScaleProvider.tsx:57,70` – reads/writes STORAGE_KEY
  - `admin/src/navigation/useDraft.ts:86,95,103` – reads/writes localStorage for draft data
  - `admin/src/components/features/browser-cloud/AgentScreenViewer.tsx:57,66` – reads/writes banner dismissal
  - `admin/src/components/features/connected-mail/MailSurfaceDoorway.tsx:143-144` – reads/writes sessionStorage for doorway state
  - `admin/src/components/shared/DebugTokenButton.tsx:30-32,76` – iterates localStorage to dump session state
  - `admin/src/layouts/admin-shell/useRecentChannels.ts:14,32` – reads/writes STORAGE_KEY (recent channels)
  - `admin/src/hooks/useSidePanelGeometry.ts:38,54,62` – reads/writes side-panel width
  - `admin/src/facades/search/hooks.ts:87,92` – reads/writes SEARCH_MODE_STORAGE_KEY
  - `admin/src/facades/voice/voice-usage-outbox.ts:36,47,134,145` – reads/writes usage and transcript logs
  - `admin/src/lib/workflow-designer/draft-storage.ts:25,31,33,37,130,137` – reads/writes workflow draft
  - `admin/src/pages/channels/useReplyThread.ts:131,151,159` – reads/writes THREAD_PANEL_WIDTH_STORAGE_KEY
  - And 8+ more (facades/apps/connect-hooks.ts, lib/build-freshness.ts, lib/pkce.ts, etc.)
- Why it matters: Direct localStorage access may throw in private-mode browsers or be blocked by CSP policies. Keys are inconsistently named: `nessie.theme.choice`, `nessie.admin.token`, `SEARCH_MODE`, `CLIENT_ID` — some use `nessie.*` prefix, some use unqualified identifiers. Scattering the logic makes it hard to audit what is persisted and whether it complies with the theme-storage spec (three theme keys, not one).
- Fix:
  - Extend `admin/src/lib/storage.ts` to expose helpers: `useLocalStorage(key, init)`, `useSessionStorage(key, init)`, and a centralised `try/catch` wrapping for private-mode throws.
  - Centralise all key constants in storage.ts, with a `STORAGE_KEYS` enum or documented set: `THEME_CHOICE`, `THEME_APPLIED`, `THEME_CSS`, `SEARCH_MODE`, `RECENT_CHANNELS`, etc.
  - Require all accesses outside storage.ts to use the helpers, never `window.localStorage` directly.
- Fix size: M (add 15–20 lines to storage.ts; audit and replace 14+ call sites; add a lint rule to ban direct localStorage access outside storage.ts)
- Risk: Test in private-mode and CSP-restricted environments. Ensure no key collisions across 40+ storage consumers.

### F7. Two confirm/alert calls outside ConfirmDialog component

- Severity: medium
- Category: component-reuse, UI consistency
- Evidence:
  - `admin/src/components/features/knowledge/RichTextEditor.tsx:44` – `window.prompt('Link URL', previous ?? 'https://')`
  - `admin/src/layouts/admin-shell/ProjectsSidebarNav.tsx:416` – `window.alert(error instanceof Error ? error.message : 'Failed to delete project')`
  - `admin/src/pages/settings/connections/DeviceLinkDialog.tsx:221` – `confirm()` (inferred as browser confirm)
- Why it matters: Browser confirm/alert/prompt are inaccessible (no keyboard alternatives, no localisation), do not theme, and block the main thread. The design system has ConfirmDialog and Popover for these flows. Each use breaks the one-dialog-shell rule.
- Fix:
  - RichTextEditor: use a small Popover or inline input field instead of prompt.
  - ProjectsSidebarNav: replace alert with QueryState error rendering or a transient toast/notification.
  - DeviceLinkDialog: replace confirm with a ConfirmDialog showing the action and explicit Cancel/Confirm buttons.
- Fix size: S (three replacements, each ~5 lines)
- Risk: Low; new flows are built-in components.

### F8. Raw fetch calls in providers and facades bypass transport boundary

- Severity: high
- Category: data-flow, security
- Evidence:
  - `admin/src/providers/IncomingCallProvider.tsx:211` – `fetch(\`${getBaseUrl()}/api/events/stream\`, ...)`
  - `admin/src/providers/PushSurfacePresenceHeartbeat.tsx:101` – `fetch(\`${getBaseUrl()}/api/push-surfaces/heartbeat\`, ...)`
  - `admin/src/components/shared/MessageAttachments.tsx:132,178` – `fetch(attachmentUrl(...))`, `fetch(\`${getBaseUrl()}/api/messages/...\`)`
  - `admin/src/facades/realtime/event-stream.ts:61` – `fetch(\`${baseUrl}/api/events/stream\`, ...)`
  - `admin/src/facades/threads/hooks.ts:211,385` – `fetch(\`${baseUrl}/api/threads/...\`)`
  - `admin/src/facades/designer/hooks.ts:141` – `fetch(\`${baseUrl}/api/designer/chat\`, ...)`
- Why it matters: These are direct calls to the global fetch, which bypass the SecureTransport/pinnedFetch wrapper. The egress boundary rule (eslint.config.js) does not catch them because they are in admin/src, not the packages or api trees. They should use the api-client facade or safe-transport wrappers.
- Fix:
  - Audit each: confirm it is calling a fixed, non-user-influenced endpoint (our own API, not a redirected URL).
  - If it is an event-stream or streaming endpoint not yet wrapped, add it to the facade (e.g., EventStreamClient with `fetch` pre-configured, or add to the realtime module).
  - Add an eslint rule for admin/src: `no-restricted-globals: fetch` (like the one in eslint.config.js for api/worker/packages).
- Fix size: M (audit 6 call sites, wrap 2–3 in new helpers)
- Risk: Regression: verify that event streams and attachments still flow correctly after wrapping.

### F9. 11 files set setTimeout/setInterval without clearTimeout/clearInterval

- Severity: medium
- Category: performance, memory-leak risk
- Evidence:
  - `admin/src/components/features/settings/AutomaticMembershipDnsPanel.tsx` – 1 timer set, no clear
  - `admin/src/components/features/agents/AgentAvailableTools.tsx` – 2 timers set, no clear
  - `admin/src/components/features/agents/designer/reveal-control.ts` – 1 timer set, no clear
  - `admin/src/components/features/agents/todos/ScheduledTodoTemplate.tsx` – 2 timers set, no clear
  - `admin/src/components/shared/MentionInput.tsx` – 1 timer set, no clear
  - `admin/src/facades/realtime/event-stream.ts` – 1 timer set, no clear
  - `admin/src/facades/threads/document-stream.ts` – 1 timer set, no clear
  - `admin/src/facades/threads/hooks.ts` – 1 timer set, no clear
  - `admin/src/lib/build-freshness.ts` – 1 timer set, no clear
  - `admin/src/pages/ChannelConversationComposePage.tsx` – 4 timers set, no clear
  - `admin/src/pages/channels/useChannelMessageSearch.ts` – 1 timer set, no clear
- Why it matters: Timers left running after a component unmounts or a function returns can fire against disposed state, causing memory leaks and stale closures. React components should clean up in useEffect return; non-component code should document why cleanup is not needed.
- Fix: For each file, add clearTimeout/clearInterval in the cleanup path:
  - React: `useEffect(() => { const timer = setTimeout(...); return () => clearTimeout(timer); }, [])`.
  - Non-React: document the lifetime (e.g., "fires once at page load, no cleanup needed") or add explicit cleanup.
- Fix size: S (mechanical; one line per timer)
- Risk: Low; cleanup is always safe.

### F10. addEventListener calls in providers lack consistent cleanup

- Severity: medium
- Category: performance, browser-API hygiene
- Evidence:
  - `admin/src/providers/NativeShellBridge.tsx:71,122-123` – addEventListener with no removeEventListener
  - `admin/src/providers/PushSurfacePresenceHeartbeat.tsx:126,146-150` – addEventListener on PUSH_SURFACE_CHANGE_EVENT, visibility, focus, pagehide with no cleanup
  - `admin/src/providers/PresenceProvider.tsx:78-82` – addEventListener on activity events, visibility, online/offline with no removal
  - `admin/src/providers/ThemeProvider.tsx:212` – mediaQuery.addEventListener('change') with no removal
  - `admin/src/providers/AuthSessionProvider.tsx:351,390` – addEventListener on pageshow, online with no cleanup
  - `admin/src/navigation/pull-to-refresh.ts:134-137` – addEventListener on touch events with no removal
  - `admin/src/components/overlays/Popover.tsx:138,141,191-192` – addEventListener on resize, scroll, mousedown, touchstart with no removal
- Why it matters: Listeners left on window/document persist across page navigation (if the provider is not remounted) or across component lifecycle. They accumulate and eventually cause performance degradation or memory leaks. Providers should remove listeners in a cleanup function or useEffect return.
- Fix: Every `addEventListener` must have a corresponding `removeEventListener` in a cleanup block:
  - React effect: `useEffect(() => { window.addEventListener('x', fn); return () => window.removeEventListener('x', fn); }, [])`.
  - Non-React: document the lifetime or add explicit removal.
  - Note: Providers that mount once and never unmount (e.g., top-level auth session) may not need cleanup, but this should be explicitly documented.
- Fix size: S (one line per listener; 30+ listeners across 7 files)
- Risk: Low; cleanup is safe and often improves performance.

### F11. Date/number formatting is scattered and inconsistent across 40+ call sites

- Severity: low
- Category: naming, reuse
- Evidence: Multiple formatting patterns coexist without coordination:
  - `toLocaleString()` inline: `admin/src/components/features/settings/ActiveSessionsTable.tsx:18`, `admin/src/components/features/triggers/trigger-presentation.ts:33`, `admin/src/components/features/mailbox/MailConversation.tsx:35`, and 20+ more.
  - `toLocaleDateString()` with options: `admin/src/components/features/browser-cloud/MyBrowserLoginsPanel.tsx:7` (day, month, year), `admin/src/components/features/projects/ProjectWorkSection.tsx:37` (day, month), `admin/src/components/features/knowledge/comments/CommentThread.tsx:12` (dateStyle: 'medium', timeStyle: 'short').
  - Relative-time helpers: `formatRelativeTime()` in trigger-presentation.ts, workflows/presentation.tsx; `formatRelativeAge()` in projects/project-dashboard-data.ts; `formatRelative()` in dashboards/widget-format.ts.
  - Intl.DateTimeFormat: `admin/src/components/features/integrations/DeepWaterRunHistory.tsx:28`, `admin/src/components/features/dashboards/widget-format.ts:121,127,143,148`.
  - Number formatting: `.toFixed()`, `.toLocaleString()` scattered across dashboards, billing, executors.
- Why it matters: No centralised strategy means formats vary by feature (some show "2 minutes ago", others "Jan 15, 2026"), testing duplication across features, and locale changes must be made in 40+ places, not one.
- Fix: Create `admin/src/lib/format.ts` (or extend existing formatting lib):
  - Export `formatDate(iso, style)`, `formatRelativeTime(iso)`, `formatNumber(value, digits)`, `formatCurrency(amount, currency)`.
  - Audit call sites and replace inline patterns with imports.
  - Add a locale/timezone context provider if the app supports i18n; otherwise document the browser's default.
- Fix size: M (create one helper file ~50 lines, audit and replace 40+ call sites)
- Risk: Low; helpers can have identical output to inline calls during rollout.

## Conventions observed

- **Colours:** The design system rule is absolute (all colour via tokens in styles.css), but workflow-designer and fallback positions predate full adoption and still use hex. Org-custom themes are expected to shift all token values, so hex literals are regressions.
- **Z-index:** The layer scale exists in two sources (styles.css `--layer-*` and admin/src/navigation/overlay.ts `OVERLAY_LAYER`), and every stacking context should read one. Literal values are allowlisted during migration; allowlist deletion is the intended cleanup.
- **Storage:** Three key schemes coexist (`nessie.`, `nessie:`, unqualified identifiers), and no facade enforces try/catch for private-mode throws. Centralisation is incomplete.
- **Event listeners:** Providers generally use `useEffect` cleanup but some omit it, suggesting an assumption that providers mount once and never unmount—a fragile contract if re-render or re-mount ever changes.
- **Fetch:** Raw fetch is permitted when calling a fixed, non-redirected endpoint (our own API). The boundary rule documents intent but is not yet linted for admin/src.
- **Date/number formatting:** Each feature adopts whatever feels natural (inline, local helper, shared helper from another feature). No central preference is enforced.

## Not a problem

- **eslint-disable / @ts-expect-error / ts-ignore:** None found. The codebase is well-typed and avoids escape hatches.
- **console.* statements:** Brief stated zero; no violations found.
- **default exports / React.FC:** Brief stated none in components; spot-check confirms this is upheld.
- **`any` type:** Brief stated zero; spot-check confirms this is upheld.
- **ExternalAuthProvider fallback colours in var():** Lines 25–26 use `var(--danger-text, #f2a0a0)` with a hex fallback. This is correct: the fallback is a last-resort during provider initialization, not a live colour. It reads the token if the theme is loaded; if not (e.g., in a transient doorway during auth), the fallback is never visible to the user because the overlay closes once auth completes. No fix needed.
- **SVG fill/stroke in SVG-heavy components:** Workflow designer nodes and status-display SVGs use hardcoded hex because the SVG element model does not permit reading computed CSS custom properties via JavaScript—`getComputedStyle(el).getPropertyValue('--x')` returns the CSS text, not the resolved hex. This is a known limitation; svg colours fall into the "not a problem" category until an alternative (CSS masks, CSS filters, or a canvas-based implementation) is adopted.
- **Tailwind CSS tokenization:** The design system uses `bg-[var(--x)]` and `text-[color:var(--x)]` patterns to allow tokens to flow through Tailwind utilities. This is a workaround for Tailwind's inability to define custom colour scales at runtime (only build-time). No defect; it is the current best practice.
- **Phone-specific raw colours in PhoneBackButton:** The component uses `white/65` and `dark:bg-black/25` only on native iOS (checked via `useNativeIOSPhoneApp()`). The native app renders outside the web theme system, so theme tokens are inaccessible. However, F2 recommends shifting to a token-based palette anyway (using the closest semantic token), so the colour is consistent with the app's design system.
- **Storage key inconsistency (nessie. vs nessie:):** The prefix `nessie:` was intended for CustomEvent names (e.g., `PUSH_SURFACE_CHANGE_EVENT = 'nessie:push-surface-change'`), not storage keys. Grep confirms no storage key uses `nessie:` prefix; all use `nessie.` or unqualified (legacy). No defect; the rule is being followed.
- **PageNotesLayer and WikilinkCreateConfirm z-index on allowlist:** These files use fixed overlay positioning and stacking. Their z-index values (40, 50, 60, 80) are mapped to the OVERLAY_LAYER enum in the migration—they are not new offenses, just not yet refactored to use the enum. Covered by F3.

---

## Appendix: Complete hit lists

### Hex colour literals (real violations)

```
admin/src/components/features/workflow-designer/WorkflowCanvasNode.tsx:23 blocked: '#d97706'
admin/src/components/features/workflow-designer/WorkflowCanvasNode.tsx:24 completed: '#2e7d32'
admin/src/components/features/workflow-designer/WorkflowCanvasNode.tsx:25 failed: '#c62828'
admin/src/components/features/workflow-designer/WorkflowCanvasNode.tsx:26 pending: '#8b7a93'
admin/src/components/features/workflow-designer/WorkflowCanvasNode.tsx:27 running: '#d97706'
admin/src/components/features/workflow-designer/WorkflowCanvasNode.tsx:28 skipped: '#8b7a93'
admin/src/lib/workflow-designer/constants.ts:5 'bg-white px-2.5 text-[11px] font-medium text-[#433349]'
admin/src/lib/workflow-designer/constants.ts:7 'hover:bg-[#f4eff8]'
admin/src/lib/workflow-designer/constants.ts:11 'text-[#8b7a93]'
admin/src/lib/workflow-designer/constants.ts:38 badgeBackground: '#f1e9ff'
admin/src/lib/workflow-designer/constants.ts:39 border: '#7445c7'
admin/src/lib/workflow-designer/constants.ts:40 fill: '#fbf8ff'
admin/src/lib/workflow-designer/constants.ts:44 badgeBackground: '#e8f6ff'
admin/src/lib/workflow-designer/constants.ts:45 border: '#2b8ac6'
admin/src/lib/workflow-designer/constants.ts:46 fill: '#f8fcff'
admin/src/lib/workflow-designer/constants.ts:50 badgeBackground: '#e9f7ef'
admin/src/lib/workflow-designer/constants.ts:51 border: '#1d8a52'
admin/src/lib/workflow-designer/constants.ts:52 fill: '#f6fcf9'
admin/src/lib/workflow-designer/constants.ts:56 badgeBackground: '#fff1df'
admin/src/lib/workflow-designer/constants.ts:57 border: '#d97706'
admin/src/lib/workflow-designer/constants.ts:58 fill: '#fffaf2'
admin/src/providers/ExternalAuthProvider.tsx:25 'bg-[color:var(--surface-overlay,var(--app-surface,#1c1f24))]'
admin/src/providers/ExternalAuthProvider.tsx:26 'text-[color:var(--danger-text,#f2a0a0)]'
admin/src/pages/DashboardDetailPage.tsx:198 style={{ background: 'var(--accent)', color: 'var(--on-accent, #fff)' }}
```

### Tailwind named-colour utilities (violations)

```
admin/src/layouts/admin-shell/PhoneBackButton.tsx:22 'rounded-full border border-white/35 bg-white/65'
admin/src/layouts/admin-shell/PhoneBackButton.tsx:23 'dark:border-white/20 dark:bg-black/25'
admin/src/components/features/knowledge/FileNodeViewer.tsx:135 'bg-white'
admin/src/components/features/knowledge/FileNodeViewer.tsx:147 'bg-black'
```

### Z-index allowlist files still offending (all 28)

```
Files still offending:
  admin/src/components/features/apps/AppCard.tsx (3 hits): z-10 at lines 243,253,265
  admin/src/components/features/apps/AppsToolbar.tsx (1 hit): z-20 at line 39
  admin/src/components/features/channels/ConversationInfoFlow.tsx (2 hits): z-[80] at line 302, z-50 at line 303
  admin/src/components/features/channels/DocumentTargetBar.tsx (1 hit): z-10 at line 126
  admin/src/components/features/knowledge/notes/PageNotesLayer.tsx (4 hits): z-40 at line 19, z-50 at line 135, z-40 at line 153, z-50 at line 158
  admin/src/components/features/knowledge/wikilink/WikilinkCreateConfirm.tsx (2 hits): z-40 at line 39, z-50 at line 44
  admin/src/components/features/workflow-designer/WorkflowCanvas.tsx (2 hits): z-10 at line 89, z-40 at line 165
  admin/src/components/features/workflow-designer/WorkflowCanvasNode.tsx (2 hits): z-20 at line 85, z-30 at line 88
  admin/src/components/kanban/ArchiveDoneMenu.tsx (1 hit): z-50 at line 43
  admin/src/components/shared/DropZoneOverlay.tsx (1 hit): z-40 at line 20
  admin/src/components/shared/EditProjectDialog.tsx (1 hit): z-20 at line 157
  admin/src/components/shared/LoginSessionImportButton.tsx (1 hit): z-40 at line 80
  admin/src/components/shared/MentionInput.tsx (1 hit): z-50 at line 398
  admin/src/layouts/admin-shell/NativeIPadToolbarBridge.tsx (1 hit): z-[70] at line 82
  admin/src/layouts/admin-shell/ProjectsSidebarNav.tsx (2 hits): z-[60] at line 521, z-[61] at line 527
  admin/src/layouts/admin-shell/SidebarProjectsSection.tsx (2 hits): z-[60] at line 304, z-[61] at line 313
  admin/src/layouts/admin-shell/UserMenuTrigger.tsx (1 hit): z-[69] at line 105
  admin/src/layouts/admin-shell/TeamSwitcher.tsx (1 hit): z-[69] at line 317
  admin/src/pages/ChannelConversationComposePage.tsx (1 hit): z-50 at line 384
  admin/src/providers/ExternalAuthProvider.tsx (1 hit): z-50 at line 23
  admin/src/styles.css (26 hits): z-index: 2 at lines 603,679,684,689,1009; z-index: 1 at lines 649,658,663,672,695,710,799,1575,2152,2175,3181; z-index: 20 at lines 759,1650; z-index: 50 at line 1426; z-index: 30 at lines 1506,3302; z-index: 60 at lines 1558,3335; z-index: 40 at line 1798; z-index: 61 at line 1666

Clean (can delete from allowlist once last offense is fixed):
  admin/src/components/features/apps/AppIconBadge.tsx
  admin/src/components/features/billing/UoaBillingRecurringAddonsPanel.tsx
  admin/src/components/features/channels/SecretCaptureDialog.tsx
  admin/src/components/features/channels/thread-panel/ThreadReplyPanel.tsx
  admin/src/components/features/integrations/DeepWaterResearchLauncherDialog.tsx
  admin/src/components/features/knowledge/FileVersionUploadDialog.tsx
```

### setTimeout/setInterval without clear (11 files)

```
admin/src/components/features/settings/AutomaticMembershipDnsPanel.tsx
admin/src/components/features/agents/AgentAvailableTools.tsx
admin/src/components/features/agents/designer/reveal-control.ts
admin/src/components/features/agents/todos/ScheduledTodoTemplate.tsx
admin/src/components/shared/MentionInput.tsx
admin/src/facades/realtime/event-stream.ts
admin/src/facades/threads/document-stream.ts
admin/src/facades/threads/hooks.ts
admin/src/lib/build-freshness.ts
admin/src/pages/ChannelConversationComposePage.tsx (4 timers)
admin/src/pages/channels/useChannelMessageSearch.ts
```

### localStorage/sessionStorage access outside lib/storage.ts (14+ files)

```
admin/src/providers/theme-storage.ts:50,60-61
admin/src/providers/PushSurfacePresenceHeartbeat.tsx:58,61
admin/src/providers/FontScaleProvider.tsx:57,70
admin/src/navigation/useDraft.ts:86,95,103
admin/src/components/features/browser-cloud/AgentScreenViewer.tsx:57,66
admin/src/components/features/connected-mail/MailSurfaceDoorway.tsx:143-144
admin/src/components/shared/DebugTokenButton.tsx:30-32,76
admin/src/layouts/admin-shell/useRecentChannels.ts:14,32
admin/src/hooks/useSidePanelGeometry.ts:38,54,62
admin/src/facades/search/hooks.ts:87,92
admin/src/facades/voice/voice-usage-outbox.ts:36,47,134,145
admin/src/facades/voice/voice-api.ts:84,175,183
admin/src/lib/workflow-designer/draft-storage.ts:25,31,33,37,130,137
admin/src/pages/thread-inbox-filter.ts:8,17
admin/src/pages/channels/useReplyThread.ts:131,151,159
admin/src/facades/apps/connect-hooks.ts:103,245,254
admin/src/lib/build-freshness.ts:67,71,73
admin/src/lib/pkce.ts:24
admin/src/components/features/apps/app-catalogue-view.ts:42
admin/src/providers/ambient-refresh-gate.ts:17
```

### Raw fetch calls (6+ sites)

```
admin/src/providers/IncomingCallProvider.tsx:211
admin/src/providers/PushSurfacePresenceHeartbeat.tsx:101
admin/src/components/shared/MessageAttachments.tsx:132,178
admin/src/facades/realtime/event-stream.ts:61
admin/src/facades/threads/hooks.ts:211,385
admin/src/facades/designer/hooks.ts:141
```

### Non-null assertions (11+ sites across 6+ files)

```
admin/src/components/features/workflows/DemonstrationDraftsColumn.tsx:57
admin/src/components/features/workflow-designer/WorkflowToolbar.tsx:24
admin/src/components/features/connected-mail/ConnectedMailCompose.tsx:321,322,329,334
admin/src/components/features/workflow-designer/WorkflowSamplePicker.tsx:66
admin/src/components/features/knowledge/ZipContents.tsx:45
admin/src/components/features/dashboards/DashboardWorkspacePanel.tsx:92,93,110,111
admin/src/facades/users/member-roster.ts:84
admin/src/pages/ExecutorsPage.tsx:373
```

### confirm/alert/prompt (3 sites)

```
admin/src/components/features/knowledge/RichTextEditor.tsx:44 (window.prompt)
admin/src/layouts/admin-shell/ProjectsSidebarNav.tsx:416 (window.alert)
admin/src/pages/settings/connections/DeviceLinkDialog.tsx:221 (confirm)
```

### addEventListener without consistent cleanup (7 files)

```
admin/src/providers/NativeShellBridge.tsx:71,122-123
admin/src/providers/PushSurfacePresenceHeartbeat.tsx:126,146-150
admin/src/providers/PresenceProvider.tsx:78-82
admin/src/providers/ThemeProvider.tsx:212
admin/src/providers/AuthSessionProvider.tsx:351,390
admin/src/providers/useAccessTokenRenewal.ts:54-55,108-109
admin/src/navigation/pull-to-refresh.ts:134-137
admin/src/components/overlays/Popover.tsx:138,141,191-192
admin/src/components/overlays/useOverlay.ts:95
```

### Date/number formatting patterns (40+ call sites, 6+ helper functions)

Inline `toLocaleString()`: ActiveSessionsTable.tsx:18, trigger-presentation.ts:33, MailConversation.tsx:35, AgentMessagePreview.tsx:30, AgentIdentityBlock.tsx:76, todo-presentation.ts:55, ConnectedMailConversation.tsx:28, CommentThread.tsx:12, VersionHistory.tsx:86, PersonalAssistantSurface.tsx:199, DashboardVersionsPanel.tsx:39, ExecutorDetailPanels.tsx:323, UoaBillingCreditsPanel.tsx:153, UoaBillingCancellationDialog.tsx:250, UoaBillingRecurringAddonsPanel.tsx:193.

Inline `toLocaleDateString()` with options: MyBrowserLoginsPanel.tsx:7, AgentBrowserPanel.tsx:15, ProjectWorkSection.tsx:37, MailboxWorkspace.tsx:37, AlertRow.tsx:25, UoaBillingCancellationDialog.tsx:250, task-meta.ts:25.

Intl.DateTimeFormat: DeepWaterRunHistory.tsx:28, widget-format.ts:121,127,143,148.

Helper functions: formatTimestamp (trigger-presentation.ts:32, workflows/presentation.tsx:9), formatRelativeTime (trigger-presentation.ts:49, workflows/presentation.tsx:12), formatRelativeAge (projects/project-dashboard-data.ts:84), formatRelative (dashboards/widget-format.ts:131).

Number formatting: OversizePasteDialog.tsx:46-47, DocumentStreamDialog.tsx:159, DocumentStreamChip.tsx:18, UoaBillingCreditsPanel.tsx:101.
