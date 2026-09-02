# Verification, the settle, and interruption

Chapter of [Navigation — how it is done](overview.md). §11–§13: the real-browser
transition suite and the lint gates around it, what a landed screen settles
(focus, announcement, scroll), and what an interruption or a hidden document
does to a running slide.

## 11. Verification — the transition suite — **built** (step 2)

The JSDOM harness cannot see an animation and cannot see a layout, so the
motion itself is pinned in a real browser:
`admin/e2e/navigation/` (run it with
`pnpm --filter @nessie/admin test:e2e:navigation`).

What it does, per run:

- starts the real API on 5454 and the real admin on 5455 against
  `DATABASE_URL` — a server already listening on either port is used as it
  stands, so it costs nothing next to a running `pnpm dev`;
- signs in through the product's own doors — the one-time owner bootstrap on
  a fresh database, `GET /api/auth/dev-login` on a database that already has
  an owner — and seeds one organisation with its project and two channels
  through `POST /api/channels`;
- drives Chromium (`playwright-core`, no `@playwright/test`) at 390×844,
  768×1024 and 1280×800.

What a case asserts. It **freezes the real animation** rather than timing it:
a `requestAnimationFrame` watcher pauses every animation that appears on a
`[data-phone-navigation-layer]`, then `currentTime` is seeked to 0 %, 50 %
and 100 % and each frame is measured with `getBoundingClientRect()`. There is
no sleep anywhere in the measurement. `document.getAnimations()` is the seam
on purpose: it sees a CSS keyframe animation and a Web Animations one alike,
so the suite survived the step-2 rewrite unchanged. Every frame also asserts
`scrollLeft === 0` on `.phone-navigation-viewport` and on every
`.phone-navigation-screen` — that is §2's bounce, measured.

| case | viewport | what it pins |
| --- | --- | --- |
| `phone-push` | 390×844 | tapping a channel row: the conversation travels 100 % → 0, the list 0 → -28 % |
| `phone-back` | 390×844 | header Back: the conversation travels 0 → 100 %, the list -28 % → 0 |
| `phone-edge-swipe` | 390×844 | a touchscreen swipe from x=8 to x=300 commits Back; the settle runs from exactly the released displacement to the ends |
| `phone-tab-switch` | 390×844 | Messages → Files moves nothing: no layer animates, the screen's rect is unchanged |
| `tablet-select` | 768×1024 | selecting a channel in the split stack is an in-place swap: one layer, nothing animates, the columns keep their geometry |
| `desktop-select` | 1280×800 | the same at desktop width |
| `tablet-split-push` / `desktop-split-push` | 768×1024 / 1280×800 | Agents → the designer pushes inside the detail column: the designer travels 100 % → 0 of the column, the list 0 → -28 %, the pinned sidebar never moves |
| `phone-cold-start` | 390×844 | a cold link to a conversation seeds the channel list beneath it; header Back slides the conversation away over that list (0 → 100 %, -28 % → 0) |
| `phone-intent-strip` | 390×844 | `#trigger-<id>` and `?messageId=` are consumed and stripped with a replace: the address settles on the screen, the linkable `?tab=` stays, and browser Back lands on the stripped address |

Each transition case navigates once per saved frame, deliberately: the stack
closes its own transition on a fallback timer shortly after the animation's
nominal end, so one run cannot hold a frozen frame for three screenshots —
while all three fractions are measured inside one synchronous `evaluate`,
far inside that window. Frames land in `e2e/screenshots/navigation/<case>/`
(`00-start`, `01-midway`, `02-settled`) for the eyeball rule in `AGENTS.md`.

Where it runs:

- **CI** — the `navigation-e2e` job in `.github/workflows/ci.yml`: Postgres 16
  + pgvector, `prisma migrate deploy`, a built admin bundle
  (`NAV_E2E_ADMIN_MODE=preview`), `pnpm exec playwright-core install
  --with-deps chromium`, and the frames uploaded as the
  `navigation-transition-frames` artifact.
- **Locally** — `DATABASE_URL=… pnpm --filter @nessie/admin test:e2e:navigation`.
  Useful switches: `--case=phone-push` / `--viewport=phone` to narrow,
  `CHROMIUM_PATH` to name a browser binary, `NAV_E2E_ADMIN_MODE=preview` to
  serve `admin/dist` instead of the dev server, `NAV_E2E_SERVER_LOGS=1` to see
  the servers' output, `NAV_E2E_KEEP_SERVERS=1` to leave them up.
  With no reachable database the suite prints why and exits 0 — everything it
  asserts needs a running product, and a red run that only means "no Postgres
  here" teaches people to ignore it.
- **On device** — iPhone and iPad checks stay manual; the plan lists them per
  step.

**What it caught first.** `phone-back` was red on its first run: the route
pop painted only the returning list, because `advancePhoneNavigationStack`'s
same-depth branch truncated every entry above `currentIndex` on the first
re-render of the destination (its data settling is enough), and after a Back
the outgoing screen *is* that entry. The stack now refreshes a same-route
re-render in place and releases the entries above only for a sibling swap;
`admin/test/phone-navigation-stack.test.ts` replays the route mid-Back to
pin it. The JSDOM stack test had passed because it never replayed a route —
the browser suite is what sees it.

### Gates — **built** (step 15)

The framework stays the only way because a second one cannot compile, lint or
test green. Each gate below ships with an allowlist that only ever shrinks —
seeded from real offenders at the time the gate landed, deleted line by line
as the parallel conversion work lands elsewhere, never regrown, never a flag
day.

| gate | mechanism | allowlist lives in |
| --- | --- | --- |
| literal z-index (`z-[n]`, `z-N`, `zIndex:`, `z-index:`) outside `var(--layer-*)` / `OVERLAY_LAYER` | `scripts/lint-layers.mjs` (`pnpm lint:layers`, wired into root `pnpm lint`) | a `Set` of file paths at the top of the script |
| `scrollIntoView(` inside a `useLayoutEffect` callback | ESLint `no-restricted-syntax`, `eslint.config.js` | none needed — zero uses today |
| `autoFocus` / `.focus()` without `preventScroll` on a screen root (`admin/src/pages/**`, `admin/src/layouts/**`) | ESLint `no-restricted-syntax`, `eslint.config.js` | the block's own `ignores:` list |
| `navigate(` / `useNavigate` outside `admin/src/navigation/**` | ESLint `no-restricted-syntax`, `eslint.config.js` — declared **off** until controller.push exists (step 13) | n/a while off |
| `overflow: hidden` / `overflow-hidden` on a stack container | source-regex test, `admin/test/navigation-gates.test.ts` | none needed — the four containers are pinned clean |
| a new `phone-navigation-*`/`kb-view-*` `@keyframes`, or a `transition:` inside a `.phone-navigation-*` rule | source-regex test, `admin/test/navigation-gates.test.ts` | an array in the test file |
| every `router.tsx` path present in the surface registry | `scripts/lint-navigation-surfaces.mjs` (`pnpm lint:navigation-surfaces`), also `admin/test/navigation-surfaces-total.test.ts` | n/a — the registry is total by construction (§4.1) |
| a `role="dialog"` surface without `Dialog`/`ConfirmDialog`/`Sheet`/`Popover`/`useOverlay(` | source-regex test, `admin/test/navigation-gates.test.ts` | an array in the test file, self-checked against `git ls-files` |
| `animate-pulse` markup outside `components/primitives/Skeleton.tsx` | source-regex test, `admin/test/skeleton.test.ts` | an array in the test file, self-checked against `git ls-files` |
| a facade `useQuery` keyed by, or gated on, an entity id without `placeholderData: keepPreviousData` | source-regex test, `admin/test/skeleton.test.ts` | an array in the test file (billing only, §12) |
| a `/api/` URL literal inside `navigation/prewarm.ts`, and every wired row spreading `prewarmRowHandlers` | source-regex test, `admin/test/prewarm.test.ts` | the wired-row list in the test file |

## 12. Focus, announcement and scroll — **built** (step 11, the settle)

The stack settles a slide, never mid-slide (`navigation/settle.ts`):

- **Push**: focus the landed screen's `h1` with `preventScroll` (a focus
  that scrolls is how the bounce was made; the heading gets `tabindex=-1`
  if it lacks one). **Pop**: focus the retained screen's `h1` only if the
  popped screen held focus, so a person tabbing through a list keeps their
  place when a detail above it closes. Overlays move focus in and restore it
  on close through `useOverlay` (§7).
- **One polite live region** (`PhoneNavigationProvider`,
  `data-navigation-announcer`) announces the settled screen's heading,
  debounced, so two settles inside the window announce once with the later
  title. Overlays announce through their own dialog semantics, never both.
- **A push blurs the active element** explicitly before the slide, so a
  composer's soft keyboard closes on purpose rather than because the
  outgoing layer became inert.
- **Scroll**: the browser's restoration is `manual` at the root
  (`main.tsx`); retained layers keep their position for free, a fresh push
  starts at 0. Per-layer `useScrollMemory` on `split` and the second-scroller
  lint are still planned.
- Pinned by `admin/test/navigation-settle.test.ts`.
- **`aria-current="page"`**: the rail item and every section-sidebar row that
  carries an `active` class set it through one shared helper,
  `sidebarAriaCurrent` (`layouts/admin-shell/SidebarRow.tsx`) — the rail,
  `SidebarNav` and its four section components, `AdminSidebarNav`,
  `KnowledgeSidebarNav` (plus `KnowledgeSpaceList`, shared with the project
  Docs tab), `ProjectsSidebarNav`, and the personal-assistant sidebar entry.
  The one `NavLink` row (Knowledge's "All dashboards") already gets it for
  free — React Router stamps `aria-current="page"` on an active `NavLink`
  itself, so that row needed no change.
- **Skip link**: `<SkipToContentLink />` (`navigation/SkipToContentLink.tsx`)
  is the first element inside the authenticated shell, before the top bar and
  rail. Visually hidden (Tailwind `sr-only`) until it receives focus
  (`focus:not-sr-only`), styled from theme tokens only per CLAUDE.md →
  Theming. It targets `#admin-shell-main` — both `<main>` branches in
  `AdminShellLayout` (phone and split) carry `id={SHELL_MAIN_ID}` and
  `tabIndex={-1}` so a non-heading landmark can still take programmatic
  focus.
- **`forced-colors`** (Windows High Contrast): `styles.css` carries one
  `@media (forced-colors: active)` block giving the four places that carried
  their state through colour alone a `Highlight`/`CanvasText` border or
  outline instead — `TabBar`'s `.tabbar-indicator` (its ring was a
  `box-shadow`, which forced-colors discards), the rail's active tile (its
  `color-mix` background collapses to every other tile's forced background),
  every `:focus-visible` ring (an accent outline forces to ordinary text
  colour otherwise), and `.admin-card` / `.admin-input` borders (a
  `var(--sep)` border can force to the same colour as the card's own
  background).
- **Soft keyboard inset**: one `visualViewport` resize listener for the
  whole shell (`navigation/keyboard.ts` `useKeyboardInset`, mounted once in
  `AdminShellLayout`) sets `--keyboard-inset` (px) on the root while an
  on-screen keyboard is open — the gap between `window.innerHeight` and the
  shrunk `visualViewport`, ignoring deltas under 60px (browser chrome, not a
  keyboard). The channel composer's container and the standalone
  new-conversation composer read it (`padding-bottom` /
  `margin-bottom: var(--keyboard-inset, 0px)`) so the active composer stays
  above the keyboard instead of sliding under it; the message composer's
  editable region carries `enterKeyHint="send"`. Every overlay panel that
  sized with a bare `vh` unit — nine dialogs/popups plus two `styles.css`
  rules — now sizes with `dvh` (the dynamic viewport, which a soft keyboard
  can shrink; the static `vh` cannot), including the shared `Dialog`'s `xl`
  size.
- **Scroll owners on split**: `useScrollMemory` already covered the two
  lists that swap for their own detail at stack depth 1 on `split`
  (`ColumnBrowserColumn`, `AgentsList`, keyed per list identity). The channel
  list and the knowledge tree — the persistent per-section sidebars
  (`SidebarNav`, `KnowledgeSidebarNav`) — get the same treatment, keyed by a
  constant per-section id (`sidebar:channel-list`,
  `sidebar:knowledge-tree`) rather than a pathname: unlike a route's own
  screen, these single scrollers are shared across every route inside their
  section and only lose position when the section itself swaps out for
  another (Channels → Knowledge → Channels) and back.
- Pinned by `admin/test/a11y-navigation.test.ts`.

## 13. Interruption and visibility — **built** (step 14)

- **A navigation arriving mid-slide settles the running slide first**: its
  end pose commits, its released entries drop and its settle runs, then the
  new transition starts from a clean stack. Nothing preempts a half-finished
  pose, and no stale entry survives an interrupted Back.
- **A hidden document never holds a half-finished pose**: a slide that
  starts while the tab is hidden commits at once (0 ms through the same
  path), and hiding the tab mid-slide finishes it, so a tab that comes back
  is already settled. `redirect()` (§4) already waits for the stack.
- **Pull-to-refresh is the web's.** In the native shell a Root or Detail
  page scroller that holds no message feed (`data-message-feed`) offers a
  pull from its top; past the threshold it asks the shell for the one full
  refresh it already has (`nessie:full-refresh`), the same on iOS and
  Android. Nested screens, flows, stages, seeded layers, boards, editors
  and feeds never offer it. The native WebView's own pull-to-refresh is
  turned off with the mobile step (`navigation/pull-to-refresh.ts`).
- Pinned by `admin/test/navigation-interruption.test.ts` and
  `admin/test/pull-to-refresh.test.ts`.

