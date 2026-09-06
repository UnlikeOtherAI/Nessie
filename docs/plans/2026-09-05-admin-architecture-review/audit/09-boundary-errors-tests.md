# Cross-cutting frontend practice — API boundary, errors & feedback, forms, a11y, performance, tests

## Verdict

The admin has exactly **one** API client (`@nessie/client-core`; `admin/src/lib/api-client.ts`
is a 17-line env seam plus a 125-line type re-export barrel) and exactly one query client
with sane defaults — that part is consistent. What is not consistent is everything that
sits *on* the boundary. Responses are asserted, never parsed: 2 of 55 facade directories
(`executors`, `mail`) validate with zod schemas from `@nessie/schemas`; the other 53 cast,
against a written guardrail that says the opposite. Record types are defined **twice** —
authoritatively as zod in `@nessie/schemas/team-records.ts` and again by hand in
`@nessie/client-core/api-types.ts` — and the admin imports the hand-written copies, which
have already drifted. Error feedback has no default at all: **43 of 144** mutation-bearing
components (30 %) surface nothing on failure, while 84 hand-roll inline state and 7 use
toasts. Accessibility and typing hygiene, by contrast, are genuinely strong (6 unlabelled
icon-buttons in 679; 22 non-null assertions and 1 `as unknown as` in 883 files) and the
test suite is large and real — its problem is composition, not existence: 32 % of it reads
source text with `readFileSync` and asserts on regexes.

## Findings

### F1. The admin never validates an API response; the one schema that exists for it is unused

- Severity: **high**
- Category: data-flow
- Evidence:
  - `packages/client-core/src/api-client.ts:134` — `return (await response.json()) as ApiResponse<TData>`
  - `packages/client-core/src/api-client.ts:66` — `const payload = JSON.parse(text) as ApiError`
  - `packages/schemas/src/api.ts:19` — `ApiErrorSchema` exists and is imported by nobody on the client
  - `docs/architecture.md` → "Validate external input at every boundary" and "Parse at
    process boundaries and derive client-facing types from the authoritative schema"
  - Counter-example that proves the pattern is available:
    `admin/src/facades/executors/hooks.ts:28,39,51,62,73,86,99,115,133,149,167,222` and
    `admin/src/facades/mail/hooks.ts:55,76,94` — 18 parse sites, all `Schema.parse(await apiClient.get(...))`
  - Scale: ~428 `apiClient.{get,getPage,post,put,patch,delete}` calls across
    `admin/src/facades`; 18 of them (4 %) are parsed. `z.infer<typeof …>` appears **once**
    in a facade (`admin/src/facades/agents/keys.ts:21`, for a *websocket* frame) and zero
    times as an API response type argument.
  - The only places the admin *does* parse are message-embedded card payloads and realtime
    frames — `admin/src/facades/agents/realtime.ts:366`, `admin/src/facades/calls/hooks.ts:33`,
    `admin/src/components/features/channels/RunApprovalGate.tsx`, `…/WorkflowRunCard.tsx`,
    `…/RunStopContinue.tsx`, `…/TodoProgressCard.tsx` — i.e. the boundary the team already
    distrusts, not the REST boundary.
- Why it matters: a server field that is renamed, nulled or dropped reaches React as
  `undefined` and surfaces as a blank cell or a crash inside a render, with no error
  attributable to the API. The codebase already knows this failure mode — `ChannelRecord`'s
  `lastMessageAt` comment in `packages/schemas/src/team-records.ts:79-83` documents a list
  that "silently lost a row's recency" for exactly this reason.
- Fix: (a) in `packages/client-core/src/api-client.ts`, replace the `JSON.parse(text) as ApiError`
  cast with `ApiErrorSchema.safeParse(JSON.parse(text))`, falling back to the raw-body branch
  on failure — mechanical, one file, no client change. (b) add an optional
  `schema?: ZodType<TData>` parameter to `ApiClient['get' | 'getPage' | 'post' | 'put' | 'patch']`
  that parses when supplied, then migrate facades domain-by-domain using
  `admin/src/facades/executors/hooks.ts` as the template. Do the shared-record domains first
  (`channels`, `agents`, `projects`, `users`) since their schemas already exist.
- Fix size: **L** (the client signature is a public contract; 53 facade dirs to migrate)
- Risk: a schema stricter than the server's actual emission turns a silent-wrong render into
  a hard query error. Mitigate by landing `safeParse` + a dev-only warning first, and by
  running `packages/client-core`'s existing `test/api-client.test.ts` plus
  `pnpm exec turbo run test --filter=@nessie/admin`.

### F2. Two competing definitions of the same record types; the admin imports the hand-written ones and they have drifted

- Severity: **high**
- Category: typing
- Evidence:
  - Authoritative: `packages/schemas/src/team-records.ts:55` `ChannelRecordSchema` →
    `:94` `export type ChannelRecord = z.infer<typeof ChannelRecordSchema>`; `:212`
    `AgentRecordSchema` → `:276` `export type AgentRecord`; `:105` `ProjectRecordSchema`.
    All re-exported by `packages/schemas/src/index.ts:7`.
  - Hand-written duplicate: `packages/client-core/src/api-types.ts:38` `export type ChannelRecord = {…}`,
    `:158` `export type AgentRecord = {…}`, `:84` `ProjectRecord`, `:151` `AgentOwner`,
    `:74` `PersonalAssistantPresenceParticipant`.
  - The admin gets the hand-written one: `packages/client-core/src/api-client.ts:167-210`
    re-exports these names `from './api-types.js'`, and
    `admin/src/lib/api-client.ts:21-145` re-exports them again to ~200 call sites.
  - Provable drift (5 checked types):
    | Type | Field | `@nessie/schemas` | `client-core/api-types.ts` |
    |---|---|---|---|
    | `ChannelRecord` | `metadata` | **absent** | `metadata?: ChannelMetadataRecord` (`api-types.ts:42`) |
    | `ChannelRecord` | `lastMessageAt` | `TimestampSchema.nullable()` — required (`team-records.ts:84`) | `?: string \| null` — optional (`api-types.ts:58`) |
    | `ChannelRecord` | `id`,`projectId`,`teamId` | branded `ChannelIdSchema`/`ProjectIdSchema`/`TeamIdSchema` | plain `string` |
    | `AgentRecord` | `voiceName` | `VoiceNameSchema.nullish()` (a fixed voice list) | `?: string \| null` (`api-types.ts:194`) |
    | `AgentRecord` | `runLimits` | `AgentRunLimitsSchema.optional()` | `?: AgentRunLimits \| null` (`api-types.ts:176`) — `null` is not a shape the server emits |
    | `ProjectRecord`/`AgentOwner` | ids | branded | plain `string` |
  - `docs/architecture.md`: "Do not hand-write client DTOs that drift from shared runtime
    schemas."
  - Not every hand-written type is a duplicate — `ThreadMessageRecord` (`api-types.ts:327`),
    `MessageSearchResult` (`:362`) and `ThreadRecord` (`:374`) have **no** counterpart in
    `packages/schemas/src/messaging.ts` (which only carries `MessageRoleSchema` and
    `AgentMentionSchema`). Those are a *missing authority*, a different fix from F2's.
- Why it matters: the branded-id erasure means `ProjectId` and `ChannelId` are
  interchangeable everywhere in admin code, which is the exact class of bug branding exists
  to stop; and the `metadata` field the admin reads has no server-side contract to hold it.
- Fix: delete the duplicate declarations from `packages/client-core/src/api-types.ts`
  (`ChannelRecord`, `AgentRecord`, `AgentOwner`, `ProjectRecord`, `ProjectMemberRecord`,
  `PersonalAssistantPresenceParticipant`) and re-export the `@nessie/schemas` ones instead —
  the file already does this for `UnreadDirectMessage*` at `api-types.ts:12-16`, so the
  pattern is in place. Fix the fallout (branded ids, `metadata`) in the same change: either
  add `metadata` to `ChannelRecordSchema` with a real shape, or drop the client reads.
  For `ThreadMessageRecord` et al., add the schemas to `packages/schemas/src/messaging.ts`
  and re-export from there.
- Fix size: **L** (public contract of `@nessie/client-core`; the branded-id conversion will
  ripple through facades)
- Risk: branded ids will surface dozens of real type errors in `admin/src`; that is the
  point, but it makes the change large. `pnpm --filter @nessie/admin typecheck` is the proof.

### F3. 30 % of mutation-bearing components surface no error at all, and there is no global default to catch them

- Severity: **high**
- Category: data-flow
- Evidence:
  - `packages/client-core/src/QueryProvider.tsx:4-16` is the whole configuration:
    `mutations: { retry: 0 }`, `queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 5min }`.
    **No `MutationCache`, no `QueryCache`, no `onError` default anywhere** —
    `grep -rn "MutationCache\|QueryCache" admin/src packages/client-core/src` returns nothing.
    `admin/src/providers/QueryProvider.tsx` is a one-line re-export.
  - 144 files under `admin/src/{pages,components,layouts,providers}` call `.mutate(` /
    `.mutateAsync(`. Classified by whether the file contains any of
    `pushToast` / `catch` / `setError|errorMessage` / `onError`: **43 have none**
    (see Appendix A). Examples verified by reading:
    `admin/src/pages/ApprovalsPage.tsx:89,97` (approve/reject an email — a failure is
    invisible), `admin/src/pages/project/ProjectBacklogTab.tsx:32,68,115,125,160`,
    `admin/src/components/shared/ChannelMembersPopup.tsx:98,132,144,150,161,190,212`,
    `admin/src/components/features/knowledge/comments/useAnnotationActions.ts` (5 calls).
  - Six unhandled fire-and-forget rejections:
    `admin/src/components/features/agents/AgentAvailableTools.tsx:66`,
    `admin/src/components/features/knowledge/KnowledgeProvider.tsx:425` and `:439`,
    `admin/src/facades/alerts/clear-project-attention.ts:42`,
    `admin/src/pages/ExecutorsPage.tsx:373`,
    `admin/src/pages/channels/ChannelConversationSurface.tsx:478`.
    (Three other `void mutateAsync` sites do attach `.catch` —
    `AutomaticMembershipRulesPanel.tsx:85`, `DeviceLinkDialog.tsx:136`,
    `ModelSubscriptionSection.tsx:164`.)
  - This is the same defect class `docs/plans/2026-09-01-content-design-system/overview.md`
    §3.5 named ("in `PolicyPage`, `AgentAvailableTools`, `ConnectionCard`,
    `CreateProjectDialog` — no error surface at all, so a failed mutation is silently
    swallowed"). Since the plan, `FormField`/`FormControls`/`FormActions` and
    `facades/form-errors.ts` shipped — but the *swallowed-mutation* class is still 43 files,
    so the plan's §4.4/§4.5 rule ("mandatory wherever a mutation can fail") is not enforced.
- Why it matters: `retry: 0` on mutations means one network blip is one permanently lost
  user action, with no signal. `AgentAvailableTools.tsx:66` toggles a tool policy — the
  checkbox stays visually on while the server refused it.
- Fix: two mechanical steps. (1) In `packages/client-core/src/QueryProvider.tsx`, construct
  the client with `new QueryClient({ mutationCache: new MutationCache({ onError }) })` where
  `onError` is injected by the host, and have `admin/src/providers/QueryProvider.tsx` stop
  being a re-export: it becomes the file that wires the default to `useToasts().pushToast`
  (`admin/src/providers/ToastProvider.tsx:60`) — the plan's §4.5 rule already says a toast is
  the right surface when the triggering surface has gone. (2) Add a ratchet test in
  `admin/test/` (the codebase's own idiom) that walks `src`, and for every file containing
  `.mutate(`/`.mutateAsync(` requires one of `onError`, `catch`, `toFormErrors`, or an
  explicit named allowlist entry with a reason — mirroring
  `admin/test/centred-modal-a11y.test.ts`'s exact-in-both-directions list.
- Fix size: **M** for the provider + ratchet; the 43-file cleanup that follows is **L**.
- Risk: a global toast on every mutation error will double up where inline errors already
  render. Land the ratchet first with the 43 files allowlisted, then empty the list.

### F4. Error-shape reading is forked: one good helper, twelve hand-rolled copies, and two structural casts

- Severity: **medium**
- Category: reuse
- Evidence:
  - The canonical helper exists and is good: `admin/src/facades/form-errors.ts:31`
    `toFormErrors(error: unknown): FormErrors` — `instanceof ApiClientError`, maps Zod
    `flatten()` from `error.details` onto field names. Adopted by **15** files
    (`CreateSecretDialog`, `TodoTemplateEditor`, `PageEditor`, `SpaceSettingsDialog`,
    `CreateSpaceDialog`, `PagePreview`, `CustomAppDialog`, `AppSecretDialog`,
    `CreateTeamDialog`, `SettingsMembersPage`, `TeamMembersSection`,
    `OrganizationProfilePage`, `FeedbackComposer`, `StatusesPage`, `PolicyPage`).
  - **12** files instead declare a local `const errorMessage = (…) => error instanceof Error ? error.message : '…'`,
    with four different signatures: `admin/src/pages/settings/MemberInvitationDialog.tsx:27`,
    `…/MemberDetailsDialog.tsx:23`, `…/OrganizationMembersSection.tsx:25`,
    `…/TeamMemberPeople.tsx:23`, `…/TeamMembersSection.tsx:37`,
    `admin/src/pages/project/settings/BoardsSettingsSection.tsx:11`,
    `…/BoardColumnsEditor.tsx:9`,
    `admin/src/components/features/settings/AutomaticMembershipRulesPanel.tsx:47`,
    `…/executors/ExecutorRunLauncherDialog.tsx:89`,
    `…/billing/UoaBillingStatementPanel.tsx:25`, and two more. None of them reads `.code`,
    `.status` or `.details`, so a `VALIDATION_ERROR` renders as "Invalid request payload".
  - Two sites cast to reach `ApiClientError` fields rather than narrowing:
    `admin/src/facades/agent-mailbox/hooks.ts:59` — `if ((error as { status?: number }).status === 404) return null`
    and `admin/src/pages/DashboardDetailPage.tsx:90` —
    `const details = (error as { details?: { currentRevision?: number } }).details`.
    Both would be `error instanceof ApiClientError && error.status === 404` /
    `error.details`.
  - Correct usage for contrast: `admin/src/components/features/connected-mail/ConnectedMailCompose.tsx:344,348,351,363`
    and `admin/src/facades/calls/call-presentation.ts:49` narrow properly on `.code`.
  - Only 5 files import `ApiClientError` at all.
- Why it matters: the server sends per-field validation detail and a stable `code`; twelve
  copies of `error.message` throw both away, which is precisely the loss the
  `ApiClientError.details` doc-comment (`packages/client-core/src/api-client.ts:43-52`)
  says was fixed.
- Fix: delete the 12 local helpers; where a form-level sentence is all that is wanted, add
  `export const formErrorMessage = (error: unknown, fallback: string): string` next to
  `toFormErrors` in `admin/src/facades/form-errors.ts` and import it. Replace the two casts
  with `instanceof ApiClientError`. Add the ban to `eslint.config.js` as a
  `no-restricted-syntax` selector on a `VariableDeclarator[id.name='errorMessage']` inside
  `admin/src` — the config already carries admin-scoped selectors (`eslint.config.js:237-290`).
- Fix size: **M** (≤20 files)
- Risk: low; message text may change slightly at 12 sites. `pnpm --filter @nessie/admin typecheck && test`.

### F5. Every route is statically imported, so the app ships one 2.5 MB JavaScript chunk

- Severity: **medium**
- Category: performance
- Evidence:
  - `admin/src/router.tsx:1-56` — 50 page modules imported at the top level; `createBrowserRouter`
    at `:75`. No `lazy()`, no `React.lazy`, no route-level `Component:`/`lazy:` option anywhere.
  - `admin/dist/assets/` (build of 2026-09-02, Appendix C): `index-C4ZPtwAi.js` = **2 575 873 B**
    uncompressed. Only three code-split chunks exist in the whole app:
    `admin/src/components/features/dashboards/DashboardWidgetCard.tsx:20` and `:38`
    (recharts → `WidgetCharts-*.js`, 412 430 B) and
    `admin/src/components/shared/EmojiPickerPanel.tsx:5`
    (`lazy(() => import('emoji-picker-react'))`, 309 029 B).
  - Everything else is eager, including `@tiptap/*` (9 files),
    `react-grid-layout` (1), `@dnd-kit/*` (3), `react-markdown` (1) — all loaded before the
    login screen paints.
  - `admin/vite.config.ts` has no `build.rollupOptions.manualChunks` and no compression config.
- Why it matters: first paint on the sign-in route downloads the workflow designer, the
  kanban board, the rich-text editor and the knowledge base. The two lazy boundaries that
  *do* exist prove the team knows the technique — it just was not applied at the route level,
  which is where the payoff is.
- Fix: convert `admin/src/router.tsx` to React Router 7's `lazy` route property for the
  ~40 leaf pages (keep `RootLayout`, `AdminShellLayout`, `LoginRoute`, `BootstrapPage`,
  `NotFoundPage` eager), and move `@tiptap` behind the composer's own `lazy()` boundary in
  the one component that mounts the editor. Add a build-size ratchet test to `admin/test/`
  (same idiom as the other gates) asserting the entry chunk stays under a stated byte budget.
- Fix size: **M** (one file plus a handful of editor call sites)
- Risk: a lazy boundary crossing a navigation transition can flash; the navigation suite
  (`admin/e2e/navigation/run.mjs`) freezes real animations and is the right proof. Suspense
  fallbacks must match the existing `Skeleton` treatment or the transition motion will jump.

### F6. Manual memoisation is heavy and component memoisation is absent, with no compiler and no windowing

- Severity: **medium**
- Category: performance
- Evidence:
  - `admin/vite.config.ts:14` — `plugins: [react(), tailwindcss()]`. No
    `babel-plugin-react-compiler`, and it is not in `admin/package.json` devDependencies.
    So React 19 without the compiler.
  - `admin/src`: `useMemo(` **242**, `useCallback(` **290** — versus `memo(` **1** and
    `forwardRef` **2** across 883 files. The memoisation budget is spent inside components
    that re-render anyway; nothing stops a parent re-render from re-rendering a list row.
  - No windowing library in `admin/package.json` and no hand-rolled windowing:
    `grep -rn "react-window\|react-virtual\|virtuoso" admin/src admin/package.json` → 0.
  - The five heaviest renders map `.map()` over an unbounded array and rely on TanStack page
    size alone: `admin/src/components/features/channels/ChannelMessageFeed.tsx:271-302,342`
    (`visibleFeedItems` is the full history filtered by collapsed date groups — no cap),
    `admin/src/layouts/admin-shell/ProjectsSidebarNav.tsx` (675 lines),
    `admin/src/layouts/admin-shell/AdminSidebarNav.tsx` (599),
    `admin/src/components/kanban/KanbanBoard.tsx`, and the knowledge tree.
  - Keying is correct where it matters — `ChannelMessageFeed.tsx:372,385,428` key on
    `message.id`/`clientId`. All 14 `key={index}` uses are on static or skeleton content
    (`Skeleton.tsx:51,62,101`, `KanbanBoard.tsx:280` page dots,
    `HighlightedPassage.tsx:18,22` text segments) — not a defect.
- Why it matters: with 883 components, no compiler and one `memo`, a keystroke in the
  composer re-renders the whole feed. This is the cheapest large win available and it is
  currently un-taken in both of the two possible ways.
- Fix: enable `babel-plugin-react-compiler` in `admin/vite.config.ts` (React 19 is the
  supported target) and let it do the memoisation, then delete `useMemo`/`useCallback` that
  the compiler subsumes as a follow-up. If the compiler is rejected, the minimum is `memo()`
  on the row components of the five renders above. Windowing is *not* recommended yet — take
  the compiler first and re-measure.
- Fix size: **S** to enable the compiler; **M**–**L** for the follow-up cleanup
- Risk: the compiler rejects components that violate the rules of React and silently skips
  them; run `eslint-plugin-react-hooks` v6 in compiler mode first, and prove behaviour with
  `admin/e2e/navigation/run.mjs` plus the 54 render tests.

### F7. A third of the test suite asserts on source text rather than behaviour

- Severity: **medium**
- Category: testing
- Evidence (206 files in `admin/test`, run by `node --test --experimental-test-isolation=none --import tsx "test/**/*.test.ts"`):
  | Category | Files | Share |
  |---|---|---|
  | source-regex gate only (`readFileSync`, no render) | 53 | 26 % |
  | component render (`createRoot`/`renderToStaticMarkup`) only | 41 | 20 % |
  | both gate and render | 13 | 6 % |
  | pure-function / hook-logic unit | 99 | 48 % |
  - 102 files contain `assert.match`, **1 249** calls in total.
  - The healthy end of the ratchet: `admin/test/centred-modal-a11y.test.ts:23-49` walks
    `src` with `readdirSync`, holds every centred modal to "composes `Dialog` or
    `useModalA11y`", and keeps an allowlist that is **exact in both directions** — an entry
    that is no longer needed fails too. Its allowlist is now empty, which is the ratchet
    working as designed. Ten gate files use this directory-walking shape.
  - The brittle end: `admin/test/a11y-navigation.test.ts:18-20` asserts
    `/export const sidebarAriaCurrent = \(active: boolean\): 'page' \| undefined/` — a
    signature reformat or a rename breaks it with no behaviour change, and it proves nothing
    a render test would not prove better. `admin/test/dialog-adopters.test.ts:30-45` pins a
    hand-listed set of 14 file paths.
  - Naming convention is **feature-name-based, not module-based**: `dialog-adopters`,
    `navigation-gates`, `prewarm`, `draft-surfaces`. There is no `X.test.ts ↔ src/…/X.tsx`
    mapping, so finding the tests for a file means grepping for its path.
  - Zero colocated tests (`find admin/src -name '*.test.*'` → 0) — correct, and exactly what
    `docs/standards/testing.md` requires ("A test file must live where its package's `test`
    script globs, and `pnpm lint:test-globs` enforces it").
  - No overlap with eslint: the four root ratchets are `scripts/lint-{breakpoints,layers,
    navigation-surfaces,test-globs}.mjs` and the admin-scoped `no-restricted-syntax` blocks
    at `eslint.config.js:208,237,273,393`; the gate tests cover different rules
    (dialog adoption, z-index, aria-current pairing).
- Why it matters: 1 249 regex assertions over source is a large, silent maintenance tax —
  they fail on refactors that change nothing and pass on behaviour changes that keep the
  text. The 10 directory-walking gates are worth keeping and extending; the exact-string
  ones are not.
- Fix: classify each of the 66 gate files as *structural* (walks a directory, enforces a
  rule with an exact allowlist — keep, and prefer these for F3's ratchet) or *literal*
  (asserts a specific signature or a hand-listed path). Convert the literal ones that assert
  rendered behaviour (`a11y-navigation`'s `aria-current` cases, `page-header-actions`) into
  `createRoot` render tests, which the suite already does well in 54 files. Adopt a
  `<module>.test.ts` naming rule for new tests and state it in `docs/standards/testing.md`.
- Fix size: **L** (66 files to triage)
- Risk: converting a gate to a render test can lose the "every file in this set" property.
  Keep the walk, replace only the assertion.

### F8. Forms: no form-state approach at all, and `FormField` documents a hook that does not exist

- Severity: **medium**
- Category: state
- Evidence:
  - No `react-hook-form` in `admin/package.json`; `useReducer` appears **6** times in the
    whole app. Every form is `useState`-per-field:
    `admin/src/pages/settings/MemberInvitationDialog.tsx` declares **8** `useState`s
    (`:36-43`), one of which (`error`) is the whole error model.
  - `admin/src/components/shared/FormField.tsx:35-36` says field-level API errors "arrive
    here through `useFormSubmit`" — **`useFormSubmit` does not exist**:
    `grep -rn "useFormSubmit" admin/src` returns only that comment. The real helper is
    `admin/src/facades/form-errors.ts` (F4), and the two are not connected.
  - Client-side validation is ad hoc and rare. `MemberInvitationDialog` validates one thing
    (`:71` — `if (scope === 'organization' && !targetId)`) and sends `email.trim()` (`:76`)
    with no format check. `TriggerEditorDialog.tsx` (386 lines) has 2 `useState`s and no
    validation. `AgentDesignerForm.tsx` (279 lines) holds no state at all — it is presentation
    over `useAgentDesigner`, which is the right shape and the only one of the three that is.
  - Only 4 zod object schemas are declared anywhere in `admin/src`, all for *message card*
    payloads (`RunApprovalGate.tsx:18`, `WorkflowRunCard.tsx:16`, `RunStopContinue.tsx:15`,
    `TodoProgressCard.tsx:7`). **No form reuses an API request schema from `@nessie/schemas`**,
    so there is no client/server validation duplication to report — there is no client
    validation to duplicate. Validation is submit-time server round-trip everywhere, which
    `docs/plans/2026-09-01-content-design-system/overview.md` §3.5 correctly calls "consistently
    submit-time, which is correct".
  - `FormField` adoption since the plan: 92 uses across 32 files, against 124 raw `<input`
    and 132 raw `<label>`. `MemberInvitationDialog.tsx:151,199` hand-writes
    `<label className="block text-sm font-medium…" htmlFor=…>` beside an imported
    `Input` — i.e. it takes the control from the kit and re-implements the label the kit
    exists to supply, losing the `aria-invalid`/`aria-describedby` wiring
    (`FormField.tsx:72-83`).
- Why it matters: the kit's whole argument (`FormField.tsx:8-14` — "a contract nobody
  remembers to satisfy is not a contract") is defeated by partial adoption, and the doc
  comment points maintainers at a hook that was never built.
- Fix: (1) build `useFormSubmit` for real, in `admin/src/facades/form-errors.ts`, wrapping
  `mutateAsync` + `toFormErrors` and returning `{ submit, fieldErrors, formError, isPending }`
  — it is the missing link between F3, F4 and `FormField`, and the comment already specifies
  it. (2) Convert the remaining raw `<label htmlFor>` + `Input` pairs to `FormField`, starting
  with `MemberInvitationDialog.tsx`, `TriggerEditorDialog.tsx`, `PolicyPage.tsx`,
  `StatusesPage.tsx`. (3) Add a gate test in `admin/test/` (directory-walking shape, per F7)
  asserting no file imports `FormControls` while declaring its own `<label htmlFor=`.
- Fix size: **M** for the hook + gate; **L** for full conversion
- Risk: low — visual only; the 54 render tests plus `admin/e2e/page-header/run.mjs` cover it.

### F9. Route changes move no focus and announce nothing

- Severity: **low**
- Category: a11y
- Evidence:
  - `admin/src/layouts/AdminShellLayout.tsx:301-313` — `<main id={SHELL_MAIN_ID} tabIndex={-1}>`
    exists in both the phone and split branches, so the target is ready.
  - Nothing focuses it on navigation: `grep -rn "focus()" admin/src/navigation admin/src/layouts/AdminShellLayout.tsx`
    returns only the `SkipToContentLink` comment (`admin/src/navigation/SkipToContentLink.tsx:2`).
    No route announcer either — the 20 `aria-live` regions are all component-local (toasts,
    pagination counts, mail status).
  - `docs/navigation/overview.md` §12, as enforced by `admin/test/a11y-navigation.test.ts`,
    covers `aria-current`, the skip link, forced-colors, the keyboard inset and split scroll
    memory — route-change focus is simply not in the standard, so this is a gap rather than
    a violation.
  - One reduced-motion bypass: `admin/src/pages/channels/useReplyThread.ts:96` calls
    `window.matchMedia('(prefers-reduced-motion: reduce)').matches` directly instead of the
    shared `useReducedMotion` from `admin/src/navigation/reduced-motion.ts` (used correctly
    by `components/overlays/useOverlay.ts:11`, `components/overlays/Card.tsx:3`,
    `layouts/admin-shell/PhoneNavigationViewport.tsx:31`).
- Why it matters: a screen-reader or keyboard user who activates a sidebar link stays
  focused on the sidebar with no announcement that the page changed — the single most common
  SPA accessibility complaint.
- Fix: add a `useRouteFocus()` hook in `admin/src/navigation/` that, on `pathname` change
  (and not on the initial mount), focuses `document.getElementById(SHELL_MAIN_ID)` and
  writes the new page title into a single `aria-live="polite"` region rendered once in
  `AdminShellLayout`. Add the case to `admin/test/a11y-navigation.test.ts` and the rule to
  `docs/navigation/overview.md` §12. Separately, point `useReplyThread.ts:96` at
  `useReducedMotion`.
- Fix size: **S**
- Risk: focusing `<main>` on every navigation can fight the phone transition's own focus
  handling; gate on transition settle (`admin/e2e/navigation/run.mjs` proves it).

## Conventions observed

- **One API client.** `@nessie/client-core.createApiClient` is the only one;
  `admin/src/lib/api-client.ts` supplies the Vite base URL and nothing else. No second
  client, no duplicated fetch wrapper. `ApiClientError` is the single error class, carrying
  `code`, `status` and `details`.
- **Type argument on `useQuery`, not on the client call.** 126 of 145 facade queries write
  `useQuery<T>({ queryFn: () => apiClient.get(...) })`; 19 write the generic on the client
  call. Both are unchecked assertions, but the placement is a real convention and the counts
  say which one wins.
- **Query keys are central, facades are thin.** `admin/src/lib/query-keys.ts` (596 lines)
  plus one `hooks.ts` per facade dir. `retry: false` is set per-query on the ~14 endpoints
  where a 404 is a steady state.
- **Errors are inline and submit-time.** 84 of 144 mutation files hold a local
  `error: string | null` and render it under the form; 7 use toasts, and those 7 are all
  cases where the triggering surface is gone (to-dos, run continue) — which is the rule the
  content plan §4.5 proposes, already followed de facto.
- **`QueryState` is the query triad.** 61 files compose `admin/src/components/shared/QueryState.tsx`
  for loading/error/empty with a mandatory `refetch`. `Notice` covers 33 files.
- **Gate tests as a ratchet.** New architectural rules land as a `admin/test/*.test.ts` that
  reads source; the best of them walk a directory and keep an exact allowlist with a written
  reason per entry.
- **Interaction tests are hand-rolled.** 27 files mount with `createRoot` under jsdom and
  22 drive `dispatchEvent`/`.click()`; `admin/test/support/` holds three shared harnesses
  (`overlay-host.ts`, `phone-navigation-viewport-harness.ts`, `resize-observer-stub.ts`).
  `@testing-library/*` is deliberately absent and the suite does not need it.
- **e2e is Playwright driving the real app.** Five suites
  (`connected-mail`, `executor-companion`, `navigation`, `organization-theme`, `page-header`),
  each a bare `run.mjs` using `playwright-core` from the root, sharing
  `e2e/navigation/lib/{browser,config,servers,seed}.mjs`. They skip and exit 0 with no
  database (`e2e/navigation/run.mjs:14-16`), which matches
  `docs/standards/testing.md`'s objection to false greens. They are the durable form of
  `AGENTS.md:154-156` ("Every UI change must be visually verified using Playwright"): the
  rule asks each change to screenshot its page, and these five turn the recurring cases —
  navigation motion, header actions, theme, mail, the executor companion — into something CI
  can re-run instead of a per-change ritual.

## Not a problem

- **Icon-only buttons.** Of 679 `<button>` elements, 27 are icon-only and a scripted scan
  found 6 without an obvious accessible name — all six false positives on inspection:
  `VoiceCallDialog.tsx:160-166` has a visible `<span>Mute</span>`;
  `ResponsivePageHeader.tsx:540` is inside an `aria-hidden="true"` measurement container
  (`:518-520`); the other four are full-width rows whose label comes from a child component.
  Effective rate of genuinely unlabelled icon buttons: **0 in 679**. Do not re-audit.
- **`role=` usage.** 171 `role` attributes, all conventional (`alert` 48, `status` 28,
  `dialog` 17, `radiogroup` 16). No `role="presentation"` on interactive elements, no
  redundant roles on semantic tags.
- **`key={index}`.** 14 sites, every one on static or skeleton content (see F6). Fine.
- **Typing hygiene.** 228 `as X` casts across 883 files (0.26/file), concentrated in DOM/
  native-bridge code (`lib/markdown-editor.ts` 8, `facades/voice/native-voice-call.ts` 5,
  `providers/NativeShellBridge.tsx` 4) — exactly where casts are unavoidable. **22** non-null
  `!` assertions total, **1** `as unknown as` (`admin/src/facades/usePagedList.ts:132`, with a
  fallback selector beside it), 0 `any`, 0 `@ts-ignore`. 321 `as const`. This is well above
  the norm; the boundary problem in F1/F2 is *not* visible as cast noise, which is precisely
  why it is easy to miss.
- **Status enums.** Only 3 locally declared string-literal status unions
  (`connect-flow.ts:284`, `iterations/hooks.ts:5`, `OpsHealthPage.tsx:12`); the rest come
  from `@nessie/schemas` enums. The 123 `'active'` / 66 `'failed'` literals are comparisons
  against those imported unions, not re-declarations.
- **`QueryProvider` defaults.** `retry: 1` / `staleTime: 5min` / `refetchOnWindowFocus: false`
  is a defensible baseline, and the ~33 per-query `staleTime` and 14 `retry: false` overrides
  each carry a comment explaining the endpoint. The gap is the *mutation* default (F3), not
  the query defaults.
- **Colocated tests.** Zero, and that is correct — `docs/standards/testing.md` requires the
  test to live where the package's glob looks, and `admin`'s glob is `test/**/*.test.ts`.

---

## Appendix A — Mutation feedback, 20 sampled call sites

`toast` = `pushToast`; `inline` = local error state or `onError` writing one; `swallowed` =
no `catch`, no error state, no `onError`, no toast.

| File | mutation calls | Surface |
|---|---|---|
| `admin/src/pages/ApprovalsPage.tsx:89,97` | 2 | **swallowed** |
| `admin/src/pages/AgentDesignerPage.tsx` | 3 | **swallowed** |
| `admin/src/pages/AlertsPage.tsx` | 3 | **swallowed** |
| `admin/src/pages/AppDetailPage.tsx` | 1 | **swallowed** |
| `admin/src/pages/project/ProjectBacklogTab.tsx:32,68,115,125,160,211` | 6 | **swallowed** |
| `admin/src/pages/project/ProjectBoardTab.tsx` | 1 | **swallowed** |
| `admin/src/pages/channels/ChannelConversationSurface.tsx:478` | 3 | **swallowed** (+ unhandled `void mutateAsync`) |
| `admin/src/components/shared/ChannelMembersPopup.tsx:98,132,144,150,161,190,212` | 7 | **swallowed** |
| `admin/src/components/features/agents/AgentAvailableTools.tsx:66` | 1 | **swallowed** (+ unhandled `void mutateAsync`) |
| `admin/src/components/features/knowledge/comments/useAnnotationActions.ts` | 5 | **swallowed** |
| `admin/src/components/features/knowledge/KnowledgeProvider.tsx:425,439` | 2 | **swallowed** (+ 2 unhandled `void mutateAsync`) |
| `admin/src/pages/settings/MemberInvitationDialog.tsx:76` | 2 | inline (`setError` + local `errorMessage`) |
| `admin/src/pages/settings/TeamMembersSection.tsx:37,50` | 5 | inline (`toFormErrors` **and** a local `errorMessage`) |
| `admin/src/pages/settings/StatusesPage.tsx` | 9 | inline (`toFormErrors`) |
| `admin/src/pages/PolicyPage.tsx` | 2 | inline (`toFormErrors`) |
| `admin/src/pages/DashboardDetailPage.tsx:88-92` | 1 | inline via `onError` + a structural cast |
| `admin/src/pages/ExecutorsPage.tsx:373` | 6 | inline (5 `catch`) + 1 unhandled `void mutateAsync` |
| `admin/src/components/features/triggers/TriggerEditorDialog.tsx` | 3 | inline + `Notice` |
| `admin/src/components/features/agents/todos/TodoInstances.tsx` | 4 | **toast** (5 `pushToast`, 4 `onError`) |
| `admin/src/components/features/agents/todos/TodoTemplates.tsx` | 4 | **toast** (4 `pushToast`, 2 `onError`) |

Whole-app totals over the 144 files containing `.mutate(`/`.mutateAsync(`:
**toast 7 · inline-or-onError 84 · nothing 43** (some files appear in two columns).
Global default: **none** — no `MutationCache.onError` exists.

## Appendix B — Test categories (206 files in `admin/test`)

| Category | Detection | Files | Share |
|---|---|---|---|
| (a) source-regex gate, no render | `readFileSync` present, no `react-dom` | 53 | 26 % |
| (c) component render only | `createRoot` / `renderToStaticMarkup` | 41 | 20 % |
| (a)+(c) gate **and** render | both | 13 | 6 % |
| (b)/(d) pure function or hook logic | neither | 99 | 48 % |

Supporting counts: `assert.match` in 102 files, **1 249** calls · `readdirSync`
(directory-walking gates) in 10 files · `createRoot` in 27 · `renderToStaticMarkup` in 35 ·
`dispatchEvent`/`.click()` in 22 · `renderHook` in 0 · `@testing-library/*` in 0 ·
colocated `src/**/*.test.*` in 0.

## Appendix C — Bundle assets (`admin/dist/assets`, build of 2026-09-02)

| Asset | Bytes | Source |
|---|---:|---|
| `index-C4ZPtwAi.js` | 2 575 873 | entry — every route, tiptap, dnd-kit, react-grid-layout, react-markdown |
| `WidgetCharts-0fAz96H2.js` | 412 430 | recharts, via `DashboardWidgetCard.tsx:20,38` |
| `emoji-picker-react.esm-GhOat2-l.js` | 309 029 | via `EmojiPickerPanel.tsx:5` |
| `index-BRqVe6FZ.css` | 129 011 | Tailwind 4 output |
| `index-DIZWIBVd.js` | 1 178 | |
| `index-CdNqAnIY.js` | 128 | |

Six assets in the current build (the other six files in the directory are the 2026-08-31
build). Three chunks total, two of them from the app's only two `lazy()` boundaries.
`admin/dist` overall: 7.2 MB across both builds.
