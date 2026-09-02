# Responsive & device-view coherence — audit + convergence plan (2026-08-13)

Status: plan approved for implementation (mechanical portions delegated to
CLI-agent batches; every UI change Playwright-verified before merge). Inputs:
three independent audits on one shared brief — Fable, Kimix, Codex Sol — all
claims below re-verified against the tree before inclusion.

## Verdict

No rewrite needed. The admin's ordinary Tailwind usage is healthy (~150
default-scale variants), and its best components already respond to the space
they actually receive (`ResponsivePageHeader`'s measured overflow, the
`@min-[900px]` container queries, `DashboardGrid`'s own width hook). The
incoherence is at the seams, and it is countable:

- **Six unnamed breakpoint scales** (600 / 768 / 900 / 1024 / 1200 / 1280)
  from four origins, none declared anywhere — Tailwind's defaults are
  inherited invisibly (no `@theme` block in `styles.css`).
- **Eight hand-copied media-query strings** (`'(max-width: 767px)'` ×6 +
  the column-browser band pair) restating what `md:` already means —
  `MOBILE_MAX_WIDTH_QUERY` exists in `lib/mobile-shell.ts:83` but is not
  exported.
- **Two meanings of "mobile"**: `useMobileLayout()` = narrow viewport OR
  native shell; the raw 767px literal = viewport only. In the iPad WebView the
  shell says mobile while the column-browser pages say desktop (split-brain,
  Kimix §2.4; Sol confirms the phone-landscape variant: an 844×390 native
  phone is "phone" to the shell but "not mobile" to width-only pages, so Back
  affordances disagree).
- **Nested layouts classify the window while the shell consumes it** (Sol's
  deepest finding): at a nominal 1280px "docked" viewport, rail (65px,
  `SidebarRail.tsx:21`) + max sidebar (35vw = 448px,
  `ResizableSidebar.tsx:7,112`) + max thread (50vw = 640px,
  `thread-panel-helpers.ts:13`) leave ~127px for the conversation — valid
  CSS, unusable UI. `ColumnBrowserViewport` likewise picks pane count from
  `window` width regardless of what the shell left it.

## Delivery status (2026-08-14)

Landed on main, each batch gated and Playwright-verified:

- **Phase 3 foundation** — `@theme static` tokens, the `useViewport`
  singleton store (lazily initialized on first render — reading tokens at
  module init raced Vite's stylesheet injection), `ShellEnvironmentProvider`.
- **Phase 2 correctness** — D1, D2, D3, D5, D15 fixed and visually verified
  (docked/overlay/full-screen matrix incl. the formerly dead 1279px width;
  live `aria-valuemax`; selectable chat text at 1024px with a mouse).
- **Phases 4+6** — the six split-brain pages are shell-aware
  (`useMobileLayout`), `useMediaQuery` deleted, ESLint restricted-imports/
  properties + `scripts/lint-breakpoints.mjs` wired into root lint.

Also landed 2026-08-14: D6 (sidebar ARIA live-clamp within [min,max]), D7/D8 (measured header leading from observed content + intrinsic-row observation), D10 (drag hygiene: pointercancel/blur, frame coalescing, persist-on-end, thread-separator keyboard path), D14 (stale 900px comment) — Playwright-verified. Open: D9 (safe-area DOM depth), D11 (popover clipping-ancestor placement), D12 (useMediaQuery is deleted, so moot), Phase 1 edge matrix as durable tests. Phase 5 (per-surface container conversion) is delivered by the navigation framework — `docs/navigation.md` §5, built from `docs/plans/2026-09-01-navigation-motion-system.md`: every page's container is decided by `useNavigationLayout()`, never by a breakpoint of its own.

## Verified defects (fix list)

| # | Defect | Evidence | Found by |
| --- | --- | --- | --- |
| D1 | Thread-panel mode gaps: `max-[899px]`+`min-[900px]` and `max-[1279px]`+`min-[1280px]` leave `[899,900)` and `[1279,1280)` uncovered (arbitrary `max-[N]` is strict `<`); reachable under fractional zoom widths | `ThreadReplyPanel.tsx:218-247` | All three |
| D2 | Stale clamp: thread width clamped only at mount/drag — no resize subscription; a 640px persisted width stays 640 on a shrunk 900px viewport; `aria-valuemax` is a mount-time snapshot | `useReplyThread.ts:54-64`, `ThreadReplyPanel.tsx:242` | Kimix, Sol |
| D3 | Width-as-touch-proxy: `(max-width: 1024px)` OR-ed with pointer queries makes a narrow mouse desktop "touch" (and un-selectable chat text at exactly 1024px); the pointer terms alone carry the intent | `styles.css:1744` | Fable, Kimix |
| D4 | Mobile split-brain (shell-aware vs width-only "isMobile") — see Verdict | `AdminShellLayout.tsx:95` vs 6 literal call sites | Kimix, Sol |
| D5 | Inclusive JS band pairs repeat the D1 gap class (767/768, 1023/1024) | `ColumnBrowserViewport.tsx:13-18` | Sol |
| D6 | Sidebar ARIA/state not recomputed when viewport limits change (CSS clamps the track; React state doesn't follow) | `ResizableSidebar.tsx:40-57,108-136` | Sol |
| D7 | Phantom header leading space: `hasLeading = Boolean(leading)` is always true because `AdminPageHeader` always passes `<PhoneNavigationButton />`, which returns `null` outside phone mode — actions collapse ~48px early | `ResponsivePageHeader.tsx:178`, `AdminPageHeader.tsx:17`, `PhoneNavigationButton.tsx` | Sol |
| D8 | Header measurement doesn't observe the hidden intrinsic-measurement row; font-scale changes can stale the partition | `ResponsivePageHeader.tsx:193-238,431-446` | Sol |
| D9 | Native safe-area CSS targets `.admin-shell > aside`, but wide shell wraps the aside in `ResizableSidebar` — bottom clearance misses | `mobile/src/lib/webview-inject.ts:42-49`, `AdminShellLayout.tsx:229` | Sol |
| D10 | Drag cleanup misses `pointercancel`/window-blur; thread separator is pointer-only despite its ARIA separator role; drag paths persist localStorage/cookies per pointer-move instead of frame-coalesced + persist-on-end | `ThreadReplyPanel.tsx:189-210`, `KnowledgeColumns.tsx:202-225`, `ResizableSidebar.tsx:59-66` | Sol |
| D11 | Popover placement measures `window` once, not the clipping/anchor container, and misses anchor movement from sidebar reflow | `ReactionPills.tsx:108-131`, `WorkspaceSwitcher.tsx:58-75`, `UserMenuPopover.tsx:59-76` | Kimix, Sol |
| D12 | `useMediaQuery` returns a stale result if its query string changes between renders (initializer reads old query; effect doesn't resync `matches`) | `hooks/useMediaQuery.ts:3-13` | Sol |
| D14 | Cross-file private-scale dependency: composer emoji CSS comments depend on the thread panel's 900px | `styles.css:1161` | Kimix |
| D15 | Authored CSS uses inclusive `max-width: 640px`/`1024px` overlapping Tailwind `sm`/`lg` at the exact boundary (two modes apply at once) | `lib/notifications.css:71-77`, `styles.css:1744` | Sol |

Not defects (leave alone, document): `DashboardGrid`'s `{lg:1200, md:768,
sm:0}` — a persisted react-grid-layout container scale whose band names live
in `@nessie/schemas` (`dashboards.ts:334+`); the 600×600 native-tablet gate
(two-dimensional device physics, already a named const); the two justified
`@min-[900px]` container queries; ThemeProvider's `prefers-color-scheme`
matchMedia; popover/drag *geometry* reads of `innerWidth` (measuring
positions, not classifying devices — subject to D10/D11 hygiene only).

## Target system

Adopted from the three proposals (they converged on A–C independently; D–E
are Sol's, adopted; divergences resolved at the end).

### A. One named scale, owned by `styles.css`

```css
/* styles.css — the sole numeric source for viewport breakpoints */
@theme static {
  --breakpoint-*: initial;
  --breakpoint-sm: 40rem;
  --breakpoint-md: 48rem;
  --breakpoint-lg: 64rem;
  --breakpoint-xl: 80rem;
  --breakpoint-2xl: 96rem;
}
```

Same values as today (behaviour-preserving); Tailwind v4 compiles every
`md:`-style variant from these and `static` emits them as real CSS custom
properties for TS to read. This honours the repo's token-ownership rule
(everything visual in `styles.css`) instead of a parallel TS constants file.
Authored CSS blocks migrate from raw `@media (max-width: 640px)` to build-time
`@variant max-sm { … }` so exact-boundary ownership can't diverge (D15). Raw
media queries remain only for capabilities/preferences (`prefers-*`, `hover`,
`pointer`).

### B. One viewport store; retire the ad-hoc hook

A singleton external store (one `MediaQueryList` per named minimum, values
read from the emitted tokens via `getComputedStyle`, fail-loud in dev if a
token is missing) consumed through `useSyncExternalStore`:

```ts
useViewport(): {
  band: 'base'|'sm'|'md'|'lg'|'xl'|'2xl'
  atLeast: Record<'sm'|'md'|'lg'|'xl'|'2xl', boolean>
  capabilities: { hover: boolean; coarsePointer: boolean }
}
```

Bands derive from **minimum** queries only; "below md" is `!atLeast.md`,
never a separately typed `max-width: 767px` (kills D5's gap class and the
eight literals at once). `useMediaQuery` is deleted after migration (it also
fixes D12 by ceasing to exist); ThemeProvider keeps its own
`prefers-color-scheme` listener.

### C. The decision rule (goes into `docs/architecture.md` beside the header rule)

1. **Visual reflow/show-hide, same DOM** → CSS variants (`md:hidden`). JS
   must not re-implement it.
2. **Nested inside a resizable shell/panel** → container queries
   (`@min-[…]`) or ResizeObserver when JS must know the mode. Default for
   ColumnBrowser, thread docking, channel Files, split views — respond to the
   allocation, not the window.
3. **Fit-by-actual-space / overflow** → measure (the `ResponsivePageHeader`
   pattern; already mandated for headers).
4. **Different subtree, focus model, or navigation** → JS from the shared
   snapshot or the owning layout's semantic context. Never render two
   expensive trees and hide one.
5. **Continuous geometry (drag/resize)** → store the *preferred* size, derive
   the effective size from current bounds, frame-coalesce updates, persist on
   interaction end. A temporary viewport shrink never destroys the
   preference (D2, D6, D10).

### D. Platform stays orthogonal; the shell owns the composition

`ShellEnvironment` context (`runtime: web|tauri|react-native`, `platform`,
`formFactor`, `hasNativeBridge`) wraps today's `mobile-shell.ts` /
`desktop.ts` probes. `AdminShellLayout` composes environment × viewport
**once** into a semantic shell layout (`navigation: 'single'|'split'`, rail /
tab-bar / sidebar visibility, `showBack`) exposed as context + root
`data-runtime`/`data-navigation` attributes. Pages consume semantic decisions
(`singlePane`, `showBack`) — never `md` as a proxy for hardware, never
`isReactNativeWebView()` as a proxy for narrow (D4). The migration decision
for each of the eight literal call sites — "should an iPad WebView get this
behaviour?" — is made once, in review, per site.

### E. Local component contracts

- **ColumnBrowser**: observes its own inline size; pane count from a
  documented minimum useful pane width; provides
  `{visibleCount, activeColumn, goBack}` context so every hidden pane has the
  same doorway.
- **Thread panel**: ranges become complementary (`max-[900px]`+`min-[900px]`;
  1280 rejoins the shared scale as `max-xl:`/`xl:`), the 900 becomes a named
  token (`--breakpoint-panel`), and — when the surface is next touched — the
  dock decision moves to the conversation container: dock only when the
  conversation minimum + effective thread width actually fit (Verdict's
  127px problem).
- **Header**: leading width from measured content, not element truthiness
  (D7); observe the intrinsic measurement row (D8).
- **Popovers**: one shared placement primitive measuring the clipping/anchor
  ancestor (D11); no new window-resize handlers.

## Migration plan (phased, proportional)

1. **Lock the edges.** Playwright matrix at 639/640, 767/768, 899/900,
   1023/1024, 1279/1280 CSS px; sidebar min/default/max × thread
   closed/default/max; native-phone landscape; iPad split view; safe areas.
   These lock current behaviour before anything moves and satisfy the repo's
   Playwright-verification rule for every later phase.
2. **Correctness before abstraction** (no architecture yet): D1, D2, D3, D5,
   D6, D7, D9, D10, D13, D15 — each a small, independently verifiable fix.
3. **Tokens + stores, no visual change**: the `@theme static` block,
   `useViewport`, `ShellEnvironment`, root data attributes, unit tests.
4. **Call-site migration**: the eight width literals + the twelve
   `useMobileLayout`/`usePhoneLayout` consumers move to the semantic shell
   context or `useViewport` (per-site iPad decision); delete `useMediaQuery`;
   codemod only the mechanical subset (`'(max-width: 767px)'` →
   `!atLeast.md`; `min-[1280px]` → `xl:`); never auto-rewrite 900, dashboard
   bands, or overlay geometry.
5. **Per-surface container conversion**, one coherent change each:
   ColumnBrowser + consumers, thread/conversation docking, channel Files,
   then (as touched) workflow inspector / Agent Designer / Executors / Kanban
   archived / settings splits.
6. **Regression gates**: ESLint `no-restricted-imports` (retired hook),
   `no-restricted-properties` (`window.innerWidth`/`matchMedia` outside the
   store, ThemeProvider, and named geometry modules), a source lint rejecting
   viewport `min-[Npx]`/`max-[Npx]` (container `@min-*` stays legal) and
   numeric width media queries outside `styles.css` — wired into root lint
   (the `lint:migrations` precedent).
7. **Docs**: decision table + token ownership into `docs/architecture.md`;
   dashboard/container semantics documented in their owning specs.

## Reviewer divergences, resolved

- **Hook vs store**: Fable/Kimix proposed extending `useMediaQuery`; Sol
  proposed the singleton `useSyncExternalStore` store. **Store adopted** —
  one subscription set, coherent snapshots, and it structurally prevents
  arbitrary query strings (the regression the lint would otherwise chase).
- **Keep `useMediaQuery` for capability queries** (Kimix) vs **delete it**
  (Sol): **deleted** — capabilities live on the snapshot; ThemeProvider keeps
  its own raw listener (allowlisted).
- **Thread panel 900**: named token + variant rejoin now (Fable/Kimix), full
  container-based docking later (Sol) — **both, phased** (2 then 5).
- **DashboardGrid band rename** to `narrow/medium/wide` (Sol, optional):
  **deferred** — persisted schema labels; a comment marking the scale as
  local suffices until a schema migration is otherwise needed.
- Citation hygiene: both CLIs cited `thread-panel-helpers.ts` under
  `pages/channels/`; it lives in
  `components/features/channels/thread-panel/` — content claims verified
  correct at the real path.

## Acceptance criteria

- A breakpoint number is authored once, in `styles.css`; TS reads the emitted
  value; pages cannot express arbitrary layout queries (lint-enforced).
- Platform/runtime and available-space are independently testable inputs;
  native phone landscape and iPad split view keep working Back doorways.
- Nested panes react to their allocation; sidebar/thread preferences cannot
  reduce a working pane below its documented minimum.
- Dragging is frame-coalesced, cancellation-safe, keyboard-accessible;
  persistence happens at interaction end; width, state, and ARIA agree after
  any resize.
- The edge matrix and headless visual checks pass; the lint gates reject new
  raw viewport classifications.
