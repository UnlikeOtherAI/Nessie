# Automation slice audit — Triggers, Workflows, Workflow Designer (panels), Tools, Executors

Slice owner files (all paths relative to `admin/src`):

- `pages/TriggersPage.tsx`, `pages/triggers/useTriggersPageState.ts` (hook, no JSX)
- `components/features/triggers/*` (11 files)
- `pages/WorkflowsPage.tsx`
- `components/features/workflows/*` (7 files)
- `pages/WorkflowDesignerPage.tsx`, `pages/workflow-designer/*.ts` (4 hooks, no JSX)
- `components/features/workflow-designer/WorkflowNodeInspector.tsx`, `WorkflowSamplePicker.tsx` (in-scope; Canvas/CanvasNode/Header/Toolbar excluded per brief)
- `pages/ToolsPage.tsx`
- `components/features/workflow-tools/*` (7 files)
- `pages/ExecutorsPage.tsx`
- `components/features/executors/*` (5 files)
- `components/shared/ToolBadge.tsx`, `ToolPermissionPill.tsx`, `ToolTransportPill.tsx`, `ToolCategoryIcon.tsx`

---

## 1. Body containers & sections

Every page in this slice runs inside `ColumnBrowserColumn`/`ColumnBrowserViewport` (out of scope) **except** `ExecutorsPage.tsx`, which is a bare scrolling page: `pages/ExecutorsPage.tsx:209-210` — `<div className="h-full overflow-y-auto"><div className="mx-auto grid max-w-7xl gap-5 px-6 py-6">`. It self-documents why (`ExecutorsPage.tsx:211-221` comment: `AdminPageHeader` "cannot express this 24px font-semibold hero, its 0.18em eyebrow, or the paragraph beneath it") and hand-rolls its own header instead — a page-level container pattern nothing else in the slice uses.

Inside columns, detail bodies consistently use `<div className="grid max-w-3xl gap-5">` as the outer wrapper: `TriggerDetail.tsx:172`, `WorkflowTemplateDetail.tsx:60`, `WorkflowInstallationDetail.tsx:92`, `WorkflowRunDetail.tsx:73`. This is a real, unlabelled repeated pattern (four independent copies of the same wrapper string) — a good candidate for a `DetailPane` primitive.

Section headings inside bodies use `SectionLabel` consistently in the workflow/trigger detail files (`TriggerDetail.tsx:305,324`, `WorkflowTemplateDetail.tsx:110,140`, `WorkflowInstallationDetail.tsx:137,189`, `WorkflowRunDetail.tsx:129`). But three other places hand-roll their own eyebrow instead of `SectionLabel`:
- `ExecutorsPage.tsx:227` — `text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--tx3)]` (comment at line 226 explains: `SectionLabel` only offers `0.2em`/`0.18em` at `xs`/`2xs`, and this needs `0.18em` at `text-xs`, a combination `SectionLabel` doesn't expose).
- `ExecutorDetailPanels.tsx:151,191,216` — `text-xs font-semibold uppercase tracking-wide text-[color:var(--tx3)]` (uses Tailwind's `tracking-wide`, a third tracking value distinct from both `SectionLabel` sizes and the trigger/tool `fieldLabelClass`).
- Card sub-headings elsewhere just use `<h2 className="text-sm font-semibold text-[color:var(--tx)]">` (`ToolReviewActions.tsx:34`, `ExecutorCreatePanel.tsx:89`, `ExecutorDesktopCompanionPanel.tsx:81`, `ExecutorWorkspacePromotionsPanel.tsx:28`, `ExecutorDetailPanels.tsx:119`) — sentence case, not uppercase, a different heading register than `SectionLabel`.

Card/section framing is a three-way split:
- Dashed-empty-state-adjacent sections and list wrappers use raw `rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)] p-…` (triggers/workflows files, see §2/§7).
- Executors uses `.admin-card` throughout (`ExecutorsPage.tsx:256,266,288,321,332,336`, `ExecutorCreatePanel.tsx:87`, `ExecutorDesktopCompanionPanel.tsx:79`, `ExecutorDetailPanels.tsx:116`, `ExecutorWorkspacePromotionsPanel.tsx:26`), sometimes with an extra `border-[color:var(--accent)]` override layered on for "needs attention" panels (`ExecutorsPage.tsx:256,266,288`) — since `.admin-card` is unlayered CSS (per styles.css:1955-1958) this override *does* work, but it is a second visual state (accent-bordered highlight card) with no name/primitive of its own, hand-copied three times.
- Workflow designer inspector cards use yet a third, hard-coded style: `rounded-lg border border-black/10 bg-white …` (see §11).

Max-width: `max-w-3xl` for every detail pane (see above); `ExecutorsPage.tsx:210` uses `max-w-7xl` for the whole page (a full admin page, not a column body — reasonable given it isn't in the column browser, but nothing else in the slice sets a page-level max-width to compare against).

**Verdict: many-variants.** Missing primitive: a `DetailPane`/`DetailSection` wrapper (`max-w-3xl grid gap-5` + `SectionLabel`-headed subsections) would resolve the trigger/workflow repetition; a distinct "highlighted card" variant of `.admin-card` (or a `tone` prop) would resolve the `border-[color:var(--accent)]` copies in `ExecutorsPage.tsx`.

---

## 2. Tables & data lists

No `<table>` element and no `ExpandableTable` anywhere in this slice — every list is a div-based "card list": a `divide-y divide-[color:var(--sep)] overflow-hidden rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)]` container of row buttons/divs. This exact string (or a `mt-3` prefixed variant) repeats at:
- `TriggerListColumn.tsx:181`
- `TriggerDetail.tsx:284 (dl, see §9), 330`
- `WorkflowsPage.tsx:220, 342`
- `WorkflowTemplateDetail.tsx:116, 150`
- `WorkflowInstallationDetail.tsx:128 (dl), 152, 197`
- `WorkflowRunDetail.tsx:135`
- `DemonstrationDraftsColumn.tsx:32`
- `ToolList.tsx:45`
- `ToolAgentAccessPanel.tsx:147`
- `ExplicitToolAgentAccessPanel.tsx:131`

This is a strong, consistent convention (11+ independent hand-copies of one string) but it is nowhere a shared component — every file re-spells `divide-y divide-[color:var(--sep)] overflow-hidden rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)]`.

Row style within that container has **two variants**:
1. **Selectable/active border-left rows** (list-of-entities-you-drill-into): `border-l-2` + `border-[color:var(--accent)] bg-[var(--accent-soft)]` when selected, `border-transparent hover:bg-[var(--overlay-weak)]` otherwise. Used in `TriggerListColumn.tsx:69-74`, `WorkflowsPage.tsx:350-355`, `WorkflowTemplateDetail.tsx:153-158`, `WorkflowInstallationDetail.tsx:202-207`, `ToolList.tsx:50-55`. Five independent copies of the identical three-line class array.
2. **Plain rows** (non-selectable facts/history): flat `px-3 py-2.5` div with no left border, e.g. `TriggerDetail.tsx:332` (delivery history), `WorkflowInstallationDetail.tsx:155` (trigger links, a `<Link>` not a button), `DemonstrationDraftsColumn.tsx:34`, `WorkflowTemplateDetail.tsx:118` (step rows).

`ExecutorsPage.tsx:329` breaks from **both**: the executor picker list is `rounded-md p-2 text-left text-xs` per-row with `bg-[color:var(--accent-soft)]`/`hover:bg-[color:var(--overlay-weak)]` selection — no `divide-y` container, no `border-l-2`, a different radius (`rounded-md` vs the containers' `rounded-xl`), and the whole list is written on one physical line (see §11 readability note). This is the slice's third row treatment for the same "select one row from a list" job.

Row density is uniform at `px-3 py-2.5` (occasionally `py-3` for `DemonstrationDraftsColumn.tsx:34`). No sorting, zebra, sticky header, or numeric-column alignment appears anywhere in this slice (nothing here is genuinely tabular).

Actions-in-row: checkboxes for batch review appear inline in `ToolList.tsx:58-67` (`h-4 w-4 accent-[var(--accent)]`, a raw checkbox, not `Switch` — correctly so, since it's multi-select not a toggle). Per-row action buttons appear in `WorkflowRunDetail.tsx:166-210` (Skip/Block/Unblock) using a locally-defined `stepActionButton` constant (line 50-51) rather than any shared row-action pattern.

**Verdict: many-variants** (one strong div-list convention, but never shared; three distinct row-selection treatments). Missing primitive: a `RowList`/`SelectableRow` pair covering the `divide-y` container + border-l-2 row shape used 5+ times, and folding `ExecutorsPage.tsx:329`'s one-off into it.

---

## 3. Pagination & loading more

**n/a in this slice.** No list here paginates — every list (triggers, workflow templates, tools, executors, agent-access rows) renders its full result set with no `PaginationFooter`, no "Load more", no cursor. `WorkflowInstallationDetail.tsx` and `WorkflowRunDetail.tsx` show run/step history in full with no cap either. Worth flagging to the synthesizer only if any of these lists are expected to grow unbounded (delivery history, tool registry) — none currently guards against that.

---

## 4. Forms

Field layout is `label` (or `div`, when read-only) above control, wrapped in `grid gap-1.5` (triggers) or `grid gap-1` (executors) — consistently "label above input," never inline. But the **label class itself has at least four distinct spellings** in this slice:

1. `fieldLabelClass` in `trigger-config.ts:365-366` — `text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]`. Reused correctly across all 5 trigger field files + `TriggerMetaFields.tsx`.
2. `fieldLabelClass` in `WorkflowNodeInspector.tsx:47-48` — `text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--tx3)]` — same name, same idea, **different size (11px vs 12px/text-xs) and different tracking (0.14em vs 0.16em)** from the trigger one. Two same-named constants in the same slice with different values.
3. Executors: `label className="grid gap-1 text-xs font-medium text-[color:var(--tx2)]"` (`ExecutorCreatePanel.tsx:95,104,114`, `ExecutorRunLauncherDialog.tsx:226,240,278` uses `<span className="font-semibold text-[var(--tx2)]">` inside). Not uppercase, not tracked, `font-medium`/`font-semibold` (mixed) on `--tx2` rather than `--tx3` — a completely different register (looks like body text, not a form label) from (1)/(2).
4. `TriggerEditorDialog.tsx:357` reuses `fieldLabelClass` from `trigger-config.ts` for its Description field, so the editor dialog is internally consistent even though the app-wide label style is not.

Controls: `admin-input` is used everywhere text/select/textarea appears (good) — including density variants `admin-input-compact` (`WebhookTriggerFields.tsx`, `EventTriggerFields.tsx`, `ToolFilterBar.tsx`) and `admin-input-mono` (`WebhookTriggerFields.tsx`, `EventTriggerFields.tsx`). The one exception is `WorkflowNodeInspector.tsx:50-51`/`WorkflowSamplePicker.tsx` which define an entirely separate `inspectorInputClass` hard-coded to `bg-white`/`border-black/10`/`text-[#433349]` instead of `admin-input` (see §11 — this also breaks theming).

Checkbox vs `Switch`: `Switch` is used correctly for on/off grants (`TriggerEditorDialog.tsx:380` "Enabled", `ToolAgentAccessPanel.tsx:98`, `ExplicitToolAgentAccessPanel.tsx:98`). Raw `<input type="checkbox">` is used for multi-select (`ToolList.tsx:60-66`, `ExecutorCreatePanel.tsx:154-158` agent picker, `ExecutorDesktopCompanionPanel.tsx:125` operation toggles) — a defensible distinction (select-many vs toggle-one), but none of the raw checkboxes carry the `accent-[var(--accent)]` styling that `ToolList.tsx:63` uses, so their checked-state colour is browser-default rather than themed (`ExecutorCreatePanel.tsx:154`, `ExecutorDesktopCompanionPanel.tsx:125`).

Form action row placement: bottom, `flex justify-end`/`justify-between`, consistently right-aligned primary action — `TriggerEditorDialog.tsx:378-412`, `ExecutorRunLauncherDialog.tsx:294-299`. `ExecutorCreatePanel.tsx:166` and `ExecutorDetailPanels.tsx:260,299` instead left-align a single submit button with `justify-self-start` (no Cancel button at all — these are inline forms inside an already-open panel, not dialogs, so the asymmetry is a reasonable structural difference, but it means "submit button placement" has two answers depending on whether the form is in a dialog or inline).

Disabled/pending state: uniformly `disabled={mutation.isPending}` plus a "…ing…" label swap (`Saving…`, `Creating…`, `Applying…`) — consistent across the whole slice.

**Verdict: many-variants** for label styling specifically (4 distinct class strings for "this is a form field label"); **consistent** for control choice and pending-state handling. Missing/needed: a single shared `FieldLabel` component or exported `fieldLabelClass` token (currently redefined per-file with drifting values) would resolve the label duplication described here and in the trigger/workflow-designer files.

---

## 5. Validation & field errors

`FormFieldError`'s helpers (`fieldErrorAria`, `renderFieldError`, `role="alert"` contract) are used **nowhere** in this slice. Instead there are three ad-hoc error idioms:

1. **Boxed, `Notice`-based** (best of the three): `TriggerEditorDialog.tsx:374-376` — `<Notice padding="lg" radius="xl" tone="danger">{formError}</Notice>`; `TriggerDetail.tsx:276-280`, `WorkflowRunDetail.tsx:117-121`, `WorkflowImportButton.tsx:74-78` all use `Notice`.
2. **Bare red line with `role="alert"`** (accessible but unboxed, and not going through `FormFieldError`'s `fieldErrorProps`): `ToolAgentAccessPanel.tsx:88-92` — `<div className="mt-1 text-[11px] text-[var(--danger-text)]" role="alert">`; `ExplicitToolAgentAccessPanel.tsx:82-89`; `ExecutorRunLauncherDialog.tsx:258,291`.
3. **Bare red line with no `role` at all** (not announced to screen readers): `ExecutorsPage.tsx:272,279,298,303,326`, `ExecutorCreatePanel.tsx:165`, `ExecutorDesktopCompanionPanel.tsx:145`, `ExecutorDetailPanels.tsx:136`, `ExecutorWorkspacePromotionsPanel.tsx:35`, `WorkflowNodeInspector.tsx:358,408` (all `text-xs text-[color:var(--danger-text)]` / `text-[var(--danger)]` — see §11 on that token mismatch — with no `role="alert"`).

So within one slice, the *same class of error* (an async mutation failing) is rendered three different ways with two different accessibility outcomes, entirely along a triggers/workflow-tools (uses `Notice`/`role="alert"`) vs executors (bare, no role) fault line.

Errors appear on submit/mutation-failure everywhere (no per-keystroke validation found), which matches `FormFieldError`'s documented contract — the mismatch is purely in *not adopting* the shared helper, not in the announcement timing being wrong.

**Verdict: many-variants.** All of the executor error lines in §5/§6 are straightforward candidates to become `Notice tone="danger"` (form-level) or `renderFieldError`/`fieldErrorProps` (field-level) call sites.

---

## 6. Feedback after actions

Success feedback: `TriggerDetail.tsx:271-275` — `<Notice tone="success">Trigger fired — the run appears under recent deliveries below.</Notice>`, transient only in the sense that `fireTrigger.isSuccess` clears on the next mutation; no toast system appears anywhere in this slice, only inline/persistent-until-dismissed-by-context banners.

Failure feedback splits along the same fault line as §5: `Notice tone="danger"` in triggers/workflows (`TriggerDetail.tsx:276-280`, `WorkflowRunDetail.tsx:117-121`, `WorkflowImportButton.tsx:74-78`, `ToolReviewActions.tsx:62-66`, `ToolReviewBar.tsx:80-84`) vs bare `<p className="text-xs text-[color:var(--danger-text)]">` in every executor file (7+ occurrences, see §5 citation list) and in `WorkflowNodeInspector.tsx:358,408`.

Placement: banner sits directly below the action that triggered it in every case (inside the same card/section), never a separate toast region — this part is consistent.

**Verdict: two-variants**, split cleanly by directory (`triggers`/`workflows`/`workflow-tools` use `Notice`; `executors` and `workflow-designer` never do). `Notice tone="danger"`/`tone="success"` is already the right shared primitive; the executors files and `WorkflowNodeInspector`/`WorkflowSamplePicker` simply don't use it.

---

## 7. Loading / error / empty states

`QueryState` is used correctly and only in `ToolsPage.tsx:169-184` (tool list) and `ToolsPage.tsx:241-260` (agent-access panel, with a documented `className="py-6"` override at line 238-240 to match the panels' own empty-state size). This is the one file in the slice that follows the shared triad end-to-end, including Retry.

Every other file hand-rolls its own version, and the copies genuinely differ from `QueryState` and from each other:

- **No loading/error state at all**, only an empty-when-filtered message: `TriggerListColumn.tsx:174-179`, `WorkflowsPage.tsx:335-340` (workflow template list) — if the initial fetch is still loading or has failed, both render "No triggers yet…" / "No workflows yet…", which is a **false empty state**, exactly the failure mode `QueryState`'s docstring calls out ("a failed fetch rendered as an empty list").
- **Single hand-rolled "Loading X…" text, no error branch**: `WorkflowRunDetail.tsx:61-67` — `if (isLoading || !data) return <div className="py-10 text-center text-sm text-[color:var(--tx3)]">Loading run…</div>` — a network error here renders identically to "still loading" forever (`data` never arrives, `isLoading` goes false — actually this would fall through to a crash on `data.run`, since there's no `isError` check at all).
- **Three separate always-rendered `<p>` lines above the list** (not swapped-in in place of it): `ExecutorsPage.tsx:323-327`, self-documented at lines 323-324: *"Not QueryState: left-aligned p-2 notes rendered above the list rather than in place of it, and the error offers no Retry."* This is the clearest self-aware deviation in the slice.
- **Loading/error/empty as three `<p>` conditionals, still no Retry**: `ExecutorWorkspacePromotionsPanel.tsx:34-36`.

Dashed empty-state cards (the "nothing here yet" case, as opposed to loading/error) also don't use `EmptyState`. `EmptyState`'s shipped shape is `rounded-xl border border-dashed border-[color:var(--sep)] bg-[color:var(--overlay-weak)] p-5 text-sm leading-6 text-[color:var(--tx3)]` (`EmptyState.tsx:8-12`). The slice instead repeats a **near-miss** of that string with no background and different padding — `rounded-xl border border-dashed border-[color:var(--sep)] px-3 py-6 text-center text-sm text-[color:var(--tx3)]` — at `WorkflowTemplateDetail.tsx:112,146`, `WorkflowInstallationDetail.tsx:147,193`, `WorkflowRunDetail.tsx:131`: five copies, all missing `bg-[color:var(--overlay-weak)]` and `leading-6`, all adding `text-center` and `px-3 py-6` that `EmptyState` doesn't have. `WorkflowSamplePicker.tsx:103` and `WorkflowNodeInspector.tsx:415` use a third variant with `var(--line)`/`var(--muted)` tokens instead of `--sep`/`--tx3` (the workflow-designer's separate palette, see §11).

Flat `py-10 text-center text-sm text-[color:var(--tx3)]` (no border/card at all) is a fourth empty-state shape, for filtered-to-nothing lists: `TriggerListColumn.tsx:175`, `WorkflowsPage.tsx:216,336`, `DemonstrationDraftsColumn.tsx:28`, `ToolList.tsx:38`.

**Verdict: many-variants.** `QueryState` and `EmptyState` both exist and both work (proven by `ToolsPage.tsx`); every other file in the slice reinvents one or both, and two of those reinventions (`TriggerListColumn`, `WorkflowsPage` template list) are outright bugs (fetch failure reads as "no items").

---

## 8. Status chips & badges

`Pill` is used for genuine status (trigger status, workflow run/step/installation status, delivery pill, tool grant "denied", PA badge) consistently and correctly: `TriggerDetail.tsx:207,347`, `TriggerListColumn.tsx` (dot, not Pill — see below), `WorkflowsPage.tsx:237,302,313,364-365`, `WorkflowTemplateDetail.tsx:68,173`, `WorkflowInstallationDetail.tsx:100`, `WorkflowRunDetail.tsx:81`, `DemonstrationDraftsColumn.tsx:39`, `ToolAgentAccessPanel.tsx:95`, `ExplicitToolAgentAccessPanel.tsx:79`.

Alongside `Pill`, three shared-but-not-`Pill` chip components exist specifically for tools (`ToolBadge`, `ToolTransportPill`, `ToolCategoryIcon`), each with a code comment explaining why it isn't `Pill`:
- `ToolBadge.tsx:17-20` — "Unconverted: Pill has one accent tone (--thinking); this ramp needs two accent-family foregrounds."
- `ToolTransportPill.tsx:23-24` — "Unconverted: this chip's fill is --scrim, a darkening wash; Pill's muted tone paints --overlay-weak, a lightening one."
- `ToolCategoryIcon.tsx:23-29` defines a **third, independent copy** of the exact same `SOURCE_TONE`/`SOURCE_STYLES` colour ramp already in `ToolBadge.tsx:21-29` (identical `bg-[color:var(--accent-soft)] text-[color:var(--accent)]` etc., keyed by the same `ToolRegistrySource` union) — two files hand-maintain the same lookup table. Note: `ToolCategoryIcon` is not actually used anywhere inside this slice (only by `AppCapabilityList.tsx` outside it), so `ToolList.tsx` renders `ToolBadge` alone for source, with no icon.
- `ExecutorDetailPanels.tsx:122-125` hand-rolls yet another one-off chip for executor status — `rounded-full border border-[color:var(--sep)] px-2 py-1 text-xs text-[color:var(--tx2)]` — with its own comment: *"Unconverted: border-only chip; Pill bordered+muted adds an --overlay-weak fill."* This one has no tone mapping at all (just echoes `executor.status` verbatim in neutral colour), unlike every trigger/workflow status pill which maps status→tone.

Status-as-**dot** (not pill) is a separate, parallel idiom used for list-row density: `getTriggerStatusColor` (`trigger-presentation.ts:79-90`) drives `TriggerListColumn.tsx:91-97` and `WorkflowInstallationDetail.tsx:176-180`; `DELIVERY_DOT` (`TriggerDetail.tsx:75-80`) drives the delivery-history dot; `getRunStatusColor`/`getStepStatusColor` (`workflows/presentation.tsx:45-77`) drive `WorkflowInstallationDetail.tsx:212-216` and `WorkflowRunDetail.tsx:147-151`. Each of these is its own `Record<Status, string>` returning a raw CSS colour string consumed via inline `style={{ background: … }}` — four independent status→colour maps that all reimplement the same idea `Pill`'s `toneClasses` already encodes.

Compounding that: `workflows/presentation.tsx` maintains **three separate status-colour mappings for the same statuses** — `getRunStatusColor`/`getStepStatusColor` (dot, lines 45-77), `getRunTone` (Pill tone, lines 134-149), and `runStatusClass`/`stepStatusClass` (text-colour class, lines 151-187) — the last of which (`runStatusClass`/`stepStatusClass`) is exported but **never imported or used anywhere in the slice** (grep confirms no call sites), i.e. dead code maintaining a third colour mapping nothing reads.

**Verdict: many-variants.** `Pill` is the right shared primitive and mostly used well for full-word status pills; the compact "dot" idiom for list rows has no shared primitive at all (four hand-rolled `Record<Status,string>` maps + inline `style`), and `workflows/presentation.tsx` carries a dead third mapping that should be deleted regardless of any unification.

---

## 9. Detail / key-value views

At least **four distinct shapes** render "a set of named facts about one record" in this slice:

1. **`FactRow` + `<dl>`, flex row, right-aligned value** — independently defined (byte-identical) in two files: `TriggerDetail.tsx:82-87` and `WorkflowInstallationDetail.tsx:46-51`:
   ```
   <div className="flex items-baseline justify-between gap-4 px-3 py-2.5">
     <dt className="flex-shrink-0 text-xs text-[color:var(--tx3)]">{label}</dt>
     <dd className="min-w-0 text-right text-sm text-[var(--tx)]">{value}</dd>
   </div>
   ```
   Wrapped in the same `<dl className="divide-y divide-[color:var(--sep)] rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)]">` in both files (`TriggerDetail.tsx:284`, `WorkflowInstallationDetail.tsx:128`). Two files, one un-shared component.

2. **2-column CSS grid, `dt`/`dd` stacked cells, no dividers, no border** (embedded inside an already-bordered card): `ToolDetailDrawer.tsx:55-70` — `<dl className="mt-3 grid grid-cols-2 gap-y-1 text-xs">` with `dd` left-aligned (not right-aligned like #1).

3. **Inline sentence, `<p><span className="font-medium">Label:</span> value</p>`** — no `dl`/`dt`/`dd` at all, prose-style: `ExecutorDetailPanels.tsx:139-148` (Overview tab: Profiles, Data boundary, Browser origin ceiling, Last seen, etc. — six facts rendered this way), and reused for the Access tab summary at `ExecutorDetailPanels.tsx:212`.

4. **`CopyField`** (a value-plus-copy-button row, `TriggerDetail.tsx:43-73`) — a fifth, distinct micro-pattern for one specific kind of fact (a copyable secret/URL), duplicated conceptually by the plain disabled-input rows in `WebhookTriggerFields.tsx:17-68` (which show similar values but with no copy button, using `admin-input disabled` instead).

None of these four/five shapes share a component, despite all four solving "list some labelled facts about the thing on screen."

**Verdict: many-variants.** Missing primitive: a `DefinitionList`/`FactRow` component (promoting the two duplicate `FactRow`s) would immediately fix pattern #1's duplication; #2 and #3 are different enough (denser grid vs. prose) that they may be deliberate, but should at minimum share a naming convention with #1 so the synthesizer can decide.

---

## 10. In-content filters, search boxes & toolbars

Search input is uniform: `<input type="search" className="admin-input" placeholder="Search …">` — `TriggerListColumn.tsx:137-144`, `WorkflowsPage.tsx:319-326`, `ToolsPage.tsx:190-197`. All three sit at the top of their list column, above any filter controls.

Filter rows follow one shared idiom of "primary dimension → `TabBar` segmented strip; secondary dimensions → quiet `<select className="admin-input admin-input-compact">`" — used identically in `TriggerListColumn.tsx:146-172` (status via TabBar, type via select) and `ToolFilterBar.tsx:50-93` (source via TabBar, status/tag via selects). This is a genuinely consistent, well-factored convention (both components even say so in their doc-comments).

Count summaries: `Tools (${sortedTools.length})` / `Triggers` / `Workflows (${sortedTemplates.length})` appear as **column titles** (out of scope — `ColumnBrowserColumn`'s `title` prop), but in-body counts also appear as plain text next to section labels — `WorkflowTemplateDetail.tsx:141-143` (`{installations.length} total`), `WorkflowInstallationDetail.tsx:190` (`{sortedRuns.length} total`), `ToolAgentAccessPanel.tsx:144-146` / `ExplicitToolAgentAccessPanel.tsx:128-130` (`{grantedCount} of {agents.length} agents granted`) — three independent phrasings ("N total" vs "N of M granted") for the same "how many of these are there" job, each hand-written.

`ExecutorsPage.tsx` has no search box at all for its executor list (only a plain unfiltered picker at line 328-330) and no `TabBar`-based filter — the one page in the slice with a list and zero filtering affordance.

**Verdict: consistent** for search input + TabBar/select filter split (triggers, tools); **n/a/missing** in executors and workflows-template-list (no filters beyond search); the "count summary" phrasing is a **many-variants** micro-pattern worth folding into one helper if the synthesizer builds a list-header primitive.

---

## 11. Typography & spacing inside content

Body text tokens are used correctly and consistently through most of the slice: `--tx` (primary), `--tx2` (secondary/prose), `--tx3` (meta/muted) — this three-tier system is respected almost everywhere.

**Raw colours / Tailwind named colours (defects per CLAUDE.md), with exact lines:**

- `ExecutorsPage.tsx:33-39` (`statusClass`):
  ```
  const statusClass = (status: string): string => status === 'online'
    ? 'text-emerald-600'
    : status === 'pending_pairing' || status === 'draining'
      ? 'text-amber-600'
      : status === 'revoked' || status === 'error'
        ? 'text-[color:var(--danger-text)]'
        : 'text-[color:var(--tx3)]'
  ```
  Two of four branches are hard-coded Tailwind named colours (`emerald-600`, `amber-600`) that do not react to theme switching, mixed in the same function with two branches that correctly use tokens.

- `ExecutorWorkspacePromotionsPanel.tsx:39` — `border-[color:var(--border)]`. **`--border` is not defined anywhere in `styles.css`** (only `--sep` and `--border-strong` exist); this is a broken token reference, not merely an inconsistent one — the review-draft `<article>` border silently falls back to the browser default rather than any themed colour.

- `DemonstrationDraftsColumn.tsx:68` — `text-[color:var(--danger)]` for an inline error message. Every other error line in the slice uses `--danger-text` (the token tuned as a *foreground* colour per theme; `--danger` is the *fill* token, tuned for backgrounds — see `styles.css:55-171`). Using `--danger` for text is a token-role mismatch, not just a different token.

- `WorkflowNodeInspector.tsx` — a whole parallel, hard-coded palette that never reacts to theme, mixed with theme-aware tokens **in the same component**:
  - `:50-51` `inspectorInputClass = 'w-full rounded-lg border border-black/10 bg-white px-2.5 py-1.5 text-sm text-[#433349] outline-none focus:border-[#7445c7]'`
  - `:53-54` `warningClass = 'rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs text-amber-800'`
  - `:352,370,379` repeat `border-black/10 bg-white` / `bg-[#faf7fc]` / `text-[#433349]` for the "last test run" and "use earlier step output" cards
  - `:358,408` `text-[var(--danger)]` (same role-mismatch as above)
  - contrast: the *same file*'s empty state at `:415` correctly uses `border-dashed border-[var(--line)] … text-[var(--muted)]` — theme-aware tokens sitting one screen away from hard-coded hex.

- `WorkflowSamplePicker.tsx` — same hard-coded family, plus Tailwind named colours for the JMESPath preview result:
  - `:22` `monoChipClass` — `border-black/10 bg-[#faf7fc] … text-[#433349]`
  - `:39,51-52,111,115,127` more `black/10` / `bg-white` / `text-[#433349]` / `bg-[#f4eff8]`
  - `:139` `border-emerald-200 bg-emerald-50 … text-emerald-900` (success preview)
  - `:143` `border-red-200 bg-red-50 … text-red-800` (error preview) — this is exactly the job `Notice tone="success"`/`tone="danger"` already does with theme tokens, reimplemented with Tailwind's fixed emerald/red ramp instead.

Tracking scale for uppercase labels: `0.14em` (`WorkflowNodeInspector.tsx:48`), `0.16em` (`trigger-config.ts:366`, `ToolDetailDrawer.tsx:17-19`), `0.18em` (`ToolBadge.tsx:40`, `ToolTransportPill.tsx:30`, `ExecutorsPage.tsx:227`), `tracking-wide` i.e. Tailwind's `0.025em` (`ExecutorDetailPanels.tsx:151,191,216`), and `SectionLabel`'s own `0.18em`/`0.2em` — five different tracking values doing the same "shouted small label" job across the slice.

Padding scale: `p-3`/`p-4` dominate card bodies; row density is `px-3 py-2.5` almost everywhere (see §2); executors mixes in `p-2` (`ExecutorsPage.tsx:329`) and `p-4`/`p-5`/`p-6` inconsistently across its own file. Border radius: `rounded-xl` for cards/containers (the dominant scale), `rounded-lg` for the workflow-designer's inputs/warnings, `rounded-md` for smaller inline elements (code chips, executor list rows) — roughly consistent as a *scale* (xl > lg > md, largest-to-smallest matching container-to-chip), no defects there beyond the hard-coded-colour cards already cited.

**Verdict: many-variants**, and this category carries the slice's clearest CLAUDE.md violations (raw hex + Tailwind named colours) concentrated entirely in `ExecutorsPage.tsx`, `WorkflowNodeInspector.tsx`, `WorkflowSamplePicker.tsx`, `ExecutorWorkspacePromotionsPanel.tsx`, and `DemonstrationDraftsColumn.tsx`.

---

## 12. Destructive & confirm flows with forms in dialogs

`ConfirmDialog`/`Dialog` are used **nowhere** in this slice. Instead:

- **`TriggerEditorDialog.tsx:259-315`** hand-rolls a full dialog shell (scrim, panel, header, SVG close button) and says exactly why in a comment at lines 260-262: *"Not the shared `Dialog`: its subtitle is `mt-1 text-sm` where the shell renders a description at `text-xs`, and its panel is 680px wide, which is not one of the three geometries the shell ships."* The close-button SVG (`TriggerEditorDialog.tsx:301-313`) is a byte-for-byte copy of `Dialog.tsx:159-168`'s icon markup, just inlined instead of reused.

- **`ExecutorRunLauncherDialog.tsx:188-303`** hand-rolls a *second*, differently-built dialog shell: raw `onMouseDown` scrim-dismiss (`:191-193`) instead of `useOverlayDismiss` — the exact "drag released outside the panel discarded an in-progress edit" bug `Dialog.tsx`'s own comment (`:18-19`) says `useOverlayDismiss` was written to fix — plus a plain `×` glyph close button (`:221`) instead of the SVG cross every other dialog in the app uses. It does correctly call `useModalA11y` (`:117`) for focus trap/Escape, so it's more accessible than a bare `<div>` but still a third, independent dialog implementation.

- **Delete confirmation is inline, not a dialog, and unique to `TriggerDetail.tsx:366-385`**: a single button that turns into "Confirm delete" on first click (two-click pattern, `confirmingDelete` state), no `ConfirmDialog`, no modal at all. This is a real functional gap versus `ConfirmDialog`'s documented purpose (four `window.confirm` replacements elsewhere in the app) — nothing here reviewed uses `ConfirmDialog`, and the two-click affordance has no "what will this destroy" copy beyond the button label itself.

- **Executor "review and confirm" panels** (`ExecutorsPage.tsx:265-309`, prepared access/workspace-promotion changes) are the slice's closest thing to a destructive-confirm-with-form flow, but they render as **inline `.admin-card` sections directly in the page body**, not a dialog — two near-duplicate ~25-line blocks (review-change, review-promotion) that each hand-build a password-confirmation field (`<input type="password">`, `ExecutorsPage.tsx:276,301`) and a Confirm/Reject button pair, with no shared component between the two despite being structurally identical.

No form-in-`Dialog` pattern exists anywhere in this slice to compare against `Dialog`'s intended usage — every place that needs a modal-shaped destructive/config flow (trigger create/edit, executor run launch, access-change review) either invents its own shell or skips the dialog entirely.

**Verdict: many-variants** (three independent dialog-shell implementations, one avoiding dialogs altogether for a destructive action). Missing: none of `Dialog`'s `size` presets (`md`/`lg`/`xl`/`full`) fit `TriggerEditorDialog`'s 680px panel — the synthesizer should decide whether to add a size token or accept the divergence — but `ExecutorRunLauncherDialog` has no stated reason not to use `Dialog` `size="lg"` (640px, close enough to its `max-w-2xl`≈672px) plus `ConfirmDialog` for `TriggerDetail`'s delete action.

---

## Good models / worst offenders

- **Good model:** `pages/ToolsPage.tsx` + `components/features/workflow-tools/*` — the only files in the slice that consistently use `QueryState` (including the documented `py-6` override for matched empty-state sizing), correctly build on `Pill`/`Switch`, and use `role="alert"` on every inline field error (`ToolAgentAccessPanel.tsx`, `ExplicitToolAgentAccessPanel.tsx`). `ToolPermissionPill.tsx` and `ToolTransportPill.tsx` are also good examples of "documented, deliberate divergence from `Pill`" rather than silent duplication.
- **Also a good model, structurally:** `components/features/triggers/*` field files (`ScheduledTriggerFields`, `IntervalTriggerFields`, `WebhookTriggerFields`, `EventTriggerFields`, `TriggerMetaFields`) — five files that share one `fieldLabelClass`, one section-card shell (`rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-4`), and one `admin-input` convention with zero drift between them.
- **Worst offender:** `pages/ExecutorsPage.tsx`. It is the slice's only page outside the column-browser layout, self-documents three separate deliberate deviations from shared primitives (no `AdminPageHeader`, no `SectionLabel`, no `QueryState` — comments at lines 211-221, 226, 323-324), contains the slice's only raw Tailwind named colours (`text-emerald-600`, `text-amber-600` at line 34-36) and its only reference to an undefined CSS variable (`var(--border)` — doesn't exist in `styles.css` — via `ExecutorWorkspacePromotionsPanel.tsx:39`, which this page renders), has zero pagination/filtering on its executor list, and is written in a dense, largely unformatted single-line JSX style (e.g. line 329, the entire executor row, is one physical line) that makes the divergences harder to spot on review.
- **Close second offender:** `WorkflowNodeInspector.tsx` + `WorkflowSamplePicker.tsx` (flagged in the brief) — an entire hard-coded light-mode-only colour system (`bg-white`, `border-black/10`, `text-[#433349]`, `border-[#7445c7]`, `amber-300/50/800`, `emerald-200/50/900`, `red-200/50/800`) coexisting, inside the same components, with correctly theme-aware tokens (`var(--line)`, `var(--muted)`, `var(--tx3)`).

---

## Top 5 unification wins for this slice

1. **One "bordered div-list" component** replacing 11+ hand-copied instances of `divide-y divide-[color:var(--sep)] overflow-hidden rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)]` plus the two competing row-selection styles (`border-l-2` accent rows vs. `ExecutorsPage.tsx:329`'s `rounded-md` rows) — covers §2 and half of §7/§9.
2. **Adopt `QueryState`/`EmptyState` in `TriggerListColumn`, `WorkflowsPage`, `WorkflowRunDetail`, `WorkflowTemplateDetail`, `WorkflowInstallationDetail`, and every executor file** — currently 2 real bugs (fetch-failure-reads-as-empty in `TriggerListColumn.tsx:174-179` and `WorkflowsPage.tsx:335-340`) plus ~8 near-miss reimplementations of `EmptyState`'s dashed-card shape.
3. **Fold `Notice`/`role="alert"` into every executor + workflow-designer error line** — currently 10+ bare `<p className="text-xs text-[color:var(--danger-text)]">` lines with no `role`, none of which pass the accessibility bar `ToolAgentAccessPanel`/`ExplicitToolAgentAccessPanel` already meet.
4. **One status→{tone, dot-colour} mapping** built once from `Pill`'s tone system, replacing the four independent `Record<Status,string>` colour maps (`getTriggerStatusColor`, `DELIVERY_DOT`, `getRunStatusColor`, `getStepStatusColor`) plus deleting the dead `runStatusClass`/`stepStatusClass` maps in `workflows/presentation.tsx:151-187` that nothing imports.
5. **Purge the hard-coded colour palette from `WorkflowNodeInspector.tsx`/`WorkflowSamplePicker.tsx`** (`bg-white`, `border-black/10`, `#433349`, `#7445c7`, `#faf7fc`, `amber-*`, `emerald-*`, `red-*`) onto the existing theme tokens (`--panel`/`--sep`/`--tx`/`--warning-*`/`--success-*`/`--danger-*`) already used by the rest of the file for its inputs, warnings, and previews — plus fix `ExecutorWorkspacePromotionsPanel.tsx:39`'s reference to the undefined `--border` token and `ExecutorsPage.tsx:34-36`'s `emerald-600`/`amber-600`.
