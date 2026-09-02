# Ops & Billing slice — content design-system audit

Files covered (10, full slice):
- `admin/src/pages/OpsHealthPage.tsx` (178 lines)
- `admin/src/pages/OperationalTelemetryPage.tsx` (404 lines)
- `admin/src/pages/TokenUsagePage.tsx` (88 lines)
- `admin/src/components/features/billing/UoaBillingCreditsPanel.tsx` (448 lines)
- `admin/src/components/features/billing/UoaBillingRecurringAddonsPanel.tsx` (240 lines)
- `admin/src/components/features/billing/UoaBillingCancellationDialog.tsx` (285 lines)
- `admin/src/components/features/billing/UoaBillingStatementPanel.tsx` (250 lines)
- `admin/src/components/features/billing/UoaBillingStatementDetails.tsx` (339 lines)
- `admin/src/components/features/budgets/BudgetManager.tsx` (415 lines)
- `admin/src/components/features/budgets/PricingManager.tsx` (234 lines)

One-level-in imports checked for content shape: `OwnerGate.tsx` (access-gate markup), `Pill.tsx` (whose own doc-comments already flag several of the findings below as known-unconverted), `SectionLabel.tsx`. No table primitive (`ExpandableTable`/`admin-table`/`agents-table`) is used anywhere in this slice — confirmed by grep, zero `<table>` elements. No `QueryState`, `EmptyState`, `PaginationFooter`, `FormFieldError`, `Notice`, or the shared `Dialog`/`ConfirmDialog` is imported anywhere in this slice either — confirmed by grep. Everything here is hand-rolled.

---

## 1. Body containers & sections

- Every page body: `<section className="flex h-full min-h-0 flex-col">` + `<div className="min-h-0 flex-1 overflow-y-auto p-4">` — consistent across `OpsHealthPage.tsx:96-99`, `OperationalTelemetryPage.tsx:160-163`, `TokenUsagePage.tsx:64-67`. Good, identical shell.
- Inside the body, sections are `admin-card` (12px radius, `border: 1px solid var(--sep)`, `background: var(--panel)`, no padding of its own per `styles.css:1972-1976`) with caller-supplied padding — but the padding value is picked per call site with no rule: `p-3` (`OpsHealthPage.tsx:41,112,119,140,164`), `p-4` (`OperationalTelemetryPage.tsx:199,209,215,294…`, `BudgetManager.tsx:184`, `PricingManager.tsx:128`), `p-5` (`UoaBillingCreditsPanel.tsx:384`, `UoaBillingStatementPanel.tsx:106`, `UoaBillingRecurringAddonsPanel.tsx:41`).
- **Second card family, unconverted**: the billing components (`UoaBillingCreditsPanel.tsx`, `UoaBillingRecurringAddonsPanel.tsx`, `UoaBillingStatementPanel.tsx`, `UoaBillingStatementDetails.tsx`, `UoaBillingCancellationDialog.tsx`) use `.admin-card` only once per file for the *outer* section wrapper, then switch to a **hand-rolled nested card**, `rounded-lg border border-[color:var(--sep)] p-3` (8px radius vs admin-card's 12px), for every item inside — 22 occurrences across 5 files (`UoaBillingCreditsPanel.tsx` ×11, `UoaBillingStatementDetails.tsx` ×5, `UoaBillingRecurringAddonsPanel.tsx` ×2, `UoaBillingCancellationDialog.tsx` ×2, `UoaBillingStatementPanel.tsx` ×2). `BudgetManager.tsx`/`PricingManager.tsx`/`OpsHealthPage.tsx`/`OperationalTelemetryPage.tsx` never do this — their nested rows all reuse `.admin-card` (e.g. `BudgetManager.tsx:359`, `OperationalTelemetryPage.tsx:236`). So there are literally two card systems, split cleanly along a file-tree boundary (`budgets/`+ops pages vs `billing/`).
- Section headings inside bodies are consistently `SectionLabel` (uppercase dim label) — used in all 10 files, no hand-rolled `h2`/`h3` used *as a section label*. `h2`/`h3` do appear, but only as a card's headline value, not a section divider (e.g. `UoaBillingCreditsPanel.tsx:403` `<h2>` for the balance label, `UoaBillingStatementPanel.tsx:109` `<h2>` for "UnlikeOtherAI billing").
- Vertical rhythm between sections is ad hoc: `mt-4`/`mt-5`/`mt-6` used near-interchangeably for the same "next section" gap — `OperationalTelemetryPage.tsx` alone uses `mt-4` (198), `mt-6` (291, 349), `mt-5` (never, uses mt-4/mt-6 only) while `UoaBillingCreditsPanel.tsx` uses `mt-5` throughout (194, 232, 249) and `UoaBillingStatementDetails.tsx` uses `mt-6` throughout (162, 189, 217…).
- `OpsHealthPage.tsx:87-93` and `TokenUsagePage.tsx:55-61` and `OwnerGate.tsx:50-56` (imported by `OperationalTelemetryPage.tsx`) each render a full-bleed "you can't be here" gate with **byte-identical** wrapper markup — `<section className="flex h-full items-center justify-center text-[color:var(--tx3)]">…</section>` — but three different predicates (instance super-admin, signed-in, org owner) and three copies of the markup, only one of which (`OwnerGate`) is a shared component. `OpsHealthPage` and `TokenUsagePage` re-type the identical className string by hand instead of parameterising `OwnerGate` (or a more general `AccessGate`) with their own predicate/copy.

**Verdict: many-variants.** Missing primitive: a generic `AccessGate`/`RequireRole` wrapping the pattern `OwnerGate` already implements, parameterised by predicate + message. Missing/needed: a single `SectionCard`/nested-card primitive to replace the second, 8px-radius card family in `billing/*`.

## 2. Tables & data lists

No `<table>` anywhere in this slice. All "lists" are `<div className="grid gap-2">` of row `admin-card`s (ops pages, budgets) or of hand-rolled `rounded-lg border` rows (billing). Row shapes:
- **Two-line row, flex-justify-between**: `justify-between` header row (title left, value/meta right) + a second `text-xs text-[color:var(--tx2)]` detail line underneath. This exact shape repeats at: `OpsHealthPage.tsx:140-151` (dead job), `OpsHealthPage.tsx:164-169` (dead letter), `OperationalTelemetryPage.tsx:235-254` (token breakdown), `:265-286` (outcome), `:328-343` (file breakdown), `:383-396` (connector breakdown), `BudgetManager.tsx:359-389` (budget row), `PricingManager.tsx:208-226` (pricing row), and inside billing in `UoaBillingCreditsPanel.tsx:203-227` (activity entry), `UoaBillingStatementDetails.tsx:169-185` (line item), `:243-266` (usage line), `:299-318` (per-user usage). That's **11 near-identical hand-rolled "list row" implementations**, none sharing a component — each retypes `flex items-center justify-between` / `flex items-start justify-between gap-4` and the left/right block structure from scratch.
- No sorting, selection, sticky header, or zebra striping anywhere (none of these lists are large enough to need them, but there is also no shared affordance to add it to).
- No numeric/right alignment convention name — `text-right` is used ad hoc (`OperationalTelemetryPage.tsx:246`, `UoaBillingStatementDetails.tsx:257`) but the numeric value itself sometimes gets `font-mono` (`OperationalTelemetryPage.tsx:247,278,336,389`, `UoaBillingStatementDetails.tsx:181,258`) and sometimes doesn't (`UoaBillingCreditsPanel.tsx:219` credit delta, `BudgetManager.tsx:380` spend line) — no rule for which numbers are monospaced.
- Actions column: `BudgetManager.tsx:390-406` and `PricingManager.tsx:216-224` put Edit/Delete buttons inline at the bottom of the row card (not a column at all — this is a card list, not a table), which is consistent with each other but is really "form row with trailing controls," not a table pattern.
- `OpsHealthPage.tsx:148-150` is the one place a **raw `<pre>` block** with its own `bg-[color:var(--scrim)]` + `rounded` + `text-[11px]` styling appears (dead-job error text) — a one-off, not reused elsewhere in-slice.

**Verdict: many-variants.** No shared "list row" primitive exists; 11+ hand-rolled instances of the same two-line row shape. `ExpandableTable`/`.admin-table` are simply not reached for by this slice even where a real table (e.g. the pricing profiles, or the per-user usage table) would be the more legible shape.

## 3. Pagination & loading more

**n/a in this slice.** No list here paginates, cursors, or offers "load more" — every collection (dead jobs, breakdowns, budgets, pricing profiles, statement lines) is rendered in full with no cap, no `PaginationFooter`, and no server-side page param. This is a gap, not a variant — worth flagging to the synthesizer since some of these (statement line items, per-user usage) could plausibly grow large.

## 4. Forms

- **Two field-layout conventions, cleanly split by file**:
  - `BudgetManager.tsx` / `PricingManager.tsx`: every field is `<label className="text-xs text-[color:var(--tx2)]">Label text<input/select className="admin-input mt-1" …/></label>` — label text and control are both children of one `<label>`, label above control via block flow, e.g. `BudgetManager.tsx:193-207`, `PricingManager.tsx:137-154`. No `<span>`/explicit id, relies on implicit label-wraps-input association. Help text (where present) is a `<span className="mt-1 block text-[11px] text-[color:var(--tx3)]">` sibling inside the same `<label>` (`BudgetManager.tsx:266-268`).
  - `OperationalTelemetryPage.tsx`: the two group-by `<select>`s (`:165-178`, `:352-363`) use `aria-label` instead of a visible `<label>` at all — no visible label text, just a bare `admin-input` select with `aria-label="Group token telemetry"`. This is a third pattern (control with no visible label) sitting beside the label-wraps-control convention used two files over in the same feature area.
  - Billing forms are mostly button-driven (top-up offers, subscribe/cancel), not text-input forms, except `UoaBillingCancellationDialog.tsx:127-155` which uses a `<fieldset>`/`<legend>` + custom radio-card list (`has-[:checked]:border-[color:var(--accent)]`) — the only fieldset/legend and the only `has-[:checked]` styling trick in the slice, unique to this one file.
- No control in this slice uses `Switch` — `BudgetManager.tsx:308-315` implements "block humans" as a raw `<input type="checkbox">` inside a `<label className="flex items-center gap-2 …">`, not the shared `Switch` primitive.
- No required-field marker convention exists anywhere (nothing here marks a field required visually; validation is all deferred to submit-time free text, see §5).
- Form action row placement: `BudgetManager.tsx:341-353` and `PricingManager.tsx:175-187` both place `Clear` (secondary) + `Save` (primary) right-aligned via `flex items-center justify-end gap-2` directly under the field grid — consistent between the two budgets files, and the one place a save-row convention repeats twice.
- No autosave anywhere; all saves are explicit-button + `useMutation`.
- Disabled/pending state: consistently `disabled={mutation.isPending}` on the primary button, but the label doesn't change to reflect pending on `BudgetManager`'s Save ("Save budget" stays static, `:345-352`) while `PricingManager`'s recompute button does swap text (`"Re-pricing…"`, `:202`) and the billing dialogs swap "Confirming…" (`UoaBillingStatementPanel.tsx:233`, `UoaBillingCancellationDialog.tsx:233`) — inconsistent whether pending state gets a text change or just a disabled attribute.

**Verdict: many-variants.** Missing primitive: a `FormField`/`Field` wrapper (label placement + help text + error slot) — `FormFieldError` exists as a helper but nothing in this slice composes label+control+help into one reusable shape, so the label-wraps-input string gets retyped per field (20+ times across `BudgetManager.tsx`/`PricingManager.tsx` alone).

## 5. Validation & field errors

- `FormFieldError` is never imported anywhere in this slice.
- Both `BudgetManager.tsx:354` and `PricingManager.tsx:188` render **byte-identical** form-level error markup: `{formError && <div className="mt-2 text-xs text-[var(--danger-text)]">{formError}</div>}` — one string, one shared component missing, duplicated verbatim.
- No field is ever individually marked invalid — validation is entirely submit-time, whole-form, single free-text message (`setFormError('Caps must be non-negative numbers…')`, `BudgetManager.tsx:127-129`; similarly `PricingManager.tsx:113-116`). No `aria-invalid`, no `aria-describedby`, no `role="alert"` anywhere in the slice.
- Billing action errors use a **different** class string for what is semantically the same thing: `text-[color:var(--danger-text)]` (note the `color:` prefix) at `UoaBillingCreditsPanel.tsx:368`, `UoaBillingRecurringAddonsPanel.tsx:132`, `UoaBillingStatementPanel.tsx:230`, `UoaBillingCancellationDialog.tsx:206,213` — vs. `text-[var(--danger-text)]` (no `color:` prefix) in `BudgetManager.tsx:354` and `PricingManager.tsx:188`. Same token, two different Tailwind arbitrary-value syntaxes, split along the same billing/budgets file-tree line as the card-radius split in §1.
- Size/spacing of the error line also varies: `mt-2 text-xs` (budgets) vs `mt-3 text-xs` (`UoaBillingCreditsPanel.tsx:367`) vs `mt-4 text-sm` (`UoaBillingRecurringAddonsPanel.tsx:131`, `UoaBillingStatementPanel.tsx:229`).

**Verdict: many-variants** (well, one variant used many times with small text/spacing drift). Missing primitive: form-level error banner (a plain-text one, distinct from `Notice`'s boxed tone banner) — this slice doesn't want a full `Notice` box for these, just a shared "form error line" component.

## 6. Feedback after actions

- No toasts anywhere in this slice.
- `Notice` (the shared tone-banner primitive) is **never imported**, despite this slice repeatedly hand-rolling the exact shape `Notice` exists to replace: `OperationalTelemetryPage.tsx:190-196` and `UoaBillingCreditsPanel.tsx:391-395`, `UoaBillingRecurringAddonsPanel.tsx:48-52`, `UoaBillingStatementPanel.tsx:132-136` **all** render `rounded-md border border-[var(--warning-soft)] bg-[var(--warning-soft)] p-3 text-sm text-[var(--warning-text)]` — a warning-tone banner with border and fill on the *same* token (each carries a code comment noting "the border deliberately matches the fill … so no outline shows", e.g. `UoaBillingCreditsPanel.tsx:390`). This is `Notice tone="warning"`'s job, done by hand 4 times with an admittedly-invisible border, plus a 5th near-miss at `OperationalTelemetryPage.tsx:191` using `.admin-card` composed with the same override classes — flagged in its own code comment as **not actually applying** (`admin-card` wins the CSS-layer fight, so the intended warning tint silently fails to render there — a real visual bug, not just an inconsistency).
- Transient "Saved" feedback: `PricingManager.tsx` shows a persistent (not auto-dismissing) `recomputeMsg` line (`:205`, styled `text-xs text-[color:var(--tx2)]`, neutral tone even on success) directly under the section header — this is the only "action completed" feedback text in the slice; `BudgetManager.tsx`'s save has no success message at all beyond the form clearing (`resetForm()` on success, `:105-109`) with no visible confirmation.
- Checkout-return notice on `TokenUsagePage.tsx:68-81` is its own one-off card (`admin-card mb-4 border border-[color:var(--sep)] p-4` with `role="status"`), semantically a success/info banner but built from raw `admin-card` + manual border rather than `Notice`.

**Verdict: many-variants**, converging on one missing primitive: `Notice` exists and is right for at least 5 of these sites but isn't used once in this slice.

## 7. Loading / error / empty states

`QueryState` and `EmptyState` are never imported. Every list independently hand-rolls its own triad:
- **Loading**: plain text, no spinner, wording varies per file — `"Loading team credits…"` (`UoaBillingCreditsPanel.tsx:387`), `"Loading subscriptions and add-ons…"` (`UoaBillingRecurringAddonsPanel.tsx:44`), `"Loading customer statement…"` (`UoaBillingStatementPanel.tsx:127`) — consistent ellipsis-character style (real `…` not `...`) across billing, but `OpsHealthPage.tsx`/`OperationalTelemetryPage.tsx`/`BudgetManager.tsx`/`PricingManager.tsx` show **no loading state at all** — they just render zeroed/empty defaults (`data?.queue.pending ?? 0`) with no "Loading…" text anywhere, so a slow fetch looks identical to "all zero."
- **Error**: no Retry action anywhere in the whole slice (every error state is text-only, dead end — refresh is the page's `Refresh` header action on `OpsHealthPage` only, not tied to the error state itself).
  - `OpsHealthPage.tsx:104-108`: `admin-card mb-4 p-4 text-sm text-[color:var(--danger-text)]`.
  - Billing error states use the warning-tone banner from §6 (`bg-[var(--warning-soft)]`) even though this is a hard fetch failure, not a warning — a tone mismatch (danger vs warning) between `OpsHealthPage`'s error styling and the billing panels' error styling for the same class of event.
- **Empty**: three different empty-row shapes for "list has zero items" — `<div className="py-6 text-center text-[color:var(--tx3)]">No dead-letter jobs</div>` (`OpsHealthPage.tsx:154-156,171-173`), same shape in `BudgetManager.tsx:409-411` / `PricingManager.tsx:228-230` ("No budgets configured"/"No pricing configured" — `py-6 text-center`), vs. billing's `EmptyLine` component in `UoaBillingStatementDetails.tsx:11-15` (`rounded-lg bg-[color:var(--overlay-weak)] p-3 text-sm text-[color:var(--tx2)]` — a filled box, not centered text) and inline equivalents at `UoaBillingCreditsPanel.tsx:49-53,101-105` and `UoaBillingRecurringAddonsPanel.tsx` (implicit — the whole section returns `null` if `offers.length === 0`, `:34-36`, a third strategy: hide the section entirely rather than show an empty state). This is exactly `EmptyState`'s dashed-card job, done three incompatible ways.

**Verdict: many-variants.** `QueryState` (which already bundles this exact loading/error+retry/empty triad) is available and unused across all 10 files.

## 8. Status chips & badges

- `Pill` is used correctly in `OpsHealthPage.tsx:114` (worker status), `BudgetManager.tsx:367-377` (budget level: ok/warn/over/unlimited) — both map a status enum to a `PillTone` via a `Record` (`WORKER_TONE`, `OpsHealthPage.tsx:34-38`; `levelTone`, `BudgetManager.tsx:55-59`), which is the intended pattern.
- **Every chip in `components/features/billing/*` is hand-rolled instead**, and each occurrence is self-flagged in a code comment as "Unconverted: border-only chip; Pill bordered+muted adds an `--overlay-weak` fill" — i.e. the authors already know this should be `Pill` but `Pill` has no border-only (no-fill) tone to converge on. 7 occurrences of the identical string `rounded-full border border-[color:var(--sep)] px-3 py-1 text-xs text-[color:var(--tx2)]` (or its `px-2 py-0.5 text-[10px]` sibling): `UoaBillingCreditsPanel.tsx:156,296-298,411`, `UoaBillingStatementPanel.tsx:120`, `UoaBillingStatementDetails.tsx:33-36,94-97,204-207`.
- Note this is a **documented, known gap**, not a fresh discovery: `Pill.tsx:49` itself says "as do the border-only billing and executor chips, which have no fill to collapse" in its own tone-mapping comment.
- No raw hex/Tailwind named colors in any chip (all token-based).

**Verdict: two-variants** (`Pill` proper vs. the repeated border-only chip), with the fix already scoped in `Pill`'s own doc comments: add a border-only/outline tone or radius variant to `Pill` and collapse these 7 sites onto it.

## 9. Detail / key-value views

No `<dl>` anywhere in the slice. "Key-value"/stat-tile display is instead **four separately-implemented small components that are the same shape** (label via `SectionLabel`, then a large value, then an optional small detail line):
- `Stat` — `OpsHealthPage.tsx:40-52` (`admin-card p-3`, value `text-2xl font-semibold`, optional danger-red).
- Inline (no extracted component) stat tiles — `OperationalTelemetryPage.tsx:199-224` (Total Tokens/Estimated Cost/Monthly Projection), `:294-323` (Stored/Uploaded/Downloaded/Transfers), `:367-378` (Total Calls/Connector Cost) — 9 copies of `<div className="admin-card p-4"><SectionLabel>…</SectionLabel><div className="mt-2 text-2xl font-bold text-[color:var(--tx)]">…</div>…</div>`, each retyped by hand instead of calling `Stat`, and using `font-bold` where `Stat` uses `font-semibold` for the same visual role.
- `CreditCard` — `UoaBillingCreditsPanel.tsx:23-39` (`rounded-lg border p-3`, value `text-xl font-semibold`).
- `SummaryCard` — `UoaBillingStatementPanel.tsx:24-42` (`rounded-lg border p-3`, value `font-semibold` with no size class at all — smaller than both of the above).

Four components, three different value font sizes (`text-2xl`/`text-xl`/default), two different weights (`font-bold`/`font-semibold`), two different container radii (12px `admin-card` vs 8px `rounded-lg border`), all doing "label / big value / small detail." Beyond stat tiles, other key-value-ish rows (budget spend line `BudgetManager.tsx:379-389`, pricing rate string `PricingManager.tsx:213-216`, statement's `line.raw_units`/`billable_units`/`provider_cost` triad `UoaBillingStatementDetails.tsx:266-276`) are all plain inline strings/joined spans, not any shared key-value structure.

Detail vs list-page composition: there is no true "detail page" in this slice (all three pages are dashboards over aggregate summaries, not a single-entity detail view), so this category is otherwise thin.

**Verdict: many-variants.** This is the clearest, highest-value single win: unify `Stat`/`CreditCard`/`SummaryCard`/the 9 inline copies into one `StatTile` primitive.

## 10. In-content filters, search boxes & toolbars

- `OperationalTelemetryPage.tsx:164-178` group-by filter: bare `<select className="admin-input">` in a `<div className="mb-4 w-full max-w-xs">`, above the stat tiles, no visible label (`aria-label` only).
- `OperationalTelemetryPage.tsx:349-365` connector group-by filter: same `admin-input` select, but this time inline with `SectionLabel` in a `flex items-center gap-4` row (`<SectionLabel>Connector Usage</SectionLabel><div className="ml-auto w-44"><select …/></div>`) — a **different placement convention** (filter beside its section heading) from the first select (filter standalone above the whole page, not tied to a specific section heading) even though both select the same telemetry endpoint's `groupBy` param and sit in the same file 170 lines apart.
- No search box, no date picker, no count summary ("34 items") anywhere in this slice — every list header instead states its count inline in the `SectionLabel` text itself, e.g. `Dead-letter jobs ({data?.deadJobs.length ?? 0})` (`OpsHealthPage.tsx:135-137`), `Configured budgets ({budgets.length})` (`BudgetManager.tsx:356`), `Configured pricing ({profiles.length})` (`PricingManager.tsx:191`) — a third pattern for the same "N items" idea versus a dedicated count element, but at least internally consistent within this slice (3 sites, same `Label (N)` shape via template string inside `SectionLabel`'s children).

**Verdict: two-variants** for filter placement (standalone-above-page vs. inline-with-heading), otherwise thin/n/a (no search, no date filter, no dedicated count component).

## 11. Typography & spacing inside content

- Muted-text token usage is layered consistently in intent (`--tx` primary value, `--tx2` secondary/detail, `--tx3` tertiary/meta) but the exact assignment drifts: e.g. `BudgetManager.tsx:363` uses `--tx3` for the scope-type/mode/period meta line while `OpsHealthPage.tsx:143` uses `--tx3` for a similar attempt/timestamp meta line — consistent there — but `UoaBillingStatementDetails.tsx:283-287` drops to a fourth, undocumented size **and** implicit tertiary color for attribution text: `text-[10px] text-[color:var(--tx3)]` (10px is smaller than any of `text-xs`(12px)/`text-[11px]` used elsewhere).
- Text sizes actually in play across the slice: `text-[10px]` (`UoaBillingStatementDetails.tsx:205,283`, `UoaBillingCreditsPanel.tsx:298`), `text-[11px]` (`OpsHealthPage.tsx:148`, `BudgetManager.tsx:266`), `text-xs` (dozens of sites), `text-sm` (dozens of sites), `text-base` (`UoaBillingStatementDetails.tsx:87`), `text-lg` (`UoaBillingStatementPanel.tsx:109`, `UoaBillingCancellationDialog.tsx:108`, `UoaBillingRecurringAddonsPanel.tsx:56,190`), `text-xl` (`UoaBillingCreditsPanel.tsx:34`), `text-2xl` (`Stat`, inline stat tiles), `text-3xl` (`UoaBillingCreditsPanel.tsx:400`, the one balance headline) — a wide, un-scaled mix with no evident type-scale rule (e.g. `text-[10px]`/`text-[11px]` are arbitrary values sitting a hair below the Tailwind `text-xs` step for no stated reason).
- Padding scale: `p-3`/`p-4`/`p-5` all in active use for what is nominally "a card" (see §1) — no rule for which density gets which padding (compare `admin-card p-3` row cards throughout ops/budgets vs `admin-card p-5` billing section wrappers vs `rounded-lg border p-3` nested billing cards, i.e. p-3 is used at two different visual densities depending on which card family it's paired with).
- Border-radius scale: `admin-card`'s 12px vs. the parallel `rounded-lg` (8px) hand-rolled card family (§1) vs. `rounded-md` (`UoaBillingCreditsPanel.tsx:284`, `UoaBillingCancellationDialog.tsx:190,259`) vs. `rounded` (bare, `OpsHealthPage.tsx:148` pre-block) vs. `rounded-full` (chips) — five different radii doing "container corner," with `rounded-lg` vs `rounded-md` in particular used interchangeably for what reads as the same "inner filled box" role (compare `UoaBillingCreditsPanel.tsx:284` `rounded-md bg-[color:var(--overlay-weak)]` against `UoaBillingStatementDetails.tsx:101` `rounded-lg bg-[color:var(--overlay-weak)]` — same background token, different radius, same semantic role of "a stat chip inside a bigger card").
- Border tokens: `--sep` is used exclusively for borders throughout this slice (no `--line`/`--border-strong` usage found) — that part is consistent.
- No raw hex colors found in this slice. **One raw Tailwind color/opacity utility**: `bg-black/40` at `UoaBillingRecurringAddonsPanel.tsx:185` (the addon-cancellation dialog's scrim) — every other overlay in the slice correctly uses a token (`UoaBillingCancellationDialog.tsx:88` uses `bg-[var(--scrim-strong)] backdrop-blur-sm`), making this a real, isolated defect: same slice, same dialog *concept*, one file uses the theme scrim token and its sibling file uses a hardcoded black.

**Verdict: many-variants.** Concrete asks: pick one radius per container role (card vs. inner-fill box vs. chip), collapse `text-[10px]`/`text-[11px]` into the standard scale or make them an explicit micro-caption token, and fix the one raw-color scrim.

## 12. Destructive & confirm flows with forms in dialogs

- `ConfirmDialog`/`Dialog` (shared shell) is **never used** in this slice.
- `BudgetManager.tsx:398-405` and `PricingManager.tsx:216-224` both wire "Delete" straight to the mutation with **no confirmation step at all** — a bare button, immediate delete, no dialog, no `window.confirm`. This is a real behavioral gap the shared `ConfirmDialog` exists to close (per `AGENTS.md`, `ConfirmDialog` replaced native `window.confirm` deletes elsewhere in the app; these two call sites have neither).
- The two billing cancellation flows **do** build real custom modals, but as **two independent, non-shared implementations** of the same "preview → confirm → done" cancellation shape:
  - `UoaBillingCancellationDialog.tsx` (subscription cancellation): composes `useModalA11y` + `useOverlayDismiss` directly (the same hooks the shared `Dialog` composes), has its own `CloseButton` (custom inline SVG X, `:23-55`), scrim `bg-[var(--scrim-strong)] backdrop-blur-sm` (`:88`), panel `admin-card … bg-[color:var(--main)] p-6` (`:96-99`), `z-[9999]`. The file's own comment (`:82-84`) explicitly notes it is "Not the shared `Dialog`."
  - `AddonCancellationDialog` (inline in `UoaBillingRecurringAddonsPanel.tsx:167-240`, add-on cancellation): composes **no** a11y hook at all (no `useModalA11y`, no `useOverlayDismiss`, no focus trap, no Escape-to-close), raw `bg-black/40` scrim (`:185`, the raw-color defect from §11), `z-50` (vs. the sibling's `z-[9999]`), panel is plain `admin-card w-full max-w-lg p-5` with no `backdrop-blur`.
  - Both dialogs implement the identical two-phase preview→confirm content shape (title/message, a details box, error line, a `Keep/Cancel` button pair) but from scratch, independently, in different files, with materially different accessibility guarantees (one has focus trap + Escape, the other has neither).
- Form-in-dialog: the only real form control inside either dialog is `UoaBillingCancellationDialog.tsx:137-144`'s radio-fieldset (choice selection) — footer is `flex justify-end gap-2` in both dialogs, consistent with each other and with the rest of the app's button-footer convention.

**Verdict: many-variants**, and the worst-offender case in this whole slice: `AddonCancellationDialog` is a hand-rolled modal with zero accessibility affordances sitting right next to a sibling (`UoaBillingCancellationDialog`) that got it right, plus two silent, un-confirmed destructive deletes in `BudgetManager`/`PricingManager`.

---

## Good model / worst offender

- **Good model**: `UoaBillingCancellationDialog.tsx` — correctly composes `useModalA11y`/`useOverlayDismiss` (the exact hooks the shared `Dialog` uses), uses the theme scrim token, and its own code comments already document *why* it isn't the shared `Dialog` (a real, stated tradeoff, not an oversight). If a modal must stay bespoke in this app, this is the file that shows how to do it responsibly.
- **Worst offender**: `AddonCancellationDialog` (inline in `UoaBillingRecurringAddonsPanel.tsx:167-240`) — a fully custom modal with no focus trap, no Escape handling, no overlay-dismiss gesture, and a raw `bg-black/40` scrim, sitting in the same directory as a sibling dialog that solved all four problems. Close second: `BudgetManager.tsx`/`PricingManager.tsx`'s un-confirmed Delete buttons (destructive, zero-friction, no dialog of any kind).

## Top 5 unification wins for this slice

1. **Stat tile, 4 implementations → 1 `StatTile` primitive.** `Stat` (`OpsHealthPage.tsx:40`), `CreditCard` (`UoaBillingCreditsPanel.tsx:23`), `SummaryCard` (`UoaBillingStatementPanel.tsx:24`), and 9 un-extracted inline copies in `OperationalTelemetryPage.tsx` (199-224, 294-323, 367-378) all render "label / big value / small detail" with three different font sizes and two different container radii for the same role.
2. **Border-only chip, 7 sites → extend `Pill` with a border/outline tone.** Every occurrence in `billing/*` is already commented "Unconverted" pointing at exactly this gap in `Pill.tsx`'s own doc comment — the fix is scoped, just not done.
3. **Warning/error banner, 5+ hand-rolled sites → `Notice`.** `OperationalTelemetryPage.tsx:190-196` (whose `admin-card`+override combo is flagged in-code as not even rendering correctly), `UoaBillingCreditsPanel.tsx:391-395`, `UoaBillingRecurringAddonsPanel.tsx:48-52`, `UoaBillingStatementPanel.tsx:132-136` all reimplement `Notice tone="warning"` byte-for-byte, plus `OpsHealthPage.tsx:104-108`'s separate danger-tone error box.
4. **List row (title + meta line, value + detail right-aligned), 11 sites → one `SummaryRow`/list-row primitive**, replacing the repeated `flex items-center justify-between` block across `OpsHealthPage.tsx`, `OperationalTelemetryPage.tsx` (×4), `BudgetManager.tsx`, `PricingManager.tsx`, and `UoaBillingStatementDetails.tsx` (×3).
5. **Destructive-delete + confirm-dialog consistency**: wire `BudgetManager.tsx:398-405` and `PricingManager.tsx:216-224`'s unconfirmed deletes through `ConfirmDialog`, and rebuild `AddonCancellationDialog` on the shared `Dialog` shell (or at minimum give it `useModalA11y`/`useOverlayDismiss` and the token scrim) so it matches its sibling `UoaBillingCancellationDialog`.

Runner-up: form-level error line duplicated verbatim in `BudgetManager.tsx:354`/`PricingManager.tsx:188` (and syntactically drifted from the billing files' `text-[color:var(--danger-text)]` variant) — small, but a one-line shared component would fix both the duplication and the syntax drift at once.
