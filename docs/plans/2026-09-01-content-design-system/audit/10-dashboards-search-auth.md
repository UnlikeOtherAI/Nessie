# Audit slice: dashboards, search & standalone screens

Files covered (all paths relative to `admin/src`):

- `pages/DashboardsPage.tsx`
- `pages/DashboardDetailPage.tsx`
- `components/features/dashboards/AddWidgetPanel.tsx`
- `components/features/dashboards/DashboardGrid.tsx` (canvas mechanics — out of scope per brief, skimmed only)
- `components/features/dashboards/DashboardVersionsPanel.tsx`
- `components/features/dashboards/DashboardWidgetCard.tsx`
- `components/features/dashboards/EmbeddedWidget.tsx`
- `components/features/dashboards/WidgetCharts.tsx`
- `components/features/dashboards/WidgetFrame.tsx`
- `components/features/dashboards/WidgetPanels.tsx`
- `components/features/dashboards/widget-format.ts`
- `pages/SearchPage.tsx`
- `components/features/search/HighlightedPassage.tsx`
- `components/features/search/SearchModeToggle.tsx` (wraps `TabBar` — out of scope)
- `pages/NotFoundPage.tsx`
- `pages/BootstrapPage.tsx`
- `pages/LoginPage.tsx`
- `pages/LoginRoute.tsx` (pure redirect, no content markup)
- `pages/ExternalAuthCompletionPage.tsx`
- `pages/ChannelConversationComposePage.tsx` (the "To:" recipient-picker form only; the `MentionInput` composer itself is chat, out of scope)

Baseline usage found in this slice: `QueryState` once (`DashboardsPage.tsx:86`), `SectionLabel` once (`SearchPage.tsx:69`), `admin-input` once (`SearchPage.tsx:153`), `admin-button` once (`NotFoundPage.tsx:24`), `ExpandableTable` once (`WidgetPanels.tsx:111`). **Pill, Notice, EmptyState, PaginationFooter, FormFieldError/fieldErrorAria, Switch, and Dialog/ConfirmDialog are used nowhere in this entire slice** — every occurrence of a chip, banner, error line, empty state, or side-panel-with-close-button is hand-rolled from scratch.

---

## 1. Body containers & sections

Four different container idioms, none reusing another:

- **`DashboardsPage.tsx:39`** — bare `<div className="flex h-full flex-col gap-4 p-6">`, no `admin-card`/`admin-frame`. Header is explicitly hand-rolled with a comment justifying the deviation from `AdminPageHeader` (lines 40-43).
- **`DashboardDetailPage.tsx:131,137-140`** — split-pane `<div className="flex h-full min-h-0">` with its own `<header className="flex items-center gap-3 border-b px-6 py-3" style={{borderColor:'var(--sep)'}}>`, again explicitly justified in a comment (lines 133-136) as unable to use `AdminPageHeader` (no subtitle slot). Body wrapper `<div className="min-h-0 flex-1 overflow-auto p-4">` (line 198).
- **`AddWidgetPanel.tsx:150-157`** / **`DashboardVersionsPanel.tsx:21-29`** — a slide-in `<aside className="flex w-80 shrink-0 flex-col border-l" style={{borderColor:'var(--sep)', background:'var(--panel)'}}>` with its own header row (`border-b px-3 py-2.5`, `<h2 className="text-sm font-semibold">` + a bare `✕` glyph close button, not the Dialog close icon). The two panels are pixel-identical in structure (compare `AddWidgetPanel.tsx:150-170` to `DashboardVersionsPanel.tsx:21-41`) but are two separate hand-copies rather than one `SidePanel` primitive.
- **`SearchPage.tsx:145-149`** — uses `AdminPageHeader` (out of scope) then a `<div className="border-b border-[color:var(--sep)] p-5">` filter band and a `<div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">` body. This file is the only one in the slice that consistently uses Tailwind arbitrary-value classes (`text-[color:var(--tx3)]`) instead of `style={{color:'var(--tx3)'}}` — see §11.
- **`NotFoundPage.tsx:10-14`** — the lone user of `admin-card` in the slice: `admin-card flex w-full max-w-md flex-col items-center gap-4 px-8 py-10 text-center`.
- **`BootstrapPage.tsx` / `LoginPage.tsx`** — a wholly separate visual system: `glass-panel` (styles.css:249, its own blur/scrim card) + `rounded-[2rem]` sections in a 2-column `lg:grid-cols-[1.1fr_0.9fr]` layout (`BootstrapPage.tsx:77-78`, `LoginPage.tsx:196-197`), using `var(--line)`/`var(--ink)`/`var(--muted)`/`var(--surface-inverse)` tokens that appear nowhere else in this slice.
- **`ChannelConversationComposePage.tsx:223-241`** — its own fixed-overlay shell (`fixed inset-0 z-[90] … bg-[var(--scrim-strong)] p-6 backdrop-blur-sm`) with a hand-assembled `useModalA11y` call (line 80) rather than the shared `Dialog`. Per CLAUDE.md this is one of the two documented phone-layout-branching dialogs that deliberately stay outside `Dialog.tsx`, so this is not itself a defect — but it is a fourth distinct "panel chrome" recipe in the slice (58px header, `text-[17px] font-bold` title) that doesn't match the 50px `AdminPageHeader` bar or the `aside` panels' header.

**Verdict: many-variants.** No shared "page body" or "side panel" primitive exists; `AddWidgetPanel`/`DashboardVersionsPanel` are close enough to merit one `SidePanel` component. Auth pages are a deliberately separate marketing-style shell and are internally consistent with each other, but share zero tokens/classes with the rest of the admin content system.

---

## 2. Tables & data lists

- **`WidgetPanels.tsx:112-143`** (`TableWidgetView`) — a raw `<table className="w-full border-collapse text-xs">` inside `ExpandableTable` (good — reuses the baseline viewport). But it does **not** use `.admin-table`/`.agents-table` zebra/hover rules: header cells get `className="sticky top-0 …" style={{background:'var(--panel)', color:'var(--tx3)'}}` (line 116-120) and body rows get `style={{borderTop:'1px solid var(--sep)'}}` (line 128) instead of the CSS-class zebra striping every other admin table gets. No row hover, no focus-visible outline, no selection.
- **`DashboardsPage.tsx:117-145`** — the dashboard list is a `<ul className="flex flex-col gap-1.5">` of `<Link>` rows (`flex items-center gap-3 rounded-lg border px-3 py-2.5`), i.e. a card-list, not a table — reasonable for the content shape, but note it duplicates the "row is a bordered `--panel` block with `--sep` border" recipe independently from every other list row in the slice (see `AddWidgetPanel.tsx:174-193`, `SearchPage.tsx:21-24`).
- **`SearchPage.tsx:21-60`** — `SearchResultRow`: a `flex items-center gap-3 rounded-lg px-3 py-2 text-left` row rendered as either `<button>` or `<div>`, hover via `hover:bg-[color:var(--overlay-weak)]`. This is the only list row in the slice with a real hover affordance, and it uses className strings (not `style={{}}`).
- **`AddWidgetPanel.tsx:174-193`** — the widget-kind catalogue is a `<ul>` of `<button>` rows styled `rounded border px-3 py-2 text-left` with `style={{borderColor:'var(--sep)', background:'var(--overlay-weak)'}}` — a third hand-rolled row recipe.

No sorting, selection, sticky-header (beyond the one `sticky top-0` cell), or numeric right-alignment convention is shared across these three list/table shapes.

**Verdict: many-variants.** Reference `.admin-table`/`.agents-table` zebra classes are used nowhere in this slice even though `WidgetPanels.tsx` renders an actual `<table>`. A shared "row card" component (row/link with leading marker, primary + secondary text, trailing meta) would cover `DashboardsPage`, `SearchPage`, and `AddWidgetPanel`'s catalogue list at once.

---

## 3. Pagination & loading more

**n/a in this slice.** No file paginates: `DashboardsPage` renders its full filtered array, `SearchPage` renders full per-category arrays with no limit/cursor, `DashboardVersionsPanel` renders the full version list. `PaginationFooter` is imported nowhere.

---

## 4. Forms

Three unrelated form idioms:

- **`AddWidgetPanel.tsx`** — a bespoke `Field` wrapper (lines 42-49): `<label className="flex flex-col gap-1"><span className="text-[11px] uppercase tracking-wide" style={{color:'var(--tx3)'}}>{label}</span>{children}</label>`. Every control (`<input>` line 206, two `<select>`s lines 216, 237, 256) shares one `selectStyle` object (lines 51-55) plus the class `rounded border px-2 py-1.5 text-sm` — this is a hand-rolled twin of `.admin-input`, not `.admin-input` itself (different radius: `rounded` = 4px default vs `.admin-input`'s 8px; different padding: `px-2 py-1.5` vs `10px 12px`). The "Tone" field (lines 271-288) is a hand-rolled multi-select **button group** (not `Switch`, not `TabBar`, not a native radio) toggling `background: tone===candidate ? 'var(--accent)' : 'var(--overlay-weak)'` per button.
- **`BootstrapPage.tsx:9-14` / `LoginPage.tsx:18-23`** — byte-for-byte duplicated `fieldClass` constant (`w-full rounded-2xl border border-[var(--line)] bg-[color:var(--surface-inverse)] px-4 py-3 text-sm text-[var(--ink)] outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]`) defined independently in both files. Label pattern is `<label className="grid gap-2 text-sm"><span>Email</span><input className={fieldClass} .../></label>` (`BootstrapPage.tsx:113-123`, `LoginPage.tsx:265-275`) — label-above, no `<label htmlFor>`/`id` pairing beyond implicit nesting, no help text, no required-marker glyph (relies on native `required` only).
- **`ChannelConversationComposePage.tsx:262-315`** — the "To" recipient field is a third form idiom again: a bordered `admin-card`-less box (`rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-3`) containing chips (`rounded-md bg-[color:var(--overlay)] px-2 py-1`) plus a borderless `<input>` (`bg-transparent … outline-none`), with a custom keyboard-driven combobox listbox below it (lines 317-362) — closer to a tag/multiselect input pattern than any admin form field elsewhere in the app.

Save/submit placement also differs: `AddWidgetPanel`'s Save button sits at the bottom of the scrollable panel body (line 296, `mt-1`, full width via panel width); `BootstrapPage`/`LoginPage` submit buttons are `w-full` inside the form (`BootstrapPage.tsx:157`, `LoginPage.tsx:287`); `ChannelConversationComposePage`'s send is icon-only, bottom-right of the composer footer (line 385).

**Verdict: many-variants.** No form in this slice uses `.admin-input`/`.admin-input-sm` or `Switch`. `fieldClass`/`primaryButtonClass`/`errorBoxClass` in `BootstrapPage.tsx` and `LoginPage.tsx` are close-to-identical duplication begging for one shared constant/component (a "public-auth form field" primitive), independent of whatever in-app form primitive eventually generalizes `AddWidgetPanel`'s `Field`.

---

## 5. Validation & field errors

No file in this slice uses `FormFieldError`, `fieldErrorAria`, `renderFieldError`, or `fieldErrorProps`. Every error is a bare, un-announced string:

- **`AddWidgetPanel.tsx:290-294`** — `{error ? <p className="text-xs" style={{color:'var(--danger-text)'}}>{error}</p> : null}`. No `role="alert"`, no `aria-describedby` link to the field, no `aria-invalid` on any control. Shown only after a failed save attempt (submit-time), never per-keystroke.
- **`BootstrapPage.tsx:22-26,155` / `LoginPage.tsx:31-35,247`** — `errorBoxClass` (`rounded-2xl border border-[color:var(--danger-border)] bg-[color:var(--danger-soft)] px-4 py-3 text-sm text-[color:var(--danger-text)]`), rendered as `{error ? <div className={errorBoxClass}>{error}</div> : null}` — a boxed banner, unlike `AddWidgetPanel`'s bare line, but still no `role="alert"`/id wiring. Identical class string duplicated verbatim between the two files.
- **`ChannelConversationComposePage.tsx:382-384`** — `<div className="text-sm text-[color:var(--danger-text)]">{error}</div>`, permanently in the DOM (empty when no error) inside the composer footer, no role/id at all — a third shape (bare colored text, no box, no icon) for the same "recipient required / send failed" class of error as `AddWidgetPanel`'s.
- **`SearchPage.tsx:181-193`** — `results.errorMessage` renders as `<p className="px-3 text-sm text-[color:var(--danger)]">` (note: `--danger`, not `--danger-text`, the token every other file in this slice uses for error prose — see §11).

**Verdict: many-variants** (three unstyled/boxed shapes, zero accessibility wiring, one token drift). This is a strong candidate to route through `fieldErrorProps`/`renderFieldError` even where the visual stays a bare line, purely to get `role="alert"`+ids for free.

---

## 6. Feedback after actions

- **`DashboardsPage.tsx`** — no post-action feedback at all: `createDashboard.mutate(...)` (lines 68-70, 107-109) has no success/error banner; a failed create silently does nothing visible beyond the button's own pending state.
- **`DashboardDetailPage.tsx:176-183`** — "Done"/"Edit" toggle button text doubles as save feedback (`{saveLayout.isPending ? 'Saving…' : 'Done'}`); no confirmation after a successful save, no error path if `saveLayout` rejects.
- **`AddWidgetPanel.tsx`** — the only success feedback in the slice is implicit (`onAdded(); onClose()` on success, line 138) — the panel just closes; failure alone gets visible text (§5).
- **`BootstrapPage.tsx` / `LoginPage.tsx`** — same pattern: error is shown (§5), success is a silent `navigate('/channels')` (`BootstrapPage.tsx:67`, `LoginPage.tsx:140,154`) with no transient "Signed in" state.
- `Notice`/`FeedbackBanner` (the settings-shared pattern) is used nowhere in this slice.

**Verdict: consistent, but only because feedback is uniformly absent.** Every mutating action in this slice communicates failure (inconsistently, per §5) and never communicates success beyond navigating away or closing a panel. Missing primitive: none needed structurally, but `Notice`/`FeedbackBanner` would be the natural fit if these surfaces gain success toasts.

---

## 7. Loading / error / empty states

At least five distinct triads in one slice:

- **`DashboardsPage.tsx:86-148`** — the only `QueryState` user in the slice: `loadingLabel="Loading…"`, `errorLabel="Failed to load dashboards." ` + Retry (from `QueryState` itself), and a **hand-written empty state** (lines 92-115, a bordered card with heading + subtext + a secondary "start blank" button) rather than `EmptyState`.
- **`DashboardDetailPage.tsx:115-128`** — completely different, and does not reuse `QueryState`: `if (isLoading) return <p className="p-6 text-sm" style={{color:'var(--tx3)'}}>Loading…</p>` (left-aligned, not centered `py-8` like `QueryState`), and `if (!dashboard) return <p ...>This dashboard is not available.</p>` — the exact same text/branch is used for both "still loading nothing yet" and "the id doesn't exist / fetch failed", so a failed fetch and a bad URL are indistinguishable (the same defect `QueryState`'s doc comment says `DashboardsPage` used to have, now reintroduced one file over). Its own empty-widgets state (lines 209-232) is a third hand card, structurally identical to `DashboardsPage`'s but independently written.
- **`AddWidgetPanel.tsx` / `DashboardVersionsPanel.tsx:44-51`** — `DashboardVersionsPanel` hand-rolls its own tiny loading/empty pair: `{isLoading ? <p ...>Loading…</p> : (versions??[]).length===0 ? <p ...>No changes recorded yet.</p> : (...)}` — no error branch at all (a failed `useDashboardVersions` fetch silently renders "No changes recorded yet", i.e. the exact "empty and error are indistinguishable" failure `QueryState` was built to fix).
- **`EmbeddedWidget.tsx:57-68`** — a fourth loading treatment: a raw pulse skeleton `<div className="h-32 animate-pulse rounded-lg border" .../>`, distinct from `WidgetSkeleton` in `WidgetFrame.tsx:197-202` (`h-full min-h-[64px] w-full animate-pulse rounded`) even though both exist to fill the same "widget is loading" role on the same surface family.
- **`SearchPage.tsx:174-193`** — has an empty-query prompt and a no-results line, but **no loading state is ever rendered**: `results.isLoading` is checked only to gate the "No results" branch (line 180); while a query is in flight with zero results so far, the page silently shows nothing (falls into the results-rendering branch with all arrays empty).
- **`WidgetFrame.tsx` / `WidgetPanels.tsx`** widget-body states (`denied`/`unsupported`/`loading`/`error`/`empty`) are a purpose-built, well-designed triad-plus (`DashboardWidgetCard.tsx:49-73`) that is the strongest state-handling in the slice — see "good model" below.

**Verdict: many-variants.** `QueryState` is used exactly once out of at least six list/detail fetches in this slice; three of the other five conflate "loading" with "empty" or "error" with "empty" in ways `QueryState`'s own doc comment identifies as the bug it was written to prevent.

---

## 8. Status chips & badges

Four independent tone→colour maps live in the dashboards components alone, none derived from `Pill`'s `toneClasses`:

1. **`widget-format.ts:20-27`** `toneVars` — `DashboardTone` (`neutral|accent|info|success|warning|danger`) → `{line, soft, text}` CSS var triples, used for chart series and the stat value colour (`WidgetPanels.tsx:57`).
2. **`WidgetFrame.tsx:25-33`** `stateDot` — `fresh|stale|error|empty|loading|denied|unsupported` → a single colour for the 6px freshness dot (line 76-79).
3. **`WidgetFrame.tsx:165-194`** `WidgetPlaceholder` — its own inline `tone === 'danger' ? 'var(--danger-soft)' : tone === 'warning' ? 'var(--warning-soft)' : 'var(--overlay-weak)'` ternary chain, i.e. a third, independently-typed re-implementation of `Notice`'s `danger/warning`-only subset, as `style={{}}` rather than `Pill`/`Notice`'s className maps.
4. **`WidgetPanels.tsx:153-158`** `STATE_TONE` — `ok|warning|failing|unknown` → `{label, color, background}`, rendered as a `<span className="w-fit rounded px-2 py-1 text-sm font-semibold" style={{background, color}}>` (lines 179-185) — visually a status pill, structurally nothing like `Pill` (no `rounded-full`, no uppercase/tracking, a bespoke 4-value enum instead of `Pill`'s 5-tone `PillTone`).

Elsewhere in the slice: `DashboardsPage.tsx:128-133` renders the dashboard's "home" (organisation/project/team/…) as a bare `<span className="rounded px-1.5 py-0.5 text-[11px]" style={{background:'var(--overlay-weak)', color:'var(--tx3)'}}>` — a fifth ad hoc chip, and `dashboard.createdByType === 'agent'` renders as plain coloured text (`text-[11px]" style={{color:'var(--thinking)'}}`, line 134-138) rather than a chip at all, even though it is exactly the "agent vs person" distinction `Pill tone="accent"` exists to mark (per `Pill.tsx`'s own doc comment, `--thinking` is the accent-family foreground token).

**Verdict: many-variants — worst category in this slice.** Four independently-typed tone enums plus two more one-off chips, zero using `Pill`. `Pill`'s existing `tone`/`radius`/`size` API already covers `success`/`warning`/`danger`/`muted`/`accent`; the dashboard-specific `DashboardTone` (`info` + `neutral`) and the freshness/status vocabularies would need one or two additional tones added to the shared map rather than five parallel ones.

---

## 9. Detail / key-value views

- **`DashboardVersionsPanel.tsx:53-69`** is the only real key-value/detail list in the slice: an `<ol>` of `{timestamp · agent-marker} / {summary}` pairs, each row `flex flex-col gap-0.5`, timestamp row `text-[11px]` colour `--tx3`, summary `text-xs` colour `--tx2`. No `<dl>`, no two-column grid.
- **`BootstrapPage.tsx:90-107`** — a two-row "Bootstrap URL" / "Current mode" key-value block, but built as stacked `<div>`s (`text-xs uppercase tracking-[0.24em] text-[var(--muted)]` label over `mt-1 text-sm` value, lines 92-95, 100-103), not a `<dl>`, and using the auth-page's separate `--muted` token rather than `--tx3`.
- No dashboard/search page has a true "detail page" composed of metadata rows the way, e.g., an entity detail page would (`DashboardDetailPage` is a canvas, not a metadata view).

**Verdict: two-variants** (an `<ol>` list-of-rows vs. stacked label/value `<div>` pairs), both hand-rolled, neither using `<dl>`/`sectionTitleClass`. Low volume — not a priority win by itself, but the `BootstrapPage` label pattern (`text-xs uppercase tracking-[0.24em] text-[var(--muted)]`) is a near-duplicate of `SectionLabel`'s `xs` variant (`text-xs tracking-[0.2em] font-semibold uppercase text-[color:var(--tx3)]`) with a different token and no bold weight — another place `SectionLabel` could be reused (with a token fix) instead of re-typed.

---

## 10. In-content filters, search boxes & toolbars

- **`DashboardsPage.tsx:54-64`** — search box is embedded directly in the page-title header row (`<input className="ml-auto w-56 rounded border px-2 py-1.5 text-sm" style={{background:'var(--panel)', borderColor:'var(--sep)', color:'var(--tx)'}}/>`), i.e. a hand-rolled input distinct from `.admin-input` (rounded = 4px vs 8px; no focus ring — `.admin-input:focus` box-shadow is never picked up because the class isn't used). No count summary ("N dashboards") anywhere.
- **`SearchPage.tsx:149-171`** — filter row is its own banded section below the page header (`border-b border-[color:var(--sep)] p-5`), input **does** use `admin-input` (line 153), paired with `SearchModeToggle` (`TabBar`, out of scope). This is the one place in the slice a real `admin-input` filter box appears.
- **`AddWidgetPanel.tsx`** "Data source" `<select>` (lines 216-232) functions as an in-form filter (narrows which column pickers appear) but is styled with the same non-`admin-input` `selectStyle` object as every other control in that panel (§4).
- No count summary ("34 items") is rendered anywhere in this slice — `DashboardsPage`'s filtered list and `SearchPage`'s per-category results never state a total.

**Verdict: two-variants** (`DashboardsPage`'s bespoke input vs. `SearchPage`'s real `admin-input`), and a missing count-summary convention across both list surfaces.

---

## 11. Typography & spacing inside content

- **Colour delivery mechanism is the single biggest split in this slice.** `DashboardsPage.tsx`, `DashboardDetailPage.tsx`, `AddWidgetPanel.tsx`, `DashboardVersionsPanel.tsx`, `EmbeddedWidget.tsx`, `WidgetFrame.tsx`, `WidgetPanels.tsx`, and `WidgetCharts.tsx` universally use `style={{color: 'var(--tx3)'}}` (inline style objects — 60+ occurrences, see the per-file `style={{` counts gathered during this audit: `DashboardsPage.tsx` 13, `DashboardDetailPage.tsx` 14, `AddWidgetPanel.tsx` 12, `WidgetFrame.tsx` 10, `WidgetPanels.tsx` 9, `DashboardVersionsPanel.tsx` 9, `EmbeddedWidget.tsx` 6, `WidgetCharts.tsx` 3). `SearchPage.tsx`, `HighlightedPassage.tsx`, `NotFoundPage.tsx`, `BootstrapPage.tsx`, and `LoginPage.tsx` instead use Tailwind arbitrary-value classes (`text-[color:var(--tx3)]`, `border-[color:var(--sep)]`) with **zero** `style={{}}` usage (`SearchPage.tsx` 0, `NotFoundPage.tsx` 0, `BootstrapPage.tsx` 0). These are visually identical outcomes reached by two entirely different authoring conventions, split roughly file-by-file rather than by any content rule — every dashboard-widget file is in the `style={{}}` camp, everything else is in the class-string camp.
- **Token drift:** `SearchPage.tsx:182,191` uses `text-[color:var(--danger)]` for error prose where every other error line in the slice uses `--danger-text` (`AddWidgetPanel.tsx:291`, `BootstrapPage.tsx`/`LoginPage.tsx` `errorBoxClass`, `WidgetPlaceholder`'s danger tone). `--danger` is the saturated/fill token (matches `Pill`'s and `Notice`'s convention of `*-text` for foreground-on-panel prose), so this is a likely-visible mismatch, not just a style-authoring nit.
- **Auth pages use a disjoint token set** — `var(--line)`, `var(--ink)`, `var(--muted)`, `var(--surface-inverse)` (`BootstrapPage.tsx:10-26`, `LoginPage.tsx:19-35`) — that does not appear anywhere else in this slice (which otherwise uses `--sep`/`--tx`/`--tx2`/`--tx3`/`--panel`). This may be intentional (a distinct pre-auth theme surface) but means the two token vocabularies cannot be assumed interchangeable by a future unification pass.
- **Border-radius scale is wide open:** `rounded` (4px, `AddWidgetPanel.tsx` controls), `rounded-md`/`rounded-lg`/`rounded-xl` mixed within a single file (`DashboardsPage.tsx` uses `rounded-lg` for the empty card at line 94 and plain `rounded` for the search input at line 55 and the create button at line 66), `rounded-2xl` (auth pages' `fieldClass`/buttons), `rounded-[2rem]` (auth pages' outer panels), `rounded-[1.5rem]` (`BootstrapPage.tsx:90`). No file in this slice reuses another file's radius choice for an equivalent element (input vs input, button vs button).
- **Padding scale:** side panels consistently use `p-3`/`px-3 py-2.5` (`AddWidgetPanel.tsx`, `DashboardVersionsPanel.tsx`); `DashboardsPage`/`SearchPage` bodies use `p-5`/`p-6`; auth-page cards use `p-8 md:p-10`. Internally consistent per-surface, but no shared scale token names them.

**Verdict: many-variants.** The `style={{}}` vs `text-[color:var(--x)]` split is the single highest-volume, most mechanical fix available in this slice (see wins below) — it changes no pixel, only authoring convention, and touches ~65 call sites across 7 files.

---

## 12. Destructive & confirm flows with forms in dialogs

**n/a in this slice.** No destructive action (delete dashboard, delete widget, remove recipient beyond a simple chip-x, cancel bootstrap) exists in any of these files, and `ConfirmDialog`/`Dialog` is imported nowhere. `ChannelConversationComposePage.tsx` is the one dialog-shaped surface, and it is a create flow, not a destructive one (see §1 for why it stays outside `Dialog.tsx`).

---

## Good model / worst offender

- **Good model: `components/features/dashboards/WidgetFrame.tsx` + `DashboardWidgetCard.tsx`.** The `state` machine (`loading|error|empty|denied|unsupported|stale|fresh`) is genuinely well designed — one `WidgetBody` switch (`DashboardWidgetCard.tsx:46-92`) covers every terminal state with a purpose-built placeholder, the freshness footer is structurally guaranteed rather than optional (per its own doc comment), and the component is reused across three surfaces (`dashboard`/`message`/`knowledge`) via one `surface` prop — a real Rule-zero-§4 win, not a fork. Its one flaw is re-inventing tone colour maps locally instead of extending `Pill`/`Notice` (§8).
- **Worst offender: `components/features/dashboards/AddWidgetPanel.tsx`.** Combines nearly every anti-pattern found in the slice in one file: a hand-rolled `Field`/input/select system that is a near-miss of `.admin-input` rather than a use of it (§4), a bespoke tone-picker button group duplicating what `Switch`/`TabBar` exist for, an unannounced bare-text error line (§5), and its own row-card list for the widget-kind catalogue (§2) — none of it reusing a single shared primitive from the baseline list.

## Top 5 unification wins for this slice

1. **`style={{color:'var(--x)'}}` → `className="text-[color:var(--x)]"`** across `DashboardsPage.tsx`, `DashboardDetailPage.tsx`, `AddWidgetPanel.tsx`, `DashboardVersionsPanel.tsx`, `EmbeddedWidget.tsx`, `WidgetFrame.tsx`, `WidgetPanels.tsx` (~65 call sites) — purely mechanical, zero visual change, and it is what the rest of the slice (`SearchPage.tsx` et al.) already does.
2. **Four tone→colour maps (`toneVars`, `stateDot`, `WidgetPlaceholder`'s ternary, `STATE_TONE`) + two ad hoc chips (`DashboardsPage.tsx`'s home label, agent-authored marker) → one extended `Pill`/tone table.** `Pill` already has `success`/`warning`/`danger`/`muted`/`accent`; the dashboard vocabulary needs `info`/`neutral` folded in once, not five independent enums.
3. **`AddWidgetPanel.tsx`'s and `DashboardVersionsPanel.tsx`'s `aside` shells (identical header/close-button/scroll-body structure, `AddWidgetPanel.tsx:150-170` vs `DashboardVersionsPanel.tsx:21-41`) → one `SidePanel` primitive.**
4. **`BootstrapPage.tsx` and `LoginPage.tsx`'s byte-identical `fieldClass`/`primaryButtonClass`/`errorBoxClass` constants → one shared `auth-form-shared.tsx` module** (mirroring `pages/settings/settings-shared.tsx`'s existing role for settings pages), closing the duplication and the `role="alert"` gap in §5 at the same time.
5. **Every hand-written "loading…"/"no results"/"failed" triad that isn't `QueryState`** (`DashboardDetailPage.tsx:115-128`, `DashboardVersionsPanel.tsx:44-51`, `EmbeddedWidget.tsx`'s bespoke skeleton, `SearchPage.tsx`'s missing loading state) **→ `QueryState`**, which would also fix the two real bugs found (`DashboardDetailPage` conflating "loading" with "not found", `DashboardVersionsPanel` conflating "empty" with "fetch failed").
