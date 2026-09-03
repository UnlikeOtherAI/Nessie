# Registry, Back, layout and nested stages

Chapter of [Navigation — how it is done](overview.md). §4–§6: the surface
registry and the one controller that pushes, the single Back resolver behind
every doorway, the `single | split` layout decision, and nested stages.

## 4. Registry, controller and Back — **built** (steps 3–4)

### 4.1 The surface registry — `admin/src/navigation/surfaces.ts`

One declarative table classifies every route; the vocabulary a row is written
in — the page types of §1 and the row shape — is `navigation/page-types.ts`
beside it. A row is: `pattern`, `type`
(§1, plus `redirect`), `section`, `depth`, `root`, `identityOf` / `keyScope`
(which screens are the *same* screen, so a sibling swap swaps content in
place), `parentOf(match)` → `{ label, pathname }` (what Back returns to, and
what it announces), `intent` (the params the route reads beyond its path —
§8), and optionally `parent: 'origin'`, `contextualList`,
`flowPresentation` or `fillsViewport` (a full-height surface that owns its own
inner scroller — see `page-types-and-motion.md` §2). Everything else derives from it: the lookups live in
`navigation/surface-lookup.ts` (`surfaceScreen` / `surfaceSeedChain` /
`surfaceParent` / `surfaceRootPath`, over `matchSurface`), and
`phone-navigation.ts` is a thin adapter over them, so the stack, the ledger,
`resolveBack()`, the Back doorway and the native bridge all read one table.

- **It is total.** There is no catch-all row and no fallback classification.
  `admin/test/navigation-surfaces-total.test.ts` and
  `scripts/lint-navigation-surfaces.mjs` (in the root `lint` chain) both read
  `router.tsx`, join nested child paths to their parents, and assert every
  path resolves to a row — or is one of the four the registry itself lists as
  outside the stack (`OUTSIDE_STACK_PATHS`: login, the external-auth
  completion, bootstrap, not-found). **Adding a route means adding its row**;
  the lint is what makes that unmissable. The old `admin:detail` catch-all is
  deleted, and because classification can no longer fail, the shell mounts the
  phone viewport unconditionally.
- **Depths** (plan §4.1): `/threads` and `/unread-messages` are Channels
  details at depth 1, `/channels/new` a Channels Flow at depth 1; `/agents` 1,
  `/agents/:id` 2, both designers Flows at 2 returning to the list they edit,
  the four automation browsers 1; every settings page 1 with
  `/settings/statuses/:id` at 2; `/ops` 1 and `/ops/usage` 2; `/apps` 1 and
  `/apps/:slug` 2; `/audit`, `/approvals`, `/tokens`, `/policy` 1. A project's
  seven section routes are one `tabHost` identity, so switching sections never
  animates.
- **`parent: 'origin'`** (`/alerts`, `/feedback`): reached from the bell, the
  account menu and push notifications, from any section, so Back pops to the
  reader's real predecessor when the ledger has one and falls back to the
  Admin root only on a cold deep link.
- A page that auto-selects its first row must not do so on a phone once its
  detail is a real pushed screen: the redirect would slide a detail in on
  arrival and re-slide it on every Back. `ChannelsPage` and `StatusesPage`
  both gate that on `usePhoneLayout()`.

### 4.2 The controller

The controller is `PhoneNavigationProvider` (one instance around the
authenticated shell; the name follows in a later rename). It owns:

- **One ledger** (`phone-navigation-ledger.ts`): every PUSH / REPLACE / POP the
  router commits. `navigation/history.ts` derives `canGoBack`, `canGoForward`
  and the last path per section from it. The desktop top bar, the iPad
  toolbar and the rail read those; none keeps a counter of its own.
- **One Back decision**: `navigation/back.ts` `resolveBack()` — the topmost
  registered owner (the local-back registry: an open overlay, the deepest
  nested stage), else the route's parent (pop when the ledger's previous
  entry is it, else replace), else nothing at a root. `performBack()`,
  `PhoneNavigationButton`, the edge swipe, `nessie:back-state` and Android
  hardware Back all go through it. An owner may register `swipeable: false`.
  A `parent: 'origin'` screen (`/alerts`, `/feedback`, `/ops/usage`) pops to
  the reader's real predecessor and its control says only "Back"; on a cold
  link it replaces to the declared fallback and names it.
- **History controls are not Back.** The top bar and the iPad toolbar walk
  the ledger across sections, which Back never does; they consult the
  registry first so they never pop a route under an open owner.
- **`back({ returnTo, returnToState, fallback })`** is the shared smart Back:
  an explicit return address wins, else a real previous entry pops, else the
  fallback replaces. The two designers use it; nobody reads
  `history.state.idx` any more.
- **`redirect(to, { state })`** (`navigation/redirect.ts`, also
  `useRedirect()` for components outside the provider) is what every
  effect-driven navigation calls: it replaces, forwards state, waits for the
  stack to settle (`transition-state.ts`), and is dropped if the location
  moved on. The first-channel and first-status auto-selects, the session
  redirects, the call, message-highlight and DeepWater intent consumers and
  the landscape rotation redirect all use it.
- **`useStackSettled()`** tells a screen when its slide has landed.

- **`RedirectRoute`** (`navigation/RedirectRoute.tsx`) is the only
  route-level redirect: it replaces and forwards `location.state`, so a
  notification deep link or a return address that lands on a retired path
  (`/work`, `/chats`, `/settings/tools`, …) arrives intact. `router.tsx`
  never renders a bare `<Navigate>`
  (`admin/test/navigation-redirect-route.test.ts`).
- **The revealed layer is dimmed.** Every screen carries one
  `[data-phone-navigation-dim]` child, a `--scrim`-coloured overlay that is
  fully present while another screen rests over it and gone once that screen
  is away. `stackPoses().dim` gives its opacity, `runStackTransition` animates
  it on the bottom layer beside the transform, and the edge swipe drives it
  inline with the finger — the same three callers, the same numbers, so a
  push, a pop and a released swipe dim identically.

- **A committed swipe gives one `light` haptic** (`lib/haptics.ts`, §10) at
  the moment the settle lands and the route is about to change. A cancelled
  swipe and a tapped Back give none.

The single Back glyph in every header on every layout is `ScreenHeader`'s
leading lane (§9), which renders `PhoneNavigationButton` — the one resolver's
answer — wherever a Back paints.

## 5. Layout — **built** (step 5)

`navigation/layout.ts` `deriveNavigationLayout()` is the one composition of
shell probes × viewport bands into `'single' | 'split'`, read through
`useNavigationLayout()` (`lib/mobile-shell.ts`):

- `single`: phones, narrow web, an iPad in a narrow Split View — one stack
  over the whole content region, Roots included.
- `split`: tablet, desktop, large-phone landscape — the pinned list column
  beside detail stacks.

The native shell decides by its named form factor, never by width alone, so
a phone cannot become multi-column by rotating. The shell frame carries
`data-navigation` with the value. `usePhoneLayout()` survives only as
`navigation === 'single'`; no page reads a breakpoint to decide its
container. Pinned by `admin/test/navigation-layout.test.ts`.

On `split` the shell's detail column (`main`) mounts the same stack
(`PhoneNavigationViewport layout="split"`), and the registry reads
differently there (`surfaceScreen(pathname, layout)`):

- The pinned list column *is* the section's root, so a root and its details
  share the stack floor (depth 1): root → detail swaps in place with nothing
  retained beneath; detail → nested (`/agents` → `/agents/:id`, `/apps` →
  `/apps/:slug`, `/dashboards` → `/dashboards/:id`, a designer) pushes inside
  the column with the detail retained beneath, exactly as on a phone.
- A nested row whose parent page renders it itself on split declares
  `splitInline: true` (the conversation's info chain and reply thread, a
  status's detail) and classifies as its parent's screen there, so it neither
  pushes nor animates. Declared per row, never inferred.
- No edge swipe arms on split: the column has no edge of its own, and on
  iPad the native swipe stays on until step 9.

Verified in the browser at 1280×800 and 768×1024: `/agents` →
`/agents/designer` slides inside the detail column over the dimmed, retained
list and pops back; a conversation → its info and a status list → a status
stay one layer. The page-owned detail columns (Knowledge, the column
browsers, Dashboards) join the stack as nested stages in step 6; the thread
panel becomes a nested stage on `single` and a `Sheet` on `split` in step 8.

## 6. Nested stages — **built** (step 6)

A nested stage is a state-driven screen a page pushes over its own route: a
column browser's next column, a Knowledge folder → document → history →
editor, a dashboard's add-widget panel. It is **one component**,
`navigation/NestedStage.tsx`:

```tsx
<NestedStage id="document" label="Back to folder" active={open} onBack={close} priority={12}>
  …
</NestedStage>
```

- **On a single-column layout it is a layer in the stack**, keyed
  `stage:<id>` one depth above whatever it was pushed over
  (`phone-navigation-stack.ts` `pushPhoneNavigationStage` /
  `popPhoneNavigationStage`). It slides in with the same `runStackTransition`
  as a route, is retained inert under whatever is pushed over it (a route
  pushed over an open stage returns to that stage on Back, not to the list
  beneath), unwinds with Back through the one resolver (it registers with
  the local-back registry as `stage:<id>`), and the edge swipe drives it
  when it is the top layer and `swipeable` (the default). A same-route
  re-render refreshes the route beneath it (`refreshPhoneNavigationRoute`)
  and never touches the stages.
- **The page keeps rendering it.** The content goes through a portal into
  the layer's container, so context, state and providers never leave the
  page; only the DOM moves. Keep the stage mounted and toggle `active` — an
  unmount leaves without motion.
- **Where no stack hosts stages** — a split layout's detail column, a test
  without a viewport — the stage renders inline where it stands and the page
  composes it (the column browser's multi-column track, Knowledge's
  columns). Nothing reads a breakpoint to decide this; the host's presence
  does.
- **Ownership is per instance.** A push over an open stage mounts the page
  again for the new route, so two instances render the same stage id; only
  the instance that pushed the entry may pop it, or the second one's unmount
  would close the first one's open document.
- Pinned by `admin/test/nested-stage-viewport.test.ts` (push, Back, swipe,
  retention under a route) and `admin/test/phone-navigation-stack.test.ts`.

Adopters, all **built**: `ColumnBrowserViewport` — on
`single` column 0 renders inline (it *is* the page) and every column beyond it
is a `stage:column:<k>` layer at `columnBackPriority(k)`, with a `stageScope`
prefixing the ids where one page could mount two browsers; only a column knows
its own title and unwind action, so it reports `{ label, onBack }` up through
the column context in a layout effect and the viewport owns the single
registration (the stage's, or its own local-back owner for a Back-owning column
0, as Workflows' failed-runs column is) — `ColumnBrowserColumn` no longer calls
`useLocalBack` and `PhoneNavigationButton` no longer reads the column context,
because a retained column is no longer rendered at all; on `split` it keeps its
multi-column track, now moved with `var(--nav-duration)`/`var(--nav-easing)`
rather than a `transition-transform duration-300` utility. `ExecutorsPage`'s `ExecutorCreatePanel` (`executors:create`) and
`DashboardDetailPage`'s `AddWidgetPanel` / `DashboardVersionsPanel`
(`dashboard:add-widget`, `dashboard:versions`) are `NestedStage`s — a phone
full screen, today's fixed-width side panel unchanged on `split`.

**Knowledge is built.** `KnowledgeWorkspace` registers no Back of its own;
its four inner screens are stages — `knowledge:folder` (11, a folder browsed
beyond the space root), `knowledge:document` (12, the open document or file),
`knowledge:history` (13) and `knowledge:editor` (14, `swipeable={false}` for
as long as it is open, because `PageEditor` holds its draft in its own state
and publishes no dirty signal). Each keeps the label and the one-level unwind
the single registration used to carry, and the priorities stay
`LOCAL_BACK_PRIORITY`. `animate-kb-view-slide` and its keyframes are deleted:
the stack owns the motion, and `phone-navigation-transition.test.ts` pins the
name out of `admin/src` entirely. Which stages are open is derived from the
provider's own state, and the composition follows the host rather than a
breakpoint (`useNestedStageHosted`): a stack shows every open stage as its own
layer, with the space's root listing kept in the route layer beneath an open
folder — the screen it was pushed over — while an inline host renders only the
deepest pane, exactly the desktop columns, full-width document, history and
editor of before. Pinned by `knowledge-local-back.test.ts` and the
three-layer unwind case in `nested-stage-viewport.test.ts`.

**`AgentDetailPage` is built.** It registers no local Back: `/agents/:id` is a
real depth-2 route whose parent is Agents, so the shared route Back returns
there. Its old `columnBase` registration outranked every Knowledge stage
inside the agent's Documents tab, so Back left the agent instead of unwinding
the open document. Wider layouts keep the page's own Back button beside the
title.

