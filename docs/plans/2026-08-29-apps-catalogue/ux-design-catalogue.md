# Nessie Admin — "Apps" Catalogue — UX Design Document (Part A)

Route `/apps`, sidebar nav item **Apps** in the **Agents** group. It is the
consumer surface where connecting an integration feels like installing an app
in Slack or Notion.

---

## 1. Design principles & voice

### The target interaction

> Need GitHub? → tap **[Connect]** → GitHub login opens → ✓ Connected → "Which agents can use it?" → Done.

Four taps, zero jargon. Every design decision below is measured against that flow. If a label, field, or step requires the user to know what MCP, OAuth, PKCE, a transport, or a scope is, it fails.

### Principles

1. **Protocol detail is an implementation detail.** The user is connecting *an app*, not *configuring a server*. Nothing in the UI may assume knowledge of MCP. The words "MCP server" appear exactly once on this page — in the `+ Add custom MCP server` escape hatch, which is deliberately aimed at the developer persona and styled as secondary.
2. **Outcome-first states.** Cards and buttons describe the outcome ("Connected", "Reconnect", "3 accounts"), never the mechanism ("OAuth token expired", "SSE transport unreachable"). Mechanism detail lives one level deeper, on the app detail view, and even there inside an **Advanced** disclosure.
3. **One vocabulary, everywhere.** Copy, pills, empty states, and toasts all use the product vocabulary below. The moment we write "connector" on `/apps`, we have leaked the internal model onto the consumer surface.
4. **Calm by default.** A catalogue of 60 apps should feel like a tidy store shelf, not a dashboard. Status colour appears only where a decision is pending (reconnect, error); healthy connected apps get quiet `success` treatment, and available apps get *no* status colour at all — absence of status is the signal.
5. **Never block on the network for browsing.** The catalogue is local data and renders instantly. Registry sync, MCP probes, and OAuth discovery are background concerns that update cards in place; they never gate the grid.

### Product vocabulary (the only words allowed)

| Internal / protocol term | Product language on `/apps` |
|---|---|
| MCP server | **App** |
| MCP catalog entry | **App** (in the catalogue) |
| MCP server instance | **Connected account** |
| OAuth connection | **Connected account** |
| tools/list, tool | **Capabilities** |
| Install scope (user/team/org) | **Who can use it** ("Just me" / "This team" / "Everyone in the organisation") |
| Transport (HTTP/SSE) | never named; at most the pill **Remote** |
| Remote MCP runner | **Remote** |
| First-party / built-in integration | **Built-in** |
| Locked catalog entry | **Managed by your admin** |
| Deprecate | **No longer available** |

### Must NEVER appear outside an explicit "Advanced" disclosure

- Raw endpoint URLs (`https://api.example.com/v1/mcp/...`)
- npm package names, runner commands, stdio arguments
- OAuth scopes (`repo`, `read:user`), client IDs, PKCE, redirect URIs
- Tokens, API keys, `secret_*` refs — credentials UI says "Paste your API key", stores it, then shows only "Key saved ✓" with a **Replace** / **Remove** action
- Transport configuration of any kind
- Instance IDs, catalog UUIDs

The **Advanced** disclosure (on the app detail view, collapsed by default, `text-[color:var(--tx3)]`, labelled "Advanced — connection details") is the *only* place endpoint URL and auth method may render, and even there tokens never do.

---

## 2. Apps catalogue page — full layout

### Page shell

The page follows the **AgentsPage** shell pattern exactly: a flex column, mobile section header on phone, content region below. Apps is a **single scrolling page** — a store, not a three-pane admin tool.

```
<div className="flex h-full flex-col">
  <MobileSectionHeader title="Apps" />
  <div className="min-h-0 flex-1 overflow-y-auto">
    {/* header, sticky search/filter bar, featured, category sections */}
  </div>
</div>
```

- **Container:** `mx-auto w-full max-w-[80rem] px-4 py-6 sm:px-6 lg:px-8` — the same `xl`-capped content column the rest of the admin uses, page background `bg-[color:var(--main)]`.
- **Header:** `AdminPageHeader` (titleTone `"page"`) with:
  - title: **Apps**
  - eyebrow: none
  - actions: one primary action `+ Add a custom app` (`primary: true`, `priority: 0`) — it opens `CustomAppDialog`, the deliberate, labelled doorway for an app address. On overflow the `ResponsivePageHeader` measured overflow collapses it into the "More" menu automatically; on phone it collapses to a compact `+` button.
  - Subtitle line under the header (not an eyebrow — a real sentence, `text-sm text-[color:var(--tx2)]`): **"Connect Nessie and your agents to the tools your team uses."**
- **Nav:** sidebar item "Apps" in the **Agents** group, above or below "Agents", using the same icon treatment as other entries (puzzle-piece / grid icon from the existing icon set).

### Text wireframe (desktop)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Apps                                            [+ Add custom MCP server]│  AdminPageHeader
│ Connect Nessie and your agents to the tools your team uses.              │
├──────────────────────────────────────────────────────────────────────────┤
│ (sticky bar — bg --main, border-b --line, backdrop for scroll shadow)    │
│ ┌────────────────────────────┐  ┌──────────┬───────────┐                 │
│ │ 🔎 Search apps…            │  │   All 47 │ Installed 6│  SegmentedControl
│ └────────────────────────────┘  └──────────┴───────────┘                 │
├──────────────────────────────────────────────────────────────────────────┤
│ Featured                                                            (5)  │
│ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐             │
│ │ GitHub  │ │ Slack   │ │ Linear  │ │ Notion  │ │ Gmail   │  wider cards │
│ │ …       │ │ …       │ │ …       │ │ …       │ │ …       │             │
│ └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘             │
│                                                                          │
│ Development                                                       (12)   │
│ ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐                       │
│ │ card  │ │ card  │ │ card  │ │ card  │ │ card  │   …  Show all 12 →    │
│ └───────┘ └───────┘ └───────┘ └───────┘ └───────┘                       │
│                                                                          │
│ Communication                                                     (8)    │
│ …                                                                        │
├──────────────────────────────────────────────────────────────────────────┤
│ ┌─ EmptyState-style footer ──────────────────────────────────────────┐   │
│ │ Can't find what you need? Add any MCP-compatible server as a       │   │
│ │ custom app.                                   [+ Add custom server]│   │
│ └────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
```

### Sticky search/filter bar

- One bar containing the search input (flex-1) and the `SegmentedControl` filter (`w-auto min-w-[14rem]` on desktop).
- `sticky top-0 z-20 -mx-4 px-4 py-3 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 bg-[color:var(--main)]/95 backdrop-blur-sm border-b border-[color:var(--line)]` — the border appears only once the bar is stuck (toggle via an `IntersectionObserver` sentinel, the standard pattern; never a scroll listener).
- Search input: `h-9 rounded-[var(--radius-md)] border border-[color:var(--sep)] bg-[color:var(--panel)] px-3 text-sm text-[color:var(--tx)] placeholder:text-[color:var(--tx3)] focus:border-[color:var(--accent)] focus:outline-none focus:ring-2 focus:ring-[color:var(--accent-soft)]`, leading magnifier icon in `--tx3`.

### Filter bar

`SegmentedControl` (reused as-is, `ariaLabel="Filter apps"`), options with live counts:

- Now: `All 47`, `Installed 6`.
- Later (the design already leaves room — the control is `flex-1` per option and `ResponsivePageHeader`-style overflow is not needed at 4 items): `Available 41`, `Needs attention 2`.
- Order is fixed: **All → Installed → Available → Needs attention**, so adding options never re-orders existing ones.
- "Needs attention" = AUTH_EXPIRED ∪ ERROR; its option label gets `text-[color:var(--warning-text)]` when count > 0 so the problem is visible from "All" without switching.

### Featured row

- Curated set (catalog `featured` flag; falls back to the 5 most-installed apps if nothing is curated — the row always renders when any app exists).
- Wider cards than the grid: a horizontal scroll-snap strip on all breakpoints (`flex gap-4 overflow-x-auto snap-x pb-2`), each card `w-64 shrink-0 snap-start`. Same `AppCard` component, `layout="wide"` prop — one component parameterised, never forked.
- Section heading row: `Featured` + count `(5)` in `--tx3`.

### Category sections

- One section per category that has ≥1 app after filtering, in the fixed taxonomy order (§5).
- Heading row: `text-base font-semibold text-[color:var(--tx)]`, count `(12)` in `text-sm text-[color:var(--tx3)]`, right-aligned `Show all 12 →` link (`text-xs font-medium text-[color:var(--accent)] hover:text-[color:var(--accent-hover)]`) when the section overflows its first grid page (8 apps at 4–5 cols).
- Section spacing: `mt-10` between sections; heading margin `mb-4`.
- "Show all" swaps the section to its full grid in place (no navigation); the link becomes `Show less ↑`.

### Responsive grid (exact classes)

```
grid gap-4
  grid-cols-1
  min-[28rem]:grid-cols-2      /* large phones, below sm — two comfortable cards */
  md:grid-cols-3               /* 48rem tablet */
  xl:grid-cols-4               /* 80rem desktop */
  min-[110rem]:grid-cols-5     /* ultrawide only */
```

- Desktop (≥80rem): 4 cols, 5 only past 110rem — 5 dense columns reads as a spreadsheet, not a store.
- Tablet (48–80rem): 3; small tablet/large phone landscape (28–48rem): 2.
- Phone: 1 col below 28rem. A 2-col option exists only above 28rem where a card still gets ≥10rem of width.
- `gap-4` (1rem) everywhere; cards are all equal height within a row via `h-full` on the card and `grid-rows-[auto]` default stretch.

### Skeleton loading state

- The catalogue renders from **local data instantly** (catalog rows + instance rows are already in the client store from the app shell / a single fast local query). The skeleton exists only for first-ever cold load:
  - Sticky bar renders immediately with the real (disabled) search input and SegmentedControl showing no counts.
  - Below it: two section headers as `--overlay-weak` pulse blocks (`h-5 w-40 rounded`), each over a 1-row grid of 4 skeleton cards: `rounded-[var(--radius-lg)] border border-[color:var(--line)] bg-[color:var(--panel)]` containing pulse blocks for icon (12×12), title (h-4 w-2/3), description (h-3 w-full ×2), button (h-8 w-24). `animate-pulse`, surfaces only `--panel`/`--overlay-weak` — no status colour in skeletons.
- **Never** block the grid on: registry sync, per-app MCP probes, OAuth discovery. Those resolve per-card afterwards and update the card's capability count / availability pill in place with a `transition-opacity duration-[var(--duration-base)]` fade. A probe that fails silently leaves the card available-looking; only an explicit `UNAVAILABLE` flag from the server dims it (§4).

---

## 3. App card — anatomy

**One component — `AppCard`** (`components/features/apps/AppCard.tsx`) — renders every integration: remote MCP apps, curated catalog apps, and first-party built-ins alike. Kind differences are expressed through pills and the primary action, never through different card layouts.

### Anatomy (top → bottom), card = `bg-[color:var(--panel)] border border-[color:var(--line)] rounded-[var(--radius-lg)] p-4 flex h-full flex-col gap-3`

```
┌────────────────────────────────────┐
│ ┌────┐  GitHub           [✓ Official]│  row 1: icon + name + badge
│ │ ▣  │  Development · Remote        │  row 2: category · kind pills
│ └────┘                               │
│ Ship code, review PRs, and manage    │  description, line-clamp-2
│ issues without leaving Nessie.       │
│                                      │
│ 12 capabilities                      │  meta line (--tx3), clamp-1
│                        ┌──────────┐  │
│ ●  2                   │  Connect │  │  footer: status dot (+count) | action
│                        └──────────┘  │
└────────────────────────────────────┘
```

1. **Icon** — `h-12 w-12 rounded-[var(--radius-md)] border border-[color:var(--line)] bg-[color:var(--panel-soft)]`, brand SVG/logo centered, `p-2`. Fallback when no logo: the app's initials in `--tx2` on `--panel-soft` (never a generic puzzle piece per-app — that's the empty-state icon's job). For MCP-tool-flavoured fallbacks reuse `ToolCategoryIcon`.
2. **Name** — `text-[0.9375rem] font-semibold text-[color:var(--tx)] truncate`, next to the icon in a `min-w-0 flex-1` column. Official/verified badge: small `✓` in a `bg-[color:var(--accent-soft)] text-[color:var(--accent)]` round chip, `aria-label="Official app"`, tooltip on hover.
3. **Pills row** — `flex items-center gap-1.5 text-[11px]`, max one line, overflow truncates:
   - Category: plain text `--tx3` (`Development`).
   - Kind pills, at most ONE of: **Featured** (`bg-[color:var(--accent-soft)] text-[color:var(--accent)]`), **Remote** (`bg-[color:var(--info-soft)] text-[color:var(--info-text)]`), **Built-in** (`bg-[color:var(--overlay-weak)] text-[color:var(--tx2)]`). Pills use the shared pill shape (`rounded-full px-2 py-0.5 font-medium`) — not `StatusPill`, which is reserved for *status* (§4); these are static attributes.
   - Priority when space forces a choice: state-relevant pill first (none of these are state), so order is Featured > Built-in > Remote; the rest collapse into the tooltip.
4. **Description** — `text-sm leading-5 text-[color:var(--tx2)] line-clamp-2 min-h-[2.5rem]`. Exactly two lines reserved (`min-h`) so footers align across a row even for one-line descriptions. Written as user outcome ("Ship code, review PRs…"), never technical ("MCP server exposing GitHub's REST API").
5. **Meta line** — `text-xs text-[color:var(--tx3)] truncate`: capability count once known (`12 capabilities` — the word from the vocabulary, never "tools"), or `By GitHub` (provider) if capabilities haven't probed yet. Never both.
6. **Footer** — `mt-auto flex items-center justify-between gap-2 pt-1`: status label left (§4), action button right.
   - Primary action (`Connect`, `Reconnect`): `h-8 rounded-[var(--radius-md)] bg-[color:var(--accent)] px-3 text-xs font-semibold text-[color:var(--on-accent)] hover:bg-[color:var(--accent-hover)] transition-colors duration-[var(--duration-fast)]`.
   - Secondary action (`Manage`, `Open`): same shape, `border border-[color:var(--sep)] bg-[color:var(--overlay-weak)] text-[color:var(--tx2)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]` — matches `ResponsivePageHeader`'s non-primary action styling.

### Hover / focus

- Whole card is a link/button to the app detail view (except the footer action button, which stops propagation).
- Hover: `hover:border-[color:var(--border-strong)] hover:bg-[color:var(--main-hover)] transition-colors duration-[var(--duration-fast)]` — border + faint lift, **no** drop shadow (shadows read as modals in this system), no translate.
- Focus-visible: `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]` on the card; the card is reachable in tab order, footer action is a second tab stop.
- Cursor: `cursor-pointer` on the card body; buttons keep their own.

### A first-party Built-in next to a remote MCP app

A "Built-in" app (e.g. Nessie's own document composer, or DeepWater where granted) uses the *identical* card: same icon tile, same description, same footer. Differences are only:

- pill: **Built-in** instead of **Remote**;
- footer status: `● Always available` in `--tx3` plain text (no success pill — it's not a connection, nothing was connected), action button `Open` (secondary style) instead of `Connect`;
- no "Connected account" count — that concept doesn't exist for built-ins, so the slot stays empty rather than showing "0".

### FORBIDDEN on the card

- Endpoint URLs, package names, transport names ("HTTP", "SSE"), OAuth/scopes/token language of any kind
- Lock/admin pills ("Managed by your admin" belongs on the detail view; a locked app simply renders its button disabled with the tooltip "Installed by your admin")
- More than one status colour at a time; more than two pills
- Instance counts beyond the connected-account count in the footer status
- Timestamps ("added 3 days ago"), version numbers, author avatars
- Star ratings, download counts, review noise — this is a team tool catalogue, not a marketplace

---

## 4. Card states — all eight

State derivation (all from data the client already has: catalog flags + instance rows for this user/team/org):

| # | State | Derivation | Card footer | Count | Token family | Label (tooltip + detail hero) | Card clickable | Footer action |
|---|---|---|---|---|---|---|---|---|
| 1 | **AVAILABLE** | no instance, app healthy | *(none — status slot empty)* | — | none | — | yes → detail | **Connect** (primary) |
| 2 | **CONNECTING** | install/OAuth flow in flight | filled dot | when >1 | `--thinking` (accent family) | `Connecting` | yes → **Finish setup** | link, `Finish setup` |
| 3 | **CONNECTED** | ≥1 healthy instance visible to me | filled dot | never (a lone `1` is noise) | `success` | `Connected` | yes | **Manage** (secondary) |
| 4 | **MULTIPLE_ACCOUNTS** | >1 healthy instance | filled dot + count | always | `success` | `3 accounts connected` | yes | **Manage** (secondary) |
| 5 | **AUTH_EXPIRED** | instance exists, auth invalid/expired | filled dot + count | when >1 | `warning` | `needs reconnecting` / `2 accounts · needs reconnecting` | yes | **Reconnect** (primary) |
| 6 | **ERROR** | probe/connection failure, not auth | filled dot + count | when >1 | `danger` | `connection error` / `2 accounts · connection error` | yes (detail explains in words) | **Retry** (primary) |
| 6b | **PAUSED** | every visible account switched off | **hollow** dot + count | when >1 | `muted` | `Turned off` | yes | **View accounts** (secondary) |
| 7 | **DISABLED** | app locked/deprecated by admin, no live instance | `Unavailable` | — | muted (`--tx3` plain text, no pill) | — | yes (detail says why in words: "Your admin has turned this app off") | none — button hidden, not disabled-shown |
| 8 | **UNAVAILABLE** | server flagged unreachable/discontinued before any install | `Not available right now` | — | muted (`--tx3` plain text) | — | yes | none |

Notes on the states:

- **Multiple status precedence:** ERROR > AUTH_EXPIRED > CONNECTING > MULTIPLE_ACCOUNTS > CONNECTED. A card with two healthy instances and one expired shows the **warning** dot carrying a `3` — the decision-relevant state decides the colour, the count says how many accounts sit behind it, and the detail view enumerates them.
- **On a card a connection state is a dot, not a pill.** A tracked uppercase pill reading `CONNECTED` or `2 ACCOUNTS` was wider than the app's own name and sat beside a `Manage` button that already said the app was connected, so a shelf of connected apps read as a wall of green banners. States 2–6b render as `AppCardStatusIndicator`: a 10px dot in the state's token colour, plus the account count in the same colour when — and only when — there is more than one. One account is the ordinary case and a lone `1` beside a dot reads as a rendering fault.
- **The words are not lost, they move.** `AppCardStatus.label` is the card's `aria-label`/`title` (the focusable indicator gives keyboard users the same tooltip) and is what `AppDetailHero` renders as a full `Pill` — the detail view is the surface with room to spell a state out. That is why the labels carry no `●`/`⚠` glyph any more: the card draws the mark, the hero writes the sentence.
- **Colour is health, the number is quantity.** `success` / `warning` / `danger` / `accent` come straight from the theme tokens, so two accounts of which one has expired render as an amber dot with a `2` beside it rather than a green one. `paused` is the one **hollow** dot (`border`, no fill): the same relationship in its off position, not an availability verdict. States 1, 7, 8 stay plain `--tx3` text, **not** a muted pill — an uppercased tracked pill for "Available" shouts; absence is the calm default (principle 4).
- **Button copy, full matrix:** Connect / Connecting… / Manage / Manage / Reconnect / Retry / *(none)* / *(none)*. "Install" is never used — installing is what the system does; the user *connects*.
- **Every card opens, in every state**, CONNECTING included: it is `pending_setup`, which an install waiting on an unentered API key sits in indefinitely, so the detail page has to stay one click away (its action is `Finish setup`, not a disabled restatement of the dot).

---

## 5. Categories & taxonomy

Fixed taxonomy, in this exact display order (fixed order = users build spatial memory; a category with zero apps simply doesn't render):

1. Featured *(the strip, not a grid section)*
2. Communication
3. Development
4. Productivity
5. CRM & Sales
6. Project Management
7. Customer Support
8. Data & Databases
9. Analytics
10. Finance
11. Marketing
12. Files & Documents
13. AI & Search
14. Infrastructure
15. Commerce
16. Other

### Category section rendering

- Heading: `text-base font-semibold text-[color:var(--tx)]` with count `(12)` in `text-sm font-normal text-[color:var(--tx3)]`, 1rem gap.
- First page of the grid shows up to one full row × 2 (8 at desktop 4-col, 6 at 3-col, 4 at 2-col — computed from `useViewport`, not hard-coded). When more exist, right-aligned `Show all 12 →` (`text-xs font-medium text-[color:var(--accent)]`) expands the section in place and becomes `Show less ↑`. No pagination, no route change.
- `Other` never overflows — it shows all its apps always (it's the long tail, usually short, and "Show all" on "Other" is noise).

### Category jump-nav

> **Superseded by what shipped.** This section designed for a hand-curated
> catalogue of a few dozen apps. Registry ingestion made that 5,500 apps across
> 16 categories, and neither shape below survives it: a one-line jump-nav does
> not hold 16 links, and a horizontally-scrolling chip row hides its own tail —
> the categories a person has not seen are exactly the ones they are looking
> for. Both were replaced on 2026-08-30 by a single right-aligned `<select>`
> (`AppCategorySelect`) sitting on the search row at every width, which also
> narrows on the server rather than in the browser. The rest of this section is
> kept for the reasoning that led here. See `overview.md` → "The connect flow".

- **Desktop (≥64rem, `lg`):** a slim jump-nav renders *inside the sticky bar* as a horizontal list of category links (`hidden lg:flex items-center gap-3 text-xs text-[color:var(--tx3)]`, active section `text-[color:var(--tx)]) font-medium`) — one line, overflow scrolls horizontally, clicking smooth-scrolls to the section. It shows only categories currently rendered (respecting the filter), max ~8 visible before scroll. This is the same slot the wireframe shows empty to the right of the SegmentedControl; it appears only at `lg` so it never fights the filter control.
- **Mobile (<64rem):** the jump-nav becomes its own horizontal scrolling chip row directly under the sticky bar (inside the sticky container): `flex gap-2 overflow-x-auto pb-2 -mx-4 px-4` with chips `shrink-0 rounded-full border border-[color:var(--sep)] bg-[color:var(--panel)] px-3 py-1.5 text-xs text-[color:var(--tx2)]`, active chip `border-[color:var(--accent)] bg-[color:var(--accent-soft)] text-[color:var(--accent)]`. Scroll-snap not needed; chips are chunky enough.

### primaryCategory & multi-category placement

Every app has exactly one `primaryCategory` and may carry secondary categories.

- **Default catalogue view:** an app appears **only under its primaryCategory**. No exceptions in the main scroll — showing GitHub under both Development and Project Management doubles the page length and makes counts lie.
- **Category jump-nav/filter view:** when a user filters to a single category (future `[Category]` filter dimension or jump-nav "view all in category" mode), secondary membership counts — GitHub *is* found under Project Management there.
- **Search:** secondary categories are indexed (§6) but the result card renders once.
- Featured membership is orthogonal: an app can be in the Featured strip *and* its primary category section. That is the one deliberate duplication, and it's honest — Featured is a shelf, not a category.

---

## 6. Search UX

### Scope & behaviour

- One search box, **entirely local** — the full catalogue (names, descriptions, categories, tags, capabilities, providers, aliases) ships with the local catalog data; search never hits the network, never shows a spinner.
- **Debounce:** 150 ms via the existing `useDebouncedValue` hook. Below 2 characters the catalogue view stays; from 2 characters the results view replaces it.
- **Indexed fields per app:** `name`, `description`, `primaryCategory` + secondary categories, `tags[]`, capability names (once probed; absent capabilities simply don't match), `provider`, `aliases[]` (curated synonyms — this is how "email" finds Gmail and Outlook, "issues" finds GitHub/Linear/Jira).
- **Weighted ranking (strict order):**
  1. exact name match (or name prefix)
  2. alias match
  3. provider match
  4. tag match
  5. capability match
  6. description substring
  Within a tier: connected apps first (your tools surface before new ones), then alphabetical. Tiers are primary, so a name match always beats any number of description hits.

### Results view — flat ranked list (chosen) over regrouped categories

**Decision: flat ranked grid.** When searching, intent is a *specific app*; the ranking is the answer. Regrouping by category would re-bury the best match under a heading and force the eye to re-parse section chrome to answer "is GitHub here?". A flat grid using the same responsive grid classes as the catalogue (`AppCard`, identical) keeps one mental model: "the shelf, filtered". Category context is not lost — each card already shows its category in the pills row.

- Results header line: `text-sm text-[color:var(--tx3)]` — `14 results for "issues"`, with a `Clear ✕` affordance in the search box returning to the catalogue.
- While in search mode the SegmentedControl stays live — "Installed" + query = "which of my connected apps match".

### Match highlighting

The matched substring is wrapped in `<mark>` restyled to the theme: `rounded-sm bg-[color:var(--accent-soft)] px-0.5 text-[color:var(--accent-strong)]` (no `bg-yellow-*` anywhere). Highlighting applies to name and description only. When the match landed in an invisible field (alias, tag, capability), the card shows a one-line provenance hint under the description in `text-xs text-[color:var(--tx3)]`: `Matches "email" in capabilities` — otherwise a user sees Gmail highlighted nowhere and trusts the ranking less.

### Worked examples

- `email` → **Gmail**, **Outlook** top (alias tier: both alias `email`), then Superhuman etc. (tag tier), then anything mentioning email in description.
- `issues` → **GitHub** (alias `issues`), **Linear**, **Jira** (alias/tag tier), then trackers with "issues" in description. Exact-name `Issues`-the-app would outrank all three if it existed.

### Empty state

The existing `EmptyState` component (`components/shared/EmptyState`), full-width in place of the grid:

```
┌──────────────────────────────────────────────────────────────┐
│ No apps match "sap". Try a different word — or add any       │
│ MCP-compatible server as a custom app.                       │
│                                       [+ Add custom app]     │
└──────────────────────────────────────────────────────────────┘
```

- Copy stays in product language ("apps"), mentions the escape hatch ("custom app"), and the button opens the same `AddServerWizard` modal as the header action. The words "MCP-compatible" appear here only as an adjective for the developer persona reaching for the hatch; the button itself says "custom app", not "custom MCP server".
- The nudge also appears as the catalogue footer (§2 wireframe) so it exists even with zero query.

---

## 7. Mobile & responsive

Driven by the existing `useViewport` hook and the real breakpoints — **sm 40rem, md 48rem, lg 64rem, xl 80rem** — never bespoke media queries.

### Phone (<48rem)

- **No desktop sidebar store chrome**: the page gets `MobileSectionHeader title="Apps"` (the AgentsPage pattern) — the admin shell's own drawer/nav owns navigation; the page owns content.
- **Sticky search:** the search/filter bar stays `sticky top-0` and *collapses to search-only*: the SegmentedControl moves out of the bar into a full-width row beneath it (still inside the sticky container), `SegmentedControl` already being `flex w-full` it adapts with no changes. At very narrow widths (<28rem) the two current options fit fine; when "Available"/"Needs attention" are added later, the control scrolls horizontally (`overflow-x-auto`) rather than wrapping.
- **Horizontal category nav:** the chip row from §5 (`lg:hidden` inverse) sits under the sticky bar, edge-to-edge scroll with `-mx-4 px-4` bleed and fade masks at the edges (`[mask-image:linear-gradient(...)]` using `--main` — or simply no mask; chips bleeding off-screen already signal scrollability).
- **Cards:** 1 column below 28rem, 2 columns `min-[28rem]:grid-cols-2`. Card padding stays `p-4`; in 2-col phone mode the meta line (capabilities) hides (`hidden min-[40rem]:block`) so footers still align in narrow cards.
- **Featured strip:** unchanged — horizontal scroll-snap is a phone-native pattern; cards stay `w-64`.
- **Touch targets:** every interactive element ≥ 2.75rem (44px) hit area on touch. The card itself is one giant target (the whole card opens the detail), so this is mostly free; the footer button is `h-8` visually but gets `relative` + an expanded `::before` hit-slop (`before:absolute before:-inset-2`) or plain `min-h-[2.75rem] p-…` on phone via `min-h-11 md:min-h-8`. Chips are `py-1.5` + `min-h-[2.75rem] inline-flex items-center` on touch. The `+ Add custom MCP server` action collapses to ResponsivePageHeader's `compact` `+` icon-button, which is already 2rem visual with menu overflow handling.
- **Jump-nav scroll behavior:** tapping a chip smooth-scrolls accounting for the sticky bar height: `scroll-margin-top` on each section (`scroll-mt-32` on phone where the stacked bar is taller, `scroll-mt-20` on desktop).

### Tablet (48–80rem)

- 3-column grid (`md:grid-cols-3`), sticky bar single-row (search + SegmentedControl side by side), chip category nav still shown (jump-nav list is `lg`-only).
- Sidebar visible per admin shell rules; nothing page-specific.

### Desktop (≥80rem)

- 4-column grid (`xl:grid-cols-4`), 5 only past 110rem; container capped at `max-w-[80rem]`.
- Inline jump-nav in the sticky bar; featured strip may show 5 wide cards without scrolling and *still* scrolls (never wrap the strip).

### Cross-cutting

- All motion uses `--duration-fast` (hover) / `--duration-base` (state transitions) with `--easing-standard`; the only animation beyond that is the skeleton pulse and the CONNECTING spinner.
- `prefers-reduced-motion`: spinner stays (it's status, not decoration) but scroll-smooth and fades go instant.
- Theme safety: every colour above is a token reference; the nebula (dark/purple), midnight, and daylight themes redeclare the same tokens, so nothing on this page assumes dark — checked by the rule "never a hex, never a named Tailwind colour" throughout §§2–7.
