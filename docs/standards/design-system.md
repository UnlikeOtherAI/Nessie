# Theming and the design system

Authoritative standard, moved verbatim out of
[`CLAUDE.md`](../../CLAUDE.md) so it is read when the work touches this area
rather than loaded into every session. `CLAUDE.md` carries the one-line
summary and points here; **this file is the rule**.


- The admin is fully color-themed via CSS custom properties. **All color lives in
  `admin/src/styles.css`** — the base `:root` is the default "nebula" theme, and
  each `[data-theme="<id>"]` block re-declares the same tokens. Components carry
  **no** raw hex or Tailwind named-color utilities; they reference tokens via
  `var(--x)` / `bg-[var(--x)]`.
- Switcher: `ThemeProvider` (`admin/src/providers/`) + Appearance page
  (`/settings/appearance`); choice persists in `localStorage["nessie.theme"]`
  for logged-out screens and on `User.preferences.theme` for signed-in users, so
  web, desktop, and mobile use the same account theme.
- Adding a theme = add a `[data-theme]` block (redeclare every token) + register
  the id in `ThemeProvider`. See [docs/plans/2026-06-10-design-system-theming.md](../plans/2026-06-10-design-system-theming.md).
- **Content system (proposal, 2026-09-01).** Tables, lists, pagination, forms,
  validation, feedback, loading/empty/error states, chips, key-value views and
  confirm flows were audited across every content page; the primitives mostly
  exist and are adopted on a minority of surfaces (`QueryState` 12 files vs ~60
  hand-rolled triads, `FormFieldError` 2 files vs ~40 error lines, 11 modal
  shells outside `Dialog`). The inventory, the proposed kit, the scale and the
  phased migration are in
  [docs/plans/2026-09-01-content-design-system/overview.md](../plans/2026-09-01-content-design-system/overview.md);
  navigation, page headers, buttons and chat are deliberately outside it. One
  rule from it applies now, ahead of the kit: **no nesting** — a card
  never contains a card, a table never contains a table, a bordered box never
  sits inside a bordered box. Depth is dividers and spacing, not a second
  frame. A second rule is decided ahead of the kit too: **big elements are
  one contract from the API to the pixel.** List endpoints paginate through
  `@nessie/schemas` `PaginationParamsSchema`/`PaginationMetaSchema` (cursor
  keyset, `limit` ≤ 100, `total` required on admin lists) and the admin
  consumes them through one facade and `PaginationFooter`. The footer always
  names **Page X of Y**, its result range, and exposes the shared 10/25/50/100
  **Items per page** picker; a route that pages, sorts or reports validation
  errors differently is refactored onto the contract, never accommodated by a
  second mode in the component.
- **Fullscreen inspection is an explicit surface decision.** `ExpandableTable`
  and `DataTable` require an `expandable` choice at the call site; a CSS class
  or the current URL never decides it. Tables in Admin use `false`; tables
  that are part of Projects, Knowledge, or Channels use `true`, so the shared
  viewport keeps its horizontal-scroll behaviour without leaking an expand
  control into operational screens.
- **One segmented strip, everywhere.** Every compact single-select strip in
  the admin — detail tabs, page sections, filter segments, and inline form
  choices — is `components/primitives/TabBar.tsx` (a single sliding pill,
  `role="tablist"` or `role="radiogroup"`). `ChoiceGroup` delegates its inline
  form variant to it; explanatory card choices remain cards. Page and filter
  state lives in a URL param written with `replace`, never a history entry;
  transient form values do not. The navigation rule against another fork lives
  in [docs/navigation/overview.md](../navigation/overview.md).
- **One identity picture, one shape, one source.** Every avatar in the admin is
  `components/primitives/IdentityTile.tsx`, wrapped by the resolving primitive
  for its kind; a call site says what it depicts and never assembles a tile. Its
  radius is proportional (`identityTileRadius`) because the `--radius-*` tokens
  are re-declared on `:root`, so `rounded-md` was a flat 10px at every size — a
  96px portrait read as a square, an 18px tile a circle. An agent's picture
  resolves from its **id** through `providers/AgentIdentityProvider.tsx`, since
  `GET /api/agents` omits `systemManaged` agents — which is why the Personal
  Assistant was a portrait in the sidebar and a `⚡` in the thread panel; see
  [identity avatars](../plans/2026-09-02-identity-avatars.md).
- **One agent-visibility marker wherever identity drives an action.** Every
  agent picker and actionable agent row uses
  `components/features/agents/AgentVisibilityPill.tsx`: `Team` for a shared
  agent and a lock-bearing `Private` for a personal one. Native `<select>`
  controls use that component's text formatter because option elements cannot
  render the pill. Display names are not unique; a surface that lets a person
  choose, grant, invite, assign, or open an agent must not leave two same-named
  identities visually indistinguishable.
- **One composer, and at rest it is one line.** Every message composer is
  `components/features/channels/ChannelComposer.tsx` (six call sites): at rest a
  single line — placeholder centred beside Send, no toolbar glyphs — opening
  while focus is inside it or anything is staged. Send is pinned to the bottom
  line and the toolbar unfolds *below* the editor, so that line never moves and
  the growth reads as expanding upward. Both states hang off
  `.admin-compose[data-expanded]` and one `--compose-line` in `styles.css`.
  Focus is tracked on the `<form>` — a toolbar button blurs the editor, and
  collapsing then would pull it out from under the click.
- **One dialog shell.** Every centred modal is `components/shared/Dialog.tsx`
  on `useOverlay` (`ConfirmDialog` builds on it); drawers are `Sheet`, menus
  and pickers `Popover`, toasts `Card`. The overlay family, its layer scale,
  its Back rules and the sanctioned carve-outs are stated once in
  [docs/navigation/overview.md](../navigation/overview.md) §7 — never restate them here.
- **One page edge, and pages are full-width.** Every content page runs
  edge-to-edge — a list, table, card grid or form fills the width it is given,
  with no centred `max-w-*` reading column leaving a dead strip on the right.
  The horizontal edge is one token, `--page-gutter` in `styles.css` (`:root`),
  used by `ResponsivePageHeader`/`ScreenHeader`, the shared `PageBody` and
  `SettingsPanel` bodies, and `ColumnBrowserColumn`, so the header title lines
  up under the body on every screen and every page has the same gutter. Tune it
  in that one place, never per page; a hand-rolled page body uses
  `px-[var(--page-gutter)]`, never a bespoke `p-5`/`px-6`/`sm:px-6 lg:px-8`.
  `PageBody` therefore has **no** width prop — it is always full-width. The
  deliberate exceptions are the surfaces that are not reading columns and keep
  their own shell: fixed-height self-scrolling regions (chat, the knowledge
  team, boards, canvases, editors, the mailbox, the column-browser
  viewport) and true modals (the `/channels/new` compose dialog). A short-line
  form (e.g. a password field) still runs its section full-width but may cap the
  individual input with an inner `max-w-sm` — the cap is on the control, never
  the page.
