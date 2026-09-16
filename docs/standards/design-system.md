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
  (`/settings/appearance`); the choice persists on `User.preferences.theme` for
  signed-in users, so web, desktop, and mobile use the same account theme, and
  in **three** `localStorage` keys for the logged-out screen and for a themed
  first paint — `nessie.theme.choice` (what the person picked, written only by
  the picker), `nessie.theme.applied` (what was last on screen) and
  `nessie.theme.css` (the organisation palette's rule, a hint the API's answer
  replaces on every load). They replaced the single `nessie.theme`, which
  conflated a choice with a default: the apply effect wrote its own default
  back as though it were a pick, and first sign-in copied it onto the account,
  so every row read `'sandstone'` and no organisation default could ever reach
  an existing person.
- Adding a theme = add a `[data-theme]` block (redeclare every token) + register
  the id in `ThemeProvider`. See [docs/plans/2026-06-10-design-system-theming.md](../plans/2026-06-10-design-system-theming.md).
  The id is also listed in `admin/index.html` (first paint), `theme-storage.ts`,
  `UserPreferencesSchema` in `@nessie/schemas`, and `SsoThemeSchema` +
  `UOA_SIGN_IN_THEMES` in the API, which hand the hosted sign-in page concrete
  colours.
- **The default theme is `nessie`** (`DEFAULT_THEME`, `theme-resolution.ts`):
  the icon's navy (`#0b172a`) for the top bar and rail, a lighter violet-leaning
  navy (`#232646`) for the sidebars, and a white work surface. The text tokens are global — the sidebar draws `--tx` on `--sb`
  — so a theme whose chrome and surface differ in lightness cannot be one
  block. Its `[data-theme="nessie"]` block holds the surface's tokens, and a
  `:where([data-theme="nessie"])` rule beside focus mode re-scopes the navy
  tokens onto the chrome elements. `:where()` keeps that rule at focus mode's
  specificity, and focus mode is declared after it, so focus mode still wins.
  Overlays render outside the shell and take the surface palette.
- **One theme is data, not CSS: the organisation's own.** An organisation
  administrator authors a palette on `/settings/organization?tab=appearance`; it
  appears as one more card on the per-user Colours panel, labelled with the
  organisation's name, and is the default for anyone who has not chosen. It is
  **colours only** — type, radii, spacing and motion are `:root`
  in `styles.css` and are not authorable, which the `.strict()` four-field seed
  schema enforces at the wire. The admin authors four seeds
  (appearance, accent, surface, optional sidebar) and `@nessie/schemas`
  `organization-theme.ts` derives the other forty-eight tokens; that derivation
  lives in the shared package for the `secret-precedence.ts` reason — the API
  refuses a palette that fails a contrast floor and the admin previews the same
  one, so two derivations would be two themes. `ThemeProvider` keeps the result
  in one runtime-filled `<style id="nessie-organization-theme">` declaring
  `[data-theme="organization"]`, so switching stays a single `data-theme` write
  and picking a built-in makes it inert — inline custom properties on the root
  element would instead beat every `[data-theme]` block until removed by hand.
  `THEME_TOKENS` is pinned against the stylesheet by
  `admin/test/organization-theme-tokens.test.ts`: a token added to the built-ins
  without a derivation rule fails CI rather than rendering as the `@property`
  registration's black. The palette is tenant state and deliberately does not
  reach `/login`, which is instance state (the `instanceBrand` doctrine).
  There is no lock — an organisation theme is a default, never a mandate, since
  forcing one takes High Contrast away from the person who needs it. Full
  design, formulas and contrast floors:
  [docs/plans/2026-09-05-organisation-custom-theme.md](../plans/2026-09-05-organisation-custom-theme.md).
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
- **A page-header action is styled by the role it declares.** The header is
  where a screen says what a person can do here, so its controls carry a box:
  `ResponsivePageHeader` puts `.admin-page-action` plus one role class on every
  action, `styles.css` owns the fill, and the utilities that stay at the call
  site own the box (height, width, gap, padding — deliberately unclaimed by the
  unlayered rules). Colour spelt as utilities instead is how the row's hover
  rule ended up with nothing to attach to, leaving a stylesheet rule live in
  the file and dead on the screen. The roles:
  - `primary` (filled with `--accent`) — **the one action the screen exists
    for. Creating the item the screen lists is always primary**, as is
    committing an edit in progress (Save, Publish, Done, Send invitation).
  - `selected`, and a menu that is open (tinted with `--accent-soft`) — a
    control that is currently on. Tinted, never filled, so it does not
    outrank the primary.
  - everything else (bordered, `--overlay-weak`) — secondary.

  **One primary per header.** Two filled buttons name no decision, so where a
  creation and a commit meet, the commit wins and the creation drops to
  secondary — the Knowledge reader fills Publish while a page is a draft and
  New page only once it is not; Knowledge's space header fills New page and
  leaves New folder and Upload file beside it; a dashboard being arranged
  fills Done, not Add widget. Re-reading a screen (Refresh) and closing a
  panel are never primary. A label never draws its own mark — "+ Add widget"
  is `icon: faPlus` and the label `Add widget`. Every hover and focus rule is
  guarded with `:not(:disabled)`: the rules are unlayered, so a bare `:hover`
  beats the `opacity-50` utility marking a disabled action and repaints the
  one cue that it cannot be pressed, exactly as the pointer arrives.
  Every header action has a 44px target; compact icon actions are 44px squares.
  `admin/test/page-header-actions.test.ts` holds all of this, and
  `pnpm --filter @nessie/admin test:e2e:page-header` screenshots every theme's
  header into `e2e/screenshots/page-header/`.
- **One segmented strip, everywhere.** Every compact single-select strip in
  the admin — detail tabs, page sections, filter segments, and inline form
  choices — is `components/primitives/TabBar.tsx` (a single sliding pill,
  `role="tablist"` or `role="radiogroup"`). `ChoiceGroup` delegates its inline
  form variant to it; explanatory card choices remain cards. Page and filter
  state lives in a URL param written with `replace`, never a history entry;
  transient form values do not. The navigation rule against another fork lives
  in [docs/navigation/overview.md](../navigation/overview.md).
  **Below the width its labels need, the strip is a dropdown** naming the
  current selection — not a row that scrolls, which hides the very options it
  exists to offer. That is a measurement, never a breakpoint: the same strip
  collapses inside a narrow side panel on a desktop and stays a strip on a
  phone when it holds two short words, and only measuring tells those apart.
  The decision is `components/primitives/tab-bar-fit.ts`, kept pure because a
  `ResizeObserver` feeds it and browsers stop delivering one to a hidden tab.
  A call site may pass `collapse="never"` only where the row is known to fit.
  Full-width strips therefore floor each item at `min-width: max-content`:
  without it a shortage is absorbed by crushing labels into each other and the
  strip never reports the overflow that would turn it into a dropdown.
  **`fullWidth` means the inline axis and only the inline axis.**
  `.tabbar-shell-full` is `width: 100%` and carries no `flex-grow`: a row needs
  none, because the default `flex-basis: auto` already resolves to that width,
  while a flex **column** reads grow along its own main axis — which is
  vertical. Both mailbox asides are `flex-col`, and a grown shell there took
  every pixel the conversation list was not already using: a 32px strip
  rendered 363px tall in a 420px column and the list under it became a sliver.
  `pnpm --filter @nessie/admin test:e2e:tabbar-full` measures the shell in
  every container a call site puts it in; a new `fullWidth` call site adds its
  container to that fixture.
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
- **One actor name, and it is never an id.** The two governance surfaces —
  `/approvals` ("which agent is asking") and `/audit` ("which agent did this")
  — name their actor through `components/shared/ActorName.tsx`
  (`useActorNames` + `<ActorName>`), which resolves an agent through
  `providers/AgentIdentityProvider.tsx` for the reason above and a person
  through the `users` directory. Both screens used to print eight characters of
  a uuid (`Agent: a0000000`, `agent:a0000000 → email_message`) while the
  roster, the agents table, the channel agent panel and the chat feed all
  showed the name, which defeats the one question each screen exists to
  answer. Three rules travel with the component: the kind word (`person`,
  `agent`, `service`, `system`) is always printed beside the name, because a
  name alone cannot tell the person who approved something from the agent that
  asked; an actor no directory can name falls back to its short id, never to a
  blank or a generic "Agent"; and the exact id stays on the element's `title`
  either way, since the trail's value is being able to identify the exact row.
- **One agent-visibility marker wherever identity drives an action.** Every
  agent picker and actionable agent row uses
  `components/shared/AgentVisibilityPill.tsx`: `Shared` for an agent that
  works in shared channels and a lock-bearing `Private` for a personal one.
  Shared discovery follows channel visibility; addressing still requires the
  channel's posting authority. It is not organization-wide discovery or a
  placement grant. Native `<select>`
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
- **A navigational page takes the menus' colour, not the work surface's.** A
  screen a person passes *through* — a project's Overview, reached from both
  the Projects sidebar and the Channels rail — is chrome that happens to sit in
  the content area, and it is painted as such: `.admin-nav-surface` in
  `styles.css`, applied to the host's outer `<section>` so the page header is
  painted with the body it titles rather than left as a white band above it.
  Pages that are *worked in* — boards, the docs reader, settings, chat — keep
  the white work surface, so the two kinds of screen are told apart before a
  word is read.
  The class is listed with the topbar and the sidebars in the
  `:where([data-theme="nessie"])` chrome rule, since in the default theme the
  navy palette exists only there; it carries that rule's two `:not()` guards so
  focus mode still wins, and repeats them on its own declaration, which would
  otherwise lose to it on specificity. The page is `--sb` lifted one step
  toward `--tx`: exactly `--sb` and it merges into the sidebar beside it, and
  on a theme whose menus are already white there would be no step at all.
  Cards on it lift toward `--surface-inverse` — each theme's near-white —
  because mixing toward `--tx` inverts the stack on the light themes.
  Colour on such a page is a **tone**, named for what a destination is
  (`work`, `people`, `knowledge`, `config`), never for the token it borrows:
  one `--tile` declaration per tone in `styles.css`, everything else written
  against it. Focus mode flattens every tone to `--tx3`, because a screen that
  exists to be quiet cannot have the loudest thing on it be navigation.
  The doorways themselves are **derived, never restated**: the Overview grid is
  built from `navigation/project-sections.ts` in
  `components/features/projects/project-navigation-tiles.ts`, so a section
  added to the sidebar appears on the Overview without anybody remembering it
  (AGENTS.md → "Rule zero"). Copy for a section is an exhaustive
  `Record<ProjectTileSectionId, …>`, so a new section fails to compile rather
  than rendering an unexplained coloured square. Channels and People are the
  two deliberate non-sections in that grid: they have no route of their own,
  and the page below no longer lists them, so the grid is where they live or
  they are nowhere.
- **A live thing in a tile is the live thing, scaled — never a picture of
  one.** A project's dashboards are tiles in its Overview grid, continuing the
  coloured navigation cards rather than forming a band of their own: going to a
  dashboard is navigation, so it belongs with the other places a person can go.
  Each renders `components/features/dashboards/ScaledDashboard.tsx` — the same
  `DashboardCanvas` the full page renders, through the same authenticated
  client, CSS-scaled — which is also what a dashboard posted into a
  conversation renders. There is no dashboard-shaped second implementation to
  drift, and the tile enforces the viewer's ordinary entitlement because it is
  the real thing.
  Three mechanics make that work and are easy to get wrong:
  `transform: scale()` does not change layout size, so the inner canvas is
  positioned **out of flow** — in flow, a CSS-sized frame grows to the canvas's
  full unscaled height and a tile becomes a thousand pixels tall. The canvas is
  laid out at a **fixed width that picks its breakpoint** (`DashboardGrid`: lg
  ≥ 1200, md ≥ 768, sm below) and then scaled, so a tile uses the `sm` width
  and gets widgets that fill it, rather than the `lg` arrangement shrunk into a
  smudge in one corner. And the frame takes its height from **the grid row**,
  never from measuring its own content, or the tile becomes the tallest thing
  in its row and stretches every fixed doorway beside it. The scaled copy is
  `inert` and `aria-hidden` with one button over it: the real dashboard is one
  tap away and is where every control works.
- **A tile carries what is in it; the page below carries what a count cannot
  say.** Overview had Members on it three times — the header button, the tile,
  and a summary card — because a card was the only way a count reached the
  screen. Each tile now states its own ("12 open", "4 people", "2 channels"),
  and only where the number is *true*: a capped read knows the newest document
  but not how many exist, so Docs says `updated 2h`, and Executors are an
  organisation-wide pool, so a project-scoped count would be invented. Nothing
  shows a zero — a tile still loading and a tile with nothing behind it both
  say nothing rather than "0 people".
  What is left below is the two things a count cannot say, in two columns:
  **where the work is** (`projectWorkQueue` — the reader's own open tickets,
  falling back to what nobody has picked up, then to everything open, and the
  card *names* which of the three it chose, because an unlabelled list of
  somebody else's tickets reads as yours) and **latest documents**. The columns
  are `auto-fit` over exactly two children, so they are two where they fit and
  one where they do not, never three. Each column is its own `@container`, so a
  row restacks on the column's width rather than the window's — the same
  dashboard is narrow behind a chat shell on a desktop and wide on a phone in
  landscape.
- **One sign-in surface, and it is the homepage's doorway.** The admin login
  (`/login`) and the public landing (`nessie.works`) are the same screen:
  `packages/sign-in-surface` owns the layout (`SignInSurface`), the showcase
  panel, the app-download tiles and the shared copy, and ships only
  `.signin-*` classes that read host tokens. The admin supplies its themes;
  the landing imports the package's `tokens.css`, which owns the doorway
  palette for that themeless host — the marketing site's deep-water values, so
  the doorway and the pages behind it are one design. A change to the sign-in
  doorway is made in the package, never by restyling one host.
  The surface is the marketing homepage's hero, not a floating card: a brand
  bar in `--ink` carrying the mark and the wordmark, the site's water edge
  hanging off it, then a full-bleed hero that runs from `--panel` into a soft
  `--accent` wash, with the copy and controls left-aligned and the showcase
  band on the right from `lg` up. Its display face is Geist, self-hosted by the
  package (`@fontsource-variable/geist`) so the doorway does not depend on a
  host's theme fonts. The showcase band is `--signin-stage` — the icon's navy
  in every theme — and everything drawn on its white thread card takes its
  colour from the card (`currentColor`), never from the host's text tokens,
  which on a dark theme left pale type on white.
  The landing's sign-in link is `/login?launch=sso`: the PKCE verifier is
  minted on the admin origin, so the landing hands off and the admin starts
  the provider flow at once.
  The landing has content after the doorway, so it renders the surface with
  `flow`: the document scrolls past the card (the page is at least the
  viewport, not exactly it, and the column no longer scrolls inside the card).
  Those sections are the landing's own and live in `web/`, set in the same
  tokens. The admin, whose body never scrolls, never sets `flow`.
