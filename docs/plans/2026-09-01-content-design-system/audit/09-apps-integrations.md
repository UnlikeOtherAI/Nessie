# Apps & Integrations — content design-system audit

Slice: `admin/src/pages/AppsPage.tsx`, `AppDetailPage.tsx`, `admin/src/components/features/apps/*` (32 files: 20 `.tsx`, 12 `.ts`), `admin/src/pages/IntegrationsPage.tsx`, `admin/src/components/features/integrations/*` (12 files: 11 `.tsx`, 1 `.ts`).

All 44 files were read. The 13 `.ts` files across both feature folders (`agent-access-view.ts`, `app-card-presentation.ts`, `app-catalogue-view.ts`, `app-connect-copy.ts`, `app-connect-scope.ts`, `app-connection-presentation.ts`, `app-detail-view.ts`, `app-search.ts`, `app-trust.ts`, `connect-error-copy.ts`, `connect-flow.ts`, `external-auth-launcher.ts`, `deep-water-research-options.ts`) are pure view-model/copy logic with **no markup**, except `app-trust.ts` which does hold one hard-coded `toneClass` string table (cited under §8). They are otherwise omitted from per-file findings below.

The two halves of this slice read as two different design eras. **Apps** (`AppsPage`, `AppDetailPage`, `components/features/apps/*`) is a newer, disciplined rewrite — one grid class constant, one card component, consistent `role="alert"` on errors, real use of `Pill`/`Switch`/`EmptyState`/`ConfirmDialog`. **Integrations** (`IntegrationsPage`, `components/features/integrations/*`) is an older, hand-rolled surface — raw hex colours, a bespoke non-shared dialog, checkboxes instead of `Switch`, no `role="alert"`, and the same `rounded border border-[var(--sep)] px-3 py-2` stat-tile/row shape copy-pasted across six files. Several integrations files carry their own inline comments admitting the deviation ("Not a `Pill`", "Not QueryState", "Not the shared `Dialog`", "Unconverted: bare `rounded` is 4px, not `--radius-sm`'s 6px").

---

## 1. Body containers & sections

**Apps:** Full-bleed page body (`AppsPage.tsx:186`, `w-full px-4 py-6 sm:px-6 lg:px-8`, explicitly justified in a comment as matching the agents list rather than a centred column). `AppDetailPage.tsx:133` mirrors it (`grid min-w-0 w-full gap-6 px-4 pb-10 sm:px-6 lg:px-8`). Section headings inside the body use two different treatments even within apps: `AppCategorySection.tsx:82` and `AppFeaturedStrip.tsx:19` use a bare `h2` (`text-base font-semibold` + a `text-sm font-normal text-[color:var(--tx3)]` count in parens), while `AppOverviewTab.tsx:37,60` uses a bare `h3` with `text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]` (an ad-hoc "section label" that duplicates what `SectionLabel.tsx` already does, but is never imported here). Neither `SectionLabel` nor `sectionTitleClass` is used anywhere in the apps folder.

**Integrations:** `IntegrationsPage.tsx` and every panel in `components/features/integrations/*` compose their body from repeating `<section className="border-t border-[var(--sep)] pt-4">` blocks (`AgentConnectorSection.tsx:58`, `BuildMeProjectPanel.tsx:50`, `DeepTestSecurityPanel.tsx:55`, `ExternalAgentActivationSection.tsx:58`, `DeepWaterRunHistory.tsx:73`, `ProductSurfacesPanel.tsx:38/48/69`, `IntegrationsPage.tsx:221,319,333,345`), each with a bare `h3 className="text-sm font-semibold text-[var(--tx)]"` heading — no uppercase, no `SectionLabel`. This is a **third** heading treatment, different from both apps variants above. The page itself is composed inside `ColumnBrowserColumn`/`ColumnBrowserViewport` (`components/shared/column-browser/*`, out of this slice's ownership but worth flagging to the synthesiser as the body container these pages actually use — neither `admin-frame` nor `admin-card` at the page level).

Token-syntax note: apps files write colour tokens as `text-[color:var(--tx3)]` (with the `color:` prefix) uniformly; integrations files write `text-[var(--tx3)]` (no prefix) uniformly. Both resolve, but it's a textual split exactly along the apps/integrations boundary — see §11.

**Verdict: many-variants.** Missing/underused primitive: `SectionLabel` (present in the codebase, unused in both halves of this slice); a shared "detail-page section" wrapper would resolve the `border-t pt-4` vs bare-`h2`-with-count split.

---

## 2. Tables & data lists

No `<table>` anywhere in this slice — everything is a card grid or a row list, which is itself the brief's called-out "data list" variant.

- **Card grid (apps):** `AppCard.tsx` is the one card, reused for the catalogue grid, the category shelves, the featured strip (`layout="wide"`), and search results — genuinely `n/a in this slice` for variation; this is the strongest single pattern in the slice. Grid columns come from one shared constant, `APP_GRID_CLASS` (`app-catalogue-view.ts:115-119`, `'grid gap-4 grid-cols-1 min-[28rem]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 min-[110rem]:grid-cols-5'`), used identically in `AppsPage.tsx`, `AppCategorySection.tsx:100`, `AppSkeletons.tsx:42`.
- **`<ul><li>` row lists (apps):** `AppCapabilityList.tsx:33-55`, `AppConnectionsList.tsx:47-107`, `AppAgentAccessList.tsx:251-264` all render a `<ul className="grid gap-2">` of `<li>` rows sharing one shell shape: `rounded-[var(--radius-md)] border border-[color:var(--sep)] bg-[color:var(--panel-soft)] px-4 py-3` (named `rowShell` in `AppAgentAccessList.tsx:49-52`, duplicated inline — not imported — in the other two files).
- **Div-based row lists (integrations):** `DeepWaterResearchPanel.tsx:230` (`divide-y divide-[var(--sep)] overflow-hidden rounded border border-[var(--sep)]` wrapping plain `<div>` rows, not `<ul>`/`<li>`), `DeepWaterRunHistory.tsx:86-170` (same shape, `overflow-hidden rounded border border-[var(--sep)]` with `border-t ... first:border-t-0` between rows), `ProductSurfacesPanel.tsx:71-101` (`grid gap-2` of `<div className="flex items-center justify-between gap-3 rounded border border-[var(--sep)] px-3 py-2">` rows). This is a fourth row-list shape — plain `border-[var(--sep)]` (not the `--radius-md` token) and no list semantics at all.
- Horizontal scroller: `AppFeaturedStrip.tsx:23` (`-mx-4 flex snap-x gap-4 overflow-x-auto px-4 ...`) — a one-off, not reused.
- `ProductRow` in `IntegrationsPage.tsx:144-197` is a button wrapping `admin-card` (the one place in this slice that reaches for the shared `.admin-card` baseline), holding a mix of `Pill` chips and hand-rolled `<span>` chips in the same row (see §8).

No sorting, selection, sticky header, or zebra striping appears anywhere in this slice — not applicable.

**Verdict: many-variants.** Apps' `rowShell` (bordered `--panel-soft` `<li>`) and integrations' bordered `<div>` row (no `--radius-md`, no list semantics) are the two shapes worth generalising into one "row list" primitive alongside `ExpandableTable` for when a real table isn't wanted.

---

## 3. Pagination & loading more

No `PaginationFooter` anywhere in this slice.

- `AppCategorySection.tsx:105-118` — hand-rolled centred "Load more" button (`admin-button admin-button-secondary`, centred via `flex justify-center`), backed by cursor pagination (`useAppCategoryPages`, `fetchNextPage`), label from `sectionRemainingLabel` (e.g. "Show N more"), disables + shows "Loading…" while `isFetchingNextPage`.
- `AppCategorySection.tsx:88-97` — a second, separate "Show all N" **in-place expand** toggle (not pagination — it locally lifts the two-row cap), a `<button>` styled as plain link text (`text-[color:var(--accent)] hover:text-[color:var(--accent-hover)]`), no `admin-button` class at all — a third control shape in the same file.
- Integrations has no pagination anywhere (`DeepWaterRunHistory` just renders whatever array it's given, capped server-side with a "N shown" pill, `DeepWaterRunHistory.tsx:81-83`).

**Verdict: many-variants** (three distinct load-more/expand shapes inside one file, `AppCategorySection.tsx`, none of them `PaginationFooter`). Missing primitive: a "Load more" variant of `PaginationFooter` (today's `PaginationFooter` is Previous/label/Next only, per the brief's baseline description, so it may not even cover this shape — flag to synthesiser).

---

## 4. Forms

Two genuinely distinct form idioms, split cleanly along the apps/integrations line.

**Apps — dialog forms** (`CustomAppDialog.tsx:59-93`, `AppSecretDialog.tsx:63-110`, and the review step of `AppConnectDialog.tsx:85-163`): consistent `<label className="grid gap-1.5 text-sm font-medium text-[color:var(--tx)]" htmlFor="...">Label text<input className="admin-input" .../></label>` — label text is a direct text-node child of `<label>`, above the control. `<fieldset><legend>` appears once (`AppSecretDialog.tsx:65-66`) for a radio-like `TabBar` group. Optional field marked inline: `Name <span className="font-normal text-[color:var(--tx3)]">(optional)</span>` (`CustomAppDialog.tsx:74`) — no help/description text pattern beyond that. Action row is uniformly `<div className="flex justify-end gap-2 pt-1">` (Cancel left, primary submit right), disabled while pending, label swaps to a present-participle ("Saving…", "Adding…"). Validation is submit-time only (see §5).

**Apps — hand-rolled controls that skip `admin-input`:** `AppSearchInput.tsx:21-34` and `AppCategorySelect.tsx:38-45` both explicitly avoid `.admin-input` (each has a comment explaining why — the icon's padding conflicts with the class's built-in padding, and the unlayered `font: inherit` reset makes `text-sm` on the control itself inert) and hand-roll `h-9 w-full rounded-[var(--radius-md)] border border-[color:var(--sep)] bg-[color:var(--panel)] ... focus:border-[color:var(--accent)] focus:outline-none focus:ring-2 focus:ring-[color:var(--accent-soft)]` — the same ~6 utilities typed out twice, independently, for what is functionally "an `.admin-input` with an icon." Meanwhile `AppConnectDialog.tsx:116-137` uses plain `className="admin-input"` for its channel `<select>` with no icon. So within the apps folder alone there are two co-existing answers to "select with `admin-input`, or not."

**Apps — checkbox vs `Switch`:** `AppAgentAccessList.tsx` correctly uses the shared `Switch` primitive (`ManagedAgentRow`, line 144-148) for the per-agent access toggle.

**Integrations — inline-label forms** (`BuildMeProjectPanel.tsx:108-120`, `DeepTestSecurityPanel.tsx:113-136`, `DeepWaterResearchCustomControls.tsx` — nine fields, `DeepWaterResearchLauncher.tsx:87-96`): every field is `<label className="grid gap-1 text-sm"><span className="font-semibold text-[var(--tx2)]">Label</span><select className="admin-input">...</select></label>` — label text wrapped in a `<span>`, not a direct text node (a second, different label markup from the apps dialogs' pattern above, even though both reach for `.admin-input` on the control). No help text, no required markers anywhere in integrations forms — every field is implicitly optional/defaulted.

**Integrations — checkbox instead of `Switch`:** `IntegrationsPage.tsx:229-243` (`TeamAccessSection`) hand-rolls a checkbox toggle: `<label className="inline-flex min-h-9 items-center gap-2 rounded border border-[var(--sep)] px-3 text-sm text-[var(--tx)]"><input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" .../><span>{isToggling ? 'Saving...' : 'Enabled'}</span></label>`. This is a direct two-variants finding against `AppAgentAccessList`'s use of the shared `Switch` for the conceptually identical "toggle this app/agent capability" job.

**Integrations — segmented "pick one" reimplemented three ways**, none of them `TabBar` (styling of `TabBar` itself is out of scope, but its *absence* here is a controls finding): (a) a row of plain buttons with manual active/inactive classes — `BuildMeProjectPanel.tsx:90-104` (intent), `DeepTestSecurityPanel.tsx:94-109` (depth), `DeepWaterResearchCustomControls.tsx:39-56` (depth again) — all three share the identical class pair `'h-9 rounded border px-2 text-xs font-semibold'` / active `'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--thinking)]'` / inactive `'border-[var(--sep)] text-[var(--tx2)] hover:bg-[var(--overlay)]'`, copy-pasted verbatim three times; (b) a selectable-card grid, `DeepWaterResearchModeSelector.tsx:11-21,28-62` (`cardClass`/`labelClass` helpers, `aria-pressed` buttons with a summary + detail line each); (c) `TabBar` itself, used correctly for the DeepWater tabs (`DeepWaterResearchPanel.tsx:101-107`) and connect-scope choice (`AppConnectDialog.tsx:102-112`, `AppSecretDialog.tsx:67-77`). Three call sites in integrations reinvent (a) rather than reaching for the `TabBar` that a fourth integrations file (`DeepWaterResearchPanel.tsx`) already imports.

**Verdict: many-variants.** Wins: collapse the three copy-pasted button-row selectors into one control; standardise on `Switch` over raw checkboxes; pick one label markup (direct text vs wrapped `<span>`) for `<label>+control` pairs.

---

## 5. Validation & field errors

`FormFieldError.tsx` (`fieldErrorAria`/`renderFieldError`/`fieldErrorProps`) is **not used anywhere in this slice**. Every form error in both apps and integrations is a bare paragraph, and even that bare paragraph disagrees on markup:

- **Apps, form-level, with `role="alert"`:** `CustomAppDialog.tsx:84`, `AppSecretDialog.tsx:101` — `{error ? <p className="text-sm text-[color:var(--danger-text)]" role="alert">{error}</p> : null}`. Validation fires on submit only (`CustomAppDialog.tsx:32-35`, `AppSecretDialog.tsx:33-36`: empty-string check inside the submit handler, not on keystroke/blur). No `aria-invalid` or `aria-describedby` is ever set on the offending `<input>` itself — the error paragraph exists but isn't wired back to the field, even though `FormFieldError.tsx` exists specifically to do that wiring.
- **Apps, boxed danger banner:** `AppConnectionsList.tsx:93-103` — a full bordered box (`rounded-md border border-[color:var(--danger-border)] bg-[color:var(--danger-soft)] px-3 py-2 text-xs`) for a connection's persisted `errorMessage`, and `AppsPage.tsx:207-217` uses the identical boxed shape for the catalogue load failure. This is a materially different visual weight from the bare one-line errors above, for the same semantic "something failed" fact.
- **Apps, dialog-body error:** `AppDetailPage.tsx:158-162`, `AppConnectionsList.tsx:124-128` — `<p className="mt-3 text-sm text-[color:var(--danger-text)]" role="alert">` inside a `ConfirmDialog`'s `body` — a third apps variant (bare, but `mt-3 text-sm` not `text-xs`).
- **Integrations, no `role="alert"` at all:** every mutation error in this folder is `<p className="mt-2 text-xs text-[var(--danger-text)]">{message}</p>` with **no `role`** — `TeamAccessSection` (`IntegrationsPage.tsx:264-269`), `BuildMeProjectPanel.tsx:151-157`, `DeepTestSecurityPanel.tsx:172-178`, `ExternalAgentActivationSection.tsx:101-109` (x2), `DeepWaterResearchPanel.tsx:287-293`. One exception: `DeepWaterResearchLauncher.tsx:110-113` does add `role="alert"`.

**Verdict: many-variants.** This is a genuine accessibility gap (missing `role="alert"` on ~7 error sites in integrations) as well as a visual one (bare vs boxed). `FormFieldError` is the obvious existing primitive that nobody in this slice reaches for.

---

## 6. Feedback after actions

No toasts anywhere in this slice; every "did it work" signal is inline, transient (tied to a mutation's `isPending`/`isError`/`isSuccess`), and placed directly under the control that triggered it.

- **Success:** there is no persisted "Saved" text anywhere — success is communicated by the UI *changing* (a card flips to "Connected", a dialog closes, `AppConnectDialog.tsx:167-171`) rather than by a confirmation line. Button labels swap to a present-participle while pending ("Saving…", "Adding…", "Removing…", "Preparing...", "Activating...") — consistent across both halves, though apps consistently uses an ellipsis character `…` while integrations consistently types three literal dots `...` (`BuildMeProjectPanel.tsx:148`, `DeepTestSecurityPanel.tsx:169`, `ExternalAgentActivationSection.tsx:86,96`, `DeepWaterResearchLauncher.tsx:122` — vs. apps' `AppSecretDialog.tsx:107`, `CustomAppDialog.tsx:90`, `AppDetailPage.tsx:165` all using `…`).
- **Tone-banner reimplementation, apps:** `ConnectProgress.tsx:40-49` hand-rolls its own `noticeClass(tone)` helper producing `danger`/`info` variants with the exact same shape as the shared `Notice` primitive (`border`, `rounded-[var(--radius-md)]`, `px-4 py-3`, `text-sm`, tone-coloured `bg-*-soft`/`text-*-text`) — but `Notice` has no `info` tone (`Notice.tsx:3` — only `danger | success | warning`), so `ConnectProgress` *can't* use it as-is for its `needs_secret` state. `DeepWaterResearchLauncher.tsx:104-108` similarly hand-rolls a `warning`-tone paragraph the file's own comment flags as non-conformant (quoted in §11) instead of using `Notice tone="warning"`.
- **Inline "why can't I click this" feedback, apps:** `AppDetailHero.tsx:125-152` — a two-line explanation block (bold reason + muted sub-reason with optional link) beside a disabled CTA; a distinct, deliberate pattern not reused elsewhere.
- **Popup-blocked feedback:** `ConnectProgress.tsx:191-217` — a `warning`-toned box with its own inline "Open sign-in ↗" link button.

**Verdict: two-variants** (a disciplined inline-under-control convention in both halves, undermined by each half separately reinventing a tone banner instead of extending/using `Notice`). Win: add an `info` tone to `Notice` and route `ConnectProgress`'s three banners through it.

---

## 7. Loading / error / empty states

`QueryState` is used exactly **once** in this whole 44-file slice: `IntegrationsPage.tsx:427-449` for the product list. Every other loading/error/empty moment is bespoke, and three integrations files say so out loud in their own comments:

- `DeepWaterResearchPanel.tsx:218-219`: `/* Not QueryState: text-xs, left-aligned, sitting above the list as a note rather than replacing it. */`
- `DeepWaterRunHistory.tsx:87-89`: `/* Not QueryState: this takes a `loading` boolean, not a query, so a Retry would have nothing to call. The ellipsis is the admin's typographic one, matching every other loading line. */`
- `AppSkeletons.tsx` — a hand-built skeleton system (`Pulse` primitive + `AppCardSkeleton`/`SkeletonSection`/`AppCatalogueSkeleton`/`AppDetailSkeleton`), never `QueryState`'s text-only loading line; used from `AppsPage.tsx:206` and `AppDetailPage.tsx:93`.

Errors with no retry, apps: `AppsPage.tsx:203-217` (catalogue load failure — no retry button, just "Refresh the page"); `AppCategorySection.tsx:120-128` (shelf-page failure — no retry either, just prose). Errors **with** an inline retry, apps: `AppAgentAccessList.tsx:226-237` (hand-rolled "Try again" `<button className="underline">`, not `QueryState`'s Retry). Errors with retry, integrations: `DeepWaterResearchPanel.tsx:222-228` (same hand-rolled underline-button "Retry" shape).

Empty states: `EmptyState` (the dashed card) is used correctly and repeatedly in apps — `AppsPage.tsx:198,254`, `AppCapabilityList.tsx:29-31`, `AppConnectionsList.tsx:37-42`, `AppAgentAccessList.tsx:240-243`. Integrations has no dashed-card empty state anywhere; its "nothing here" moments are one-line text (`DeepWaterRunHistory.tsx:93`: `<div className="px-3 py-4 text-sm text-[var(--tx3)]">No Deep Water runs yet.</div>`) or a muted paragraph inside a `<section>` (`ProductSurfacesPanel.tsx:50-53`).

Wording style differs too: apps consistently uses the ellipsis character in loading text ("Loading…", `AppCategorySection.tsx:115`); integrations does the same in `DeepWaterRunHistory.tsx:91` ("Loading runs…") but `IntegrationsPage.tsx` relies on `QueryState`'s own copy.

**Verdict: many-variants.** `QueryState` exists and works (its one call site is clean) but is used by exactly 1 of ~10 loading/error/empty moments in this slice. Good model: `IntegrationsPage.tsx:427-449`. Worst offenders: the three self-documented "Not QueryState" sites, which argue their own case for why the shared primitive doesn't fit (boolean loading flag, no-retry inline note) — a real signal that `QueryState` may need a lighter sibling rather than that these sites are simply wrong.

---

## 8. Status chips & badges

- `Pill` used correctly and extensively in both halves: `AppCard.tsx:200`, `AppDetailHero.tsx:76`, `AppAgentAccessList.tsx:76`, `AppConnectionsList.tsx:64`; and, in integrations, `IntegrationsPage.tsx:166-192,351-382`, `BuildMeProjectPanel.tsx:55-81`, `DeepTestSecurityPanel.tsx:60-86`, `DeepWaterResearchPanel.tsx:160-195` — all passing `radius="chip" size="sm" uppercase={false}`, i.e. integrations has its own consistent `Pill` calling convention distinct from (but not wrong versus) apps' plain `<Pill tone="...">` calls.
- **Hand-rolled chip, apps:** `AppTrustBadge.tsx:46-60` — `<span className="inline-flex ... rounded-full px-2 py-0.5 text-[11px] font-medium" ...>` with its own tone table in `app-trust.ts:23-59` (`bg-[color:var(--accent-soft)] text-[color:var(--thinking)]`, etc.) — a second, parallel tone→colour mapping that duplicates what `Pill`'s `tone` prop already encodes, rather than calling `Pill` with an equivalent tone.
- **Hand-rolled chip, apps:** `AppCard.tsx:164-172` — the "Built-in"/"Remote" kind pill, when not routed through `AppIconBadge`, falls back to a raw `<span className="rounded-full px-2 py-0.5 font-medium" ...>` with its own `KIND_PILL_TONE` map (`AppCard.tsx:40-46`) — a **third** local tone→colour table in the same folder.
- **Hand-rolled chip, apps:** `AppOverviewTab.tsx:42-53` — "used by agents" chips are `rounded-full border ... bg-[color:var(--panel-soft)] px-3 py-1 text-xs` links, no tone at all (they're identity chips, not status, so this may be legitimately out of `Pill`'s remit — noted for completeness).
- **Hand-rolled chip, integrations, mixed with real `Pill` in the same row:** `IntegrationsPage.tsx:364-379` — five badges rendered side by side: four are raw `<span className="rounded border border-[var(--sep)] px-2 py-1 text-xs text-[var(--tx2)]">` (category, install state, account, team enablement) and the fifth is a real `<Pill radius="chip" ...>` (MCP connector tone) — two chip shapes in one `flex flex-wrap gap-2` row for what reads as one family of status facts. Same split repeats in the list-row version, `ProductRow` (`IntegrationsPage.tsx:177-192`), where four `Pill`s are used and the health pill uses `healthTone` while the others carry no tone at all (implicit "muted").
- **Hand-rolled chip, integrations, deliberately not `Pill`:** `DeepWaterRunHistory.tsx:16-29` — `statusClass()` builds a fixed-24px-tall chip explicitly because "`Pill` has no height affordance and would become content-sized (~18px)" (quoted in full — a real gap in `Pill`, not a caprice).
- Small "info" chips with no tone system, integrations: `AgentConnectorSection.tsx:75-77` ("Contract pending"), `DeepWaterRunHistory.tsx:81-83` ("N shown"), `ProductSurfacesPanel.tsx:94-96` ("Unlocks on activation") — all `rounded border border-[var(--sep)] px-2/3 py-1 text-[11px]/text-xs text-[var(--tx3)]`, functionally a neutral `Pill` but never spelled that way.

**Verdict: many-variants.** `Pill` is well-adopted where it's used, but three separate local tone tables exist in apps alone (`app-trust.ts`, `AppCard.tsx`'s `KIND_PILL_TONE`, and the ad-hoc kind span), plus `Pill`'s missing fixed-height variant is the one legitimate reason `DeepWaterRunHistory` opted out. Fixing `Pill`'s height gap would remove that opt-out.

---

## 9. Detail / key-value views

At least **four** different key-value shapes across the slice, none sharing a component:

1. `AppOverviewTab.tsx:63-89` — real `<dl>`/`<dt>`/`<dd>` semantics, `grid gap-x-6 gap-y-2 sm:grid-cols-2`, each pair a `flex items-baseline justify-between gap-3 border-b border-[color:var(--sep)] py-2` row (label left, value right, bottom-border between rows).
2. `AppConnectDialog.tsx:89-145` — also a `<dl>`, but boxed as one panel (`grid gap-3 rounded-[var(--radius-md)] border ... bg-[color:var(--panel-soft)] p-3 text-sm`) with each `dt`/`dd` stacked vertically (label above value, uppercase `text-xs font-medium tracking-[0.08em]`), no borders between pairs — the opposite layout axis from (1) for the same semantic job ("review before connecting").
3. `AppOverviewTab.tsx:19-32` and `IntegrationsPage.tsx:245-260` / `AgentConnectorSection.tsx:82-105` / `BuildMeProjectPanel.tsx:18-23` (`BoundaryRow`) / `DeepTestSecurityPanel.tsx:20-25` (`PrivacyRow`) — a "stat tile" shape: a bordered box, uppercase 11px muted label on top, value below. Two sub-variants of the **same idea, non-`dl`, div-only** exist: apps' version uses `rounded-[var(--radius-md)] border border-[color:var(--sep)] px-3 py-2` (`AppOverviewTab.tsx:23`); integrations' version (copy-pasted near-verbatim across 4+ files) uses `rounded border border-[var(--sep)] px-3 py-2` — plain `rounded` (4px) instead of the `--radius-md` token (6px), see §11.
4. `SurfaceRow` (`IntegrationsPage.tsx:199-204`) — yet another shape: no border box at all, just a `border-t border-[var(--sep)] py-3 first:border-t-0 first:pt-0` divider row with label-above-value stacked text, used for "Interface surfaces."

**Verdict: many-variants.** This is the single most fragmented category in the slice — four shapes (`dl`-bordered-rows, `dl`-boxed-panel, bordered-box stat-tile ×2 radius variants, divider-row) doing the same "label + value" job with no shared component. Strong unification candidate: one `KeyValueList`/`StatGrid` primitive with a `layout: 'rows' | 'grid'` and a `bordered` flag would absorb all four.

---

## 10. In-content filters, search boxes & toolbars

- `AppsToolbar.tsx` is the one toolbar in this slice: sticky (`sticky top-0 z-20`, `AppsToolbar.tsx:37-41`), composed of `AppSearchInput` (search), `TabBar` in `role="radiogroup"` mode (All/Installed filter), and `AppCategorySelect` (native `<select>`) — one row on `lg+`, wraps on narrow. Count summaries live beside/above results rather than in the toolbar itself: `AppsPage.tsx:246` (`searchResultsLabel`), `AppCategorySection.tsx:83-87` (`(N)` beside the shelf heading), `IntegrationsPage.tsx:456` (`Integrations (${products.length})` in the column header), `DeepWaterRunHistory.tsx:81-83` ("N shown" pill).
- No date pickers anywhere in this slice.
- Integrations has no search/filter toolbar at all — the product list (`IntegrationsPage.tsx:426-449`) is unfiltered, just a `QueryState`-wrapped list in a `ColumnBrowserColumn`.

**Verdict: n/a for integrations, consistent for apps** (exactly one toolbar, well-composed from existing primitives) — the only defect inside it is `AppSearchInput`/`AppCategorySelect` re-deriving `admin-input`'s look by hand (already covered in §4) rather than a genuinely different toolbar pattern.

---

## 11. Typography & spacing inside content

- **Heading sizes:** `h1` only once (`AppDetailHero.tsx:71`, `text-2xl font-semibold`); `h2` for shelf/section headings (`text-base font-semibold`, apps) and for the hero title inside `IntegrationsPage.tsx:350` (`text-base font-semibold` too, same size different element — `h2` vs `h3` used for visually-identical text sizes depending on file); `h3` used both as an uppercase 11px section label (apps, `AppOverviewTab.tsx:37`) and as a plain `text-sm font-semibold` panel heading (integrations, everywhere) — two unrelated jobs sharing one HTML tag with two different sizes/treatments.
- **Muted text tokens:** `--tx2` used for secondary body copy, `--tx3` for tertiary/meta text — applied consistently within each half, but via different bracket syntax: apps always writes `text-[color:var(--tx3)]`; integrations always writes `text-[var(--tx3)]` (no `color:` prefix) — a clean split at the folder boundary, everywhere (e.g. `AppCard.tsx:157` vs `AgentConnectorSection.tsx:62`).
- **Padding scale:** apps rows/cards mostly use `px-4 py-3` (`rowShell`, `AppCard.tsx:125`) and `p-6 sm:p-8` for the hero (`AppDetailHero.tsx:64`); integrations rows mostly use `px-3 py-2` (stat tiles) and `p-3` (`DeepWaterResearchPanel.tsx:150,200`, `DeepWaterRunHistory.tsx:98`) — integrations runs one step smaller throughout.
- **Border radius scale — an explicit, self-flagged defect:** `DeepWaterResearchLauncher.tsx:104` carries its own comment: *"Unconverted: bare `rounded` is 4px, not `--radius-sm`'s 6px, and the border is a /30 tint of `--warning-text`."* Nearly every integrations file uses bare `rounded`/`rounded-lg` (`BuildMeProjectPanel.tsx:19,93`, `DeepTestSecurityPanel.tsx:21,98`, `IntegrationsPage.tsx:110,229,246`, `ProductSurfacesPanel.tsx:78`, `DeepWaterRunHistory.tsx:98,156`) where apps consistently uses the token scale `rounded-[var(--radius-md)]`/`rounded-[var(--radius-lg)]`/`rounded-[var(--radius-xl)]` (`AppCard.tsx:126`, `AppDetailHero.tsx:62`, `AppCapabilityList.tsx:37`). This is a real, named defect per the brief's "border tokens" ask, not just stylistic drift.
- **Border tokens:** apps uses `--sep`/`--line`/`--border-strong` per context (`--line` for card borders, `--sep` for divider rows, `--border-strong` on hover); integrations uses `--sep` for everything — card borders, dividers, and hover states alike — never `--line` or `--border-strong`.
- **Raw colour / opacity tint, self-flagged:** `DeepWaterResearchLauncher.tsx:106` — `border-[var(--warning-text)]/30` — a Tailwind opacity-modifier tint of a token rather than a `--warning-border`/`--warning-soft` pair, called out in the same file's comment.

**Verdict: many-variants**, and one item (`DeepWaterResearchLauncher.tsx:104-108`) is a defect the author already flagged as needing conversion.

---

## 12. Destructive & confirm flows with forms in dialogs

- **`ConfirmDialog` used correctly, apps:** `AppDetailPage.tsx:152-176` (remove app — all connections) and `AppConnectionsList.tsx:118-143` (disconnect one account) both use the shared `ConfirmDialog`, `destructive`, with a `pending` flag, and both inject a form-level error paragraph into the dialog's `body` (`role="alert"`, `mt-3 text-sm text-[color:var(--danger-text)]`) rather than replacing the confirm copy — same pattern, twice, cleanly reused. This is the slice's best example of category 12.
- **Real `Dialog`-based forms, apps:** `AppSecretDialog.tsx` and `CustomAppDialog.tsx` both compose `components/shared/Dialog.tsx` with a `<form>` inside (`className="grid gap-4"`, submit-time validation, action row `flex justify-end gap-2 pt-1`) — consistent with each other.
- **A second, non-shared dialog shell, integrations:** `DeepWaterResearchLauncherDialog.tsx:60-113` builds its own modal from scratch — own scrim (`fixed inset-0 z-[100] ... bg-[var(--scrim-strong)] backdrop-blur-sm`), own `useModalA11y`/`useOverlayDismiss` wiring, own header with a literal `×` close glyph, own `max-w-3xl` / `shadow-2xl` panel. Its own comment says so directly: *"Not the shared `Dialog`: a `max-w-3xl` / `--panel` / `shadow-2xl` card with a `text-base` heading — a different panel family from the shell's `.create-channel-panel`."* This directly violates the codebase's stated "one dialog shell" rule (`CLAUDE.md` → Theming/design system) — the one clear cross-cutting defect in this category.
- No destructive confirm exists anywhere in the integrations folder itself (no delete/remove flow there); "Deactivate" (`ExternalAgentActivationSection.tsx:80-87`) fires immediately on click with no confirmation step at all, unlike apps' "Remove"/"Disconnect" which both gate through `ConfirmDialog`.

**Verdict: two-variants** — apps' `ConfirmDialog` usage is exemplary and consistent; the one integrations dialog in this slice bypasses the shared shell entirely and is explicitly documented as doing so.

---

## Raw colours / hex — defect log

- `IntegrationsPage.tsx:101-106` (`productAccent`) — **four raw hex literals** applied via inline `style={{ backgroundColor }}`: `'#0f766e'`, `'#991b1b'`, `'#4338ca'`, `'#475569'` (falls back to `var(--accent)` only for `deepsignal`). This is the slice's clearest CLAUDE.md violation ("no raw hex... components carry no raw hex"); used at `ProductGlyph`, called from both `ProductRow` (list) and `ProductDetail` (hero).
- `DeepWaterResearchLauncher.tsx:106` — `border-[var(--warning-text)]/30`, a Tailwind opacity-tint of a token rather than a paired `-border`/`-soft` token (flagged in-file as "Unconverted").
- No Tailwind named-colour utilities (e.g. `text-emerald-500`) were found in this slice — the raw-colour problem here is entirely the hex literals above plus the one opacity-tint.

---

## Top 5 unification wins for this slice

1. **One key-value/stat primitive.** Four independent shapes (`AppOverviewTab`'s bordered-row `dl`, `AppConnectDialog`'s boxed-panel `dl`, the apps/integrations stat-tile pair with mismatched radius tokens, `SurfaceRow`'s divider-row) all do "label + value" — repeated verbatim across at least 8 files (`AppOverviewTab.tsx`, `AppConnectDialog.tsx`, `AgentConnectorSection.tsx`, `BuildMeProjectPanel.tsx`, `DeepTestSecurityPanel.tsx`, `IntegrationsPage.tsx` ×3 call sites, `SurfaceRow`).
2. **Fix `productAccent`'s four raw hex literals** (`IntegrationsPage.tsx:101-106`) — the one unambiguous token-system defect in the slice, one function, easy fix.
3. **Route the three hand-rolled tone banners through `Notice`, adding an `info` tone.** `ConnectProgress.tsx` (danger/info), `DeepWaterResearchLauncher.tsx`'s warning banner (currently using an un-converted `rounded` + opacity-tinted border), and the boxed danger errors in `AppConnectionsList.tsx`/`AppsPage.tsx` are all reimplementations of `Notice`'s exact `border + bg-*-soft + text-*-text` shape.
4. **Collapse the three copy-pasted button-row segmented selectors** (`BuildMeProjectPanel.tsx:90-104`, `DeepTestSecurityPanel.tsx:94-109`, `DeepWaterResearchCustomControls.tsx:39-56` — identical class strings, three separate call sites) plus `DeepWaterResearchModeSelector`'s card variant into one control, and stop hand-rolling a checkbox (`IntegrationsPage.tsx:229-243`) where `Switch` already exists and is already used one file over (`AppAgentAccessList.tsx`).
5. **Wire `FormFieldError`/`role="alert"` consistently.** Zero of ~15 form/mutation error sites in this slice use `FormFieldError`'s `aria-invalid`/`aria-describedby` helpers, and the ~7 integrations error paragraphs (`TeamAccessSection`, `BuildMeProjectPanel`, `DeepTestSecurityPanel`, `ExternalAgentActivationSection` ×2, `DeepWaterResearchPanel`) are missing `role="alert"` entirely, unlike their apps-side equivalents.

**Good model:** `AppCard.tsx` — one component genuinely reused across grid/shelf/featured/search contexts via a `layout` prop, with its presentation logic (tone maps, status/action resolution) cleanly split into `app-card-presentation.ts`. `AppSecretDialog.tsx`/`CustomAppDialog.tsx` are the cleanest form-in-`Dialog` pair in the slice.

**Worst offender:** `IntegrationsPage.tsx` — raw hex colours, a hand-rolled checkbox where `Switch` exists, a `Pill`/raw-`<span>` chip mix in the same row (`ProductDetail`'s badge row, lines 364-379), and four different local section-heading/stat-tile idioms in one 479-line file. Close second: `DeepWaterResearchLauncherDialog.tsx`, the one dialog in the slice that explicitly does not use the shared `Dialog` shell.
