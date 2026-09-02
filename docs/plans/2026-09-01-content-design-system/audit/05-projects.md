# Projects slice — content design-system audit

Scope covered: `admin/src/pages/ProjectsIndexPage.tsx`, `admin/src/pages/project/{ProjectView,ProjectBacklogTab,ProjectBoardTab,ProjectDocsTab,ProjectExecutorsTab,ProjectInsightsTab,ProjectSettingsPage}.tsx`, `admin/src/pages/channels/ChannelProjectOverviewPage.tsx`, `admin/src/components/features/projects/*.tsx`, `admin/src/components/kanban/*` (content only), `admin/src/components/shared/{CreateProjectDialog,EditProjectDialog,ProjectMembersDialog,AssigneePicker}.tsx`.

All paths below are relative to `admin/src/`.

---

## 1. Body containers & sections

The brief specifically asks that the project tabs be compared against each other — they diverge on every axis: outer padding, max-width, gap scale, and section-heading treatment.

| Tab | Outer wrapper | Max-width | Section gap | Section heading |
|---|---|---|---|---|
| `pages/project/ProjectBacklogTab.tsx:199-200` | `min-h-0 overflow-y-auto p-4` | `max-w-3xl` | `gap-6` | local `label` const, `text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]` (line 21) |
| `pages/project/ProjectBoardTab.tsx:57` | `flex h-full min-h-0 flex-col gap-3 p-4` | none (full width) | `gap-3` | none (no sections) |
| `pages/project/ProjectDocsTab.tsx:29` | `flex h-full min-h-0` — sidebar+content split | none | n/a | `.admin-sec-hdr`/`.admin-sec-row` (nav-rail classes, line 36-39) reused as a content-area rail label |
| `pages/project/ProjectExecutorsTab.tsx:15-16` | `min-h-0 overflow-y-auto p-6` | `max-w-4xl` | `gap-5` | real `<h2 className="text-lg font-semibold text-[color:var(--tx)]">` (line 19) — a heading element, not an uppercase label |
| `pages/project/ProjectInsightsTab.tsx:79-80` | `min-h-0 overflow-y-auto p-6` | `max-w-2xl` | `gap-8` | local `label` const, byte-identical string to Backlog's (line 3), redefined separately |
| `pages/project/ProjectSettingsPage.tsx:167-168` | `min-h-0 overflow-y-auto p-6` | `max-w-2xl` | `gap-8` | local `label` const, byte-identical string a **third** time (line 15) |
| `components/features/projects/ProjectDashboard.tsx:28-33` (Overview tab) | `@container` two-column CSS grid | `max-w-[1040px]` | `gap-4` | `SectionLabel as="h2"` — the **only** tab using the shared primitive, via `DashboardSectionCard.tsx:30` |

Findings:
- Six different content-width strategies for sibling tabs of the same project (`max-w-3xl`, `max-w-4xl`, `max-w-2xl` ×2, `max-w-[1040px]`, full-bleed ×2).
- Three different padding values (`p-4`, `p-6`, custom sidebar layout) with no evident rule tying padding to content type.
- Three genuinely different "section heading" implementations for the same job (hand-rolled uppercase label, real `<h2>`, `SectionLabel` primitive), and the hand-rolled one is copy-pasted verbatim into three separate files rather than extracted once.
- `ProjectDocsTab.tsx` additionally borrows `.admin-sec-hdr`/`.admin-sec-row` — classes designed for the app's navigation rail — for its own space-list rail; it is the only tab that looks like a sidebar app rather than a scrollable document body.

**Verdict: many-variants.** Missing primitive: a shared `ProjectTabBody` (max-width + padding + gap token) and a single exported section-label class/component to replace the five separate literal copies of `text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]` (Backlog, Insights, Settings, `TaskDialog.tsx:38` `fieldLabel`, `TaskDocuments.tsx:18` `fieldLabel`).

---

## 2. Tables & data lists

No `<table>`, `.admin-table`, `.agents-table`, or `ExpandableTable` appears anywhere in this slice. Every list is one of three hand-built shapes:

1. **Div rows** — `pages/project/ProjectBacklogTab.tsx:54` `TaskRow`: `flex items-center gap-2 rounded-md bg-[color:var(--sb)] px-2 py-1.5`, and the completed-iteration row at line 258 with the same `bg-[color:var(--sb)]` treatment.
2. **Button rows** (`dashboardRowClass`, `components/features/projects/DashboardSectionCard.tsx:83-86`): `flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-[color:var(--overlay)]` — reused consistently by `ProjectAgentsSection.tsx:51`, `ProjectChannelsSection.tsx:54`, `ProjectDocumentsSection.tsx:50`, `ProjectMembersSection.tsx:60`. This is the one genuinely-shared list-row pattern in the slice.
3. **Card grid** — `pages/project/ProjectExecutorsTab.tsx:46` (`admin-card grid gap-1 p-4`, `grid gap-3 sm:grid-cols-2`) and the Kanban board itself (`components/kanban/KanbanCard.tsx:137` `admin-card grid select-none gap-2 p-3`).

Row density also differs: `px-2 py-1.5` (TaskRow, dashboardRowClass) vs `p-3`/`p-4` (kanban/executor cards) — no shared row-height scale.

**Verdict: many-variants** (no table primitive used at all; three unrelated "list of items" shapes). Missing/underused primitive: none of `.admin-table`/`ExpandableTable` fit this data (none of it is genuinely tabular), so the fix is consolidating the three row/card treatments into fewer shapes rather than adopting the table primitive — but `dashboardRowClass` is a good candidate to promote out of `DashboardSectionCard.tsx` for reuse by `TaskRow`.

---

## 3. Pagination & loading more

`PaginationFooter` is not used anywhere in this slice.

- `components/kanban/KanbanBoard.tsx:274-296` implements its own paging for board *columns* (not tasks): dot indicators, `aria-label="Show page N"`, horizontal scroll-snap — a legitimately different UX problem (paging visible columns, not paging a list), but note it is a second, unrelated "page indicator" convention living beside `PaginationFooter`'s Previous/label/Next strip.
- Dashboard sections (`DashboardSectionCard.tsx`) use row caps + `SectionOverflowHint` ("…and N more agents", line 75-80) instead of pagination or infinite scroll — a truncate-with-hint pattern.
- Backlog, Insights, Settings, Executors, Docs render their full list with no paging control of any kind.

**Verdict: n/a in this slice** for `PaginationFooter` itself (nothing here is a paged list), but two unrelated "there's more" conventions exist side by side (kanban page-dots vs `SectionOverflowHint`) that a synthesiser should be aware don't share vocabulary.

---

## 4. Forms

- **Label placement** is consistently above-the-control with the same visual shape (`text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]`) in `CreateProjectDialog.tsx:44-47`, `EditProjectDialog.tsx:109`, `TaskDialog.tsx:38` (`fieldLabel`), `TaskDocuments.tsx:18` — but as noted in §1, this is five independent literal copies of one string, not one shared class/component.
- **`<label htmlFor>` wiring**: correct in `CreateProjectDialog`, `EditProjectDialog`, `TaskDialog`. Missing entirely in `ProjectSettingsPage.tsx:210-216` (new-column name input, placeholder only) and `ProjectBacklogTab.tsx:225-230` (new-sprint name input, placeholder only) — inconsistent a11y coverage for structurally identical "add a named thing" mini-forms.
- **Controls**: `admin-input` used throughout; `admin-input-compact` for dense contexts (`ProjectBacklogTab.tsx:36,63,226`, `ProjectSettingsPage.tsx:27,100,212`). No raw unstyled `<input>`/`<select>` found.
- **Binary choice control**: `ProjectSettingsPage.tsx:172-186` renders board style (Kanban vs Scrum) as two `admin-button admin-button-primary`/`admin-button-secondary` toggle buttons, not the `Switch` primitive and not a radio group — a third way of expressing a binary choice that exists nowhere else in this slice (`Switch` is never imported here at all).
- **Autosave vs explicit save** — genuinely split down the middle:
  - Autosave-on-blur/change, no confirmation: `PointsInput` (`ProjectBacklogTab.tsx:23-43`), iteration-move `<select>` (`ProjectBacklogTab.tsx:62-75`), `ColumnRow` name/category (`ProjectSettingsPage.tsx:64-108`), board style toggle (`ProjectSettingsPage.tsx:180`).
  - Explicit submit button, dialog stays open until success: sprint-create form (`ProjectBacklogTab.tsx:218-238`), column-create form (`ProjectSettingsPage.tsx:210-226`), `TaskDocuments`' new-note mini-form (`TaskDocuments.tsx:93-120`, Enter *or* button).
  - Explicit submit, dialog closes on success: `CreateProjectDialog`, `EditProjectDialog`, `TaskDialog`.
- **Footer placement**: `CreateProjectDialog`/`EditProjectDialog` both use a simple bottom-right `flex justify-end gap-2 pt-1` (Cancel, then primary). `TaskDialog.tsx:323-365` instead splits the footer: left side carries contextual destructive/status text-buttons (Cancel task / Unarchive / Restore), right side carries Close/Save — a structurally different footer shape for the same "dialog with a form" job.
- **Disabled/pending**: consistent — every submit button disables on `isPending` and on empty-required-field, across all forms in this slice.

**Verdict: two-variants** (autosave vs explicit-save, roughly evenly split with no stated rule for which job gets which) plus a **one-off** (board-style toggle bypassing `Switch`). Missing primitive: none needed for controls (`admin-input` is used correctly); the win is collapsing the five duplicated label-class literals and picking one save model for "rename this thing inline" contexts.

---

## 5. Validation & field errors

`FormFieldError` helpers (`fieldErrorAria`, `renderFieldError`, `fieldErrorProps`) are **not used anywhere in this slice**.

- No field-level (per-input) error ever appears in this slice — every form here validates by "trim, then disable the submit button if empty," so `aria-invalid`/`aria-describedby` are never wired on any input in `CreateProjectDialog`, `EditProjectDialog`, `TaskDialog`, `ProjectBacklogTab`, `ProjectSettingsPage`, or `AssigneePicker`.
- **Form-level error after a failed mutation** has two different treatments:
  - `EditProjectDialog.tsx:187`: bare `<div className="text-sm text-[color:var(--danger-text)]">{error}</div>` — no `role="alert"`, no border/background, not the `Notice` primitive.
  - `TaskDialog.tsx:317-321`: `<Notice className="md:col-span-2" role="alert" size="sm" tone="danger">{error}</Notice>` — correctly uses the shared `Notice` primitive with `role="alert"`.
- `CreateProjectDialog` has no error-surface path at all (create can't meaningfully fail in the UI's model, or the failure is just swallowed — no `catch` around `mutateAsync`).

**Verdict: two-variants** for form-level error (bare red div vs `Notice`), and a total absence of field-level error wiring despite `FormFieldError` existing precisely for this. Missing primitive use: `Notice` (already exists, half-adopted) and `FormFieldError` (never adopted).

---

## 6. Feedback after actions

There is **no success feedback anywhere in this slice** — not a toast, not a transient banner, not inline "Saved" text:

- Silent autosave mutations with zero confirmation of any kind: column rename/category (`ProjectSettingsPage.tsx:64-73`), story points (`ProjectBacklogTab.tsx:23-32`), task→iteration move (`ProjectBacklogTab.tsx:62-75`), board style (`ProjectSettingsPage.tsx:180`).
- Dialog-based mutations (`CreateProjectDialog`, `EditProjectDialog`, `TaskDialog`) treat "the dialog closes" as the only success signal — nothing persists afterward to confirm the change landed (no toast, no `FeedbackBanner`).
- `pages/settings/settings-shared.tsx`'s `FeedbackBanner` is never imported anywhere in this slice, despite several of these flows (Edit project, Task save) being exactly the "async action needs to announce success/failure" job it exists for.

**Verdict: consistent (by absence)** — worth flagging as a genuine gap rather than a stylistic inconsistency: a person renaming a board column or moving a task to an iteration gets no acknowledgement that anything happened beyond the value re-rendering.

---

## 7. Loading / error / empty states

This is the category with the sharpest tab-to-tab divergence — direct comparison across all six sibling tabs:

| Tab | Loading | Error | Empty |
|---|---|---|---|
| **Backlog** (`ProjectBacklogTab.tsx`) | *none* — queries default to `[]`, so a slow fetch renders "No sprints yet." before data arrives (loading and empty are indistinguishable — a real bug, not just a style gap) | *none handled* | "No sprints yet." bare text (line 204); backlog section has no empty text at all |
| **Board** (`ProjectBoardTab.tsx`) | *none* (empty board silently shown while loading) | explicit, deliberately opts out of `QueryState` per its own comment (line 70-71): `py-10 text-center text-sm text-[color:var(--danger-text)]` "Failed to load tasks. Please refresh." (no Retry) | n/a (board itself handles empty columns) |
| **Docs** (`ProjectDocsTab.tsx`) | delegated to `KnowledgeWorkspace` (out of scope) | delegated | two bespoke branches in a centered flex div (line 63-67), not `EmptyState` |
| **Executors** (`ProjectExecutorsTab.tsx`) | `<p className="text-sm text-[color:var(--tx3)]">Loading executors…</p>` (line 35) | `<p className="text-sm text-[color:var(--danger-text)]">Unable to load project executors.</p>` (line 36) | `admin-card p-5` (line 38), explicitly **not** `EmptyState` per its own comment ("empty state is a card, not a line") — a solid-border card, different from `EmptyState`'s dashed border + `--overlay-weak` background |
| **Insights** (`ProjectInsightsTab.tsx`) | `if (isLoading \|\| !insights) return <div className="p-6 text-sm text-[color:var(--tx3)]">Loading…</div>` (line 74-76) | *not handled* (query error is indistinguishable from still-loading) | per-chart empty text ("No completed sprints yet.", "Start a sprint...") |
| **Settings** (`ProjectSettingsPage.tsx`) | `if (!board) return <div className="p-6 text-sm text-[color:var(--tx3)]">Loading…</div>` (line 146-148) — same wording as Insights, coincidentally | *not handled* | n/a (columns list can be empty but has no empty message) |
| **Overview / Dashboard** (`ProjectDashboard.tsx` via `DashboardSectionCard.tsx`) | `SectionSkeleton` — animated pulse rows (line 56-67), used by Channels/Documents/Members/Work sections but **not** by `ProjectAgentsSection` (line 40: it renders nothing at all while pending, an omission versus its four siblings) | `SectionNotice` (line 70-72), one shared quiet paragraph, used identically by all five sections | same `SectionNotice`, doubling as both the error and empty message |

`QueryState` is used **zero times** in this entire slice, despite Insights and Settings each hand-rolling almost exactly the "one loading line" shape it exists to unify (and re-typing the wording/padding slightly differently each time), and despite the Board/Executors comments explicitly reasoning about *why* they opt out — a reasoning `QueryState`'s own docstring anticipates for other surfaces but that never actually reuses `QueryState`'s loading-line markup even where the callers agree it's the same shape.

**Verdict: many-variants.** Best model: `DashboardSectionCard.tsx`'s `SectionSkeleton`/`SectionNotice` pair — one shared file, four consistent consumers. Missing primitive adoption: `QueryState` for Insights/Settings (straight line-triad, no Retry needed differently than QueryState defaults), `EmptyState` for Executors' empty card, and a real error state for Backlog/Insights/Settings which currently silently pretend nothing went wrong.

---

## 8. Status chips & badges

- `Pill` **is** adopted for several statuses: `IterationCard` (`ProjectBacklogTab.tsx:102`, sprint status), `KanbanCard.tsx:41,61,71,80` (project name, assignee, due date, archived status).
- But two other "status text" sites bypass `Pill` entirely and hand-roll a bare `<span>`:
  - `ProjectBacklogTab.tsx:58-60` `TaskRow`: `<span className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-[color:var(--tx3)]">{statusLabel(task.status)}</span>` — no chip container, no background, and a **new** tracking value (`0.14em`) that matches nothing else in the slice.
  - `TaskDocuments.tsx:141-143`: `<span className={`shrink-0 text-[10px] uppercase tracking-[0.14em] ${pageStatusTone[page.status]}`}>{page.status}</span>` — same bare-span shape, same `0.14em`, and its own separate tone map (`pageStatusTone`, imported from the knowledge feature) doing the same job as `Pill`'s `toneClasses` but as an independent lookup.
  - `ArchiveDoneMenu.tsx:33`: button label uses yet another tracking value, `tracking-[0.12em]`.

Across this one small slice there are now five distinct letter-spacing values doing "small uppercase caption" work: `0.12em` (ArchiveDoneMenu), `0.14em` (TaskRow status, page-status), `0.16em` (the `label`/`fieldLabel` literals, `KanbanColumn.tsx:36`, `Pill`'s own uppercase default), `0.18em` (`SectionLabel` `2xs`), `0.2em` (`SectionLabel` `xs`, `CreateProjectDialog`/`EditProjectDialog` labels).

**Verdict: two-variants** (`Pill` vs bare-span-with-local-tone-map), with a tracking-value sprawl noted for §11 too. Missing primitive: route `TaskRow`'s and `TaskDocuments`' status text through `Pill` (both already have exactly the kind of short tone-mapped word `Pill` is for).

---

## 9. Detail / key-value views — compared across tabs

No `<dl>` or two-column label/value grid appears anywhere in this slice. Comparing what each tab does instead of a genuine detail view:

- **Backlog**'s `IterationCard` (`ProjectBacklogTab.tsx:97-148`) is the closest thing to a "detail card": a header row mixing a name, a `Pill`, and a plain summary string (`{pointsDone}/{pointsTotal} pts · {taskCount} tasks`) rather than labeled fields, then a goal line, then a nested task list. It is a composite card, not a metadata grid.
- **Insights** (`ProjectInsightsTab.tsx`) is chart-shaped (SVG bar/line charts under a `label` + `admin-card p-4` wrapper) — internally consistent between its two charts (Velocity, Burndown), but not a detail/kv page at all.
- **Settings** (`ProjectSettingsPage.tsx`) is an editable list of controls (column rows), not a read view.
- **TaskDialog** (`components/kanban/TaskDialog.tsx`) is the nearest thing to a task "detail" page but is entirely form-shaped (every field is an editable control, never rendered as read-only label/value) — there is no read-only detail mode for a task anywhere in this slice, only the edit form.
- **Overview / Dashboard** (`ProjectDashboard.tsx`) is a list-of-cards summary, not a single-entity detail view.

**Verdict: n/a in this slice** — no page composes a genuine key-value/metadata block; every "detail" surface in Projects is either an editable form, a card list, or a chart. Worth flagging to the synthesiser as a gap rather than an inconsistency: if the design system defines a canonical `<dl>`-style detail block (used elsewhere in the admin per the baseline `admin-card`/`admin-frame` notes), Projects never adopts it even for read-mostly data like iteration/task summaries.

---

## 10. In-content filters, search boxes & toolbars

- No filter row, search box, or select-filter exists in Backlog, Insights, Settings, Executors, or Docs (Docs' search, if any, is inside the out-of-scope `KnowledgeWorkspace`).
- `AssigneePicker.tsx:93-103` has an internal search input, but it's a combobox control, not a list-filtering toolbar.
- `ProjectMembersDialog.tsx:31,48` passes `search`/`onSearchChange` through to the out-of-scope `MemberManagementPopup` — no bespoke filter UI owned by this file.
- `KanbanBoard.tsx` has no filter/search row; its only in-content toggle is the Archived disclosure (`KanbanBoard.tsx:333-341`, a plain text button with a `▾`/`▸` glyph, not a `Switch` or `TabBar`).
- **Count summaries** are placed in three different spots for the same "how many of these" job:
  - Appended in the section-label string with parens: `Backlog ({backlogTasks.length})` (`ProjectBacklogTab.tsx:243`), `Archived ({archived.length})` (`KanbanBoard.tsx:341`).
  - Inline explanatory text after a bullet: `{pointsDone}/{pointsTotal} pts · {taskCount} tasks` (`IterationCard`, `ProjectBacklogTab.tsx:104`).
  - Appended after the card title with `·`: `title · N` in `DashboardSectionCard.tsx:32` (`{title}{typeof count === 'number' ? ` · ${count}` : ''}`).

**Verdict: n/a in this slice** for filters/search (none exist to unify), but **many-variants** for count-summary placement — three unrelated conventions for "count next to a label" with no shared helper.

---

## 11. Typography & spacing inside content

Consolidating the scattered findings above:

- **Padding scale**: `p-4` (Backlog, Board outer), `p-5` (Executors empty-card, matching `EmptyState`'s own default), `p-6` (Executors outer, Insights outer, Settings outer) — three values for the same "tab body" role with no rule linking padding choice to content type.
- **Max-width scale**: `max-w-3xl` / `max-w-4xl` / `max-w-2xl` (×2) / `max-w-[1040px]` / none (×2) — six distinct values across seven sibling views (see §1 table).
- **Gap scale**: `gap-3` (Board), `gap-4` (Dashboard), `gap-5` (Executors), `gap-6` (Backlog), `gap-8` (Insights, Settings) — five values, and note `p-6` co-occurs with both `gap-5` and `gap-8`, so padding and gap don't even track together consistently.
- **Tracking/letter-spacing** for small-uppercase-caption text: `0.12em` (`ArchiveDoneMenu.tsx:33`), `0.14em` (`ProjectBacklogTab.tsx:58`, `TaskDocuments.tsx:141`), `0.16em` (the five-times-duplicated `label`/`fieldLabel` literal, `KanbanColumn.tsx:36`, and `Pill`'s own `uppercase` default), `0.18em` (`SectionLabel` `2xs`), `0.2em` (`SectionLabel` `xs`, `CreateProjectDialog.tsx:46`, `EditProjectDialog.tsx:109`) — five distinct values for what should be one visual decision.
- **Border-radius**: `.admin-card` (12px, via the unlayered `--sep`/`--panel` rule) used pervasively for cards (`IterationCard`, `KanbanCard`, Executors cards, Insights/Executors chart wrappers). But `EditProjectDialog.tsx:122` builds its own ad hoc "card" — `rounded-xl border border-[color:var(--sep)] bg-[color:var(--main)] p-4` — which per `styles.css:1941-1953`'s own documented warning resolves to **20px** (the redeclared `--radius-xl`), a genuinely different, larger radius than `.admin-card`'s 12px despite both reading as "a card with a border" in the markup. `AssigneePicker.tsx:91` and `ArchiveDoneMenu.tsx:43` both use `rounded-lg` (8px) for their floating dropdown/popover panels — a third radius value for "a panel that sits over content."
- **Background tokens**: `--sb` is reused as a generic "quiet row" background (`TaskRow`, completed-iteration row, `ProjectDocsTab`'s sidebar aside) while `--overlay-weak`/`--overlay` fills the same "quiet surface" role elsewhere (`dashboardRowClass` hover, `EmptyState`, `KanbanColumn`'s dropzone) — two token families doing overlapping work with no stated boundary between them.
- **Raw colours**: none found. No Tailwind named-colour utilities (`text-emerald-*`, `bg-black/*`, etc.) or bare hex values appear anywhere in this slice's own files — every colour reference goes through a CSS custom property. This is a genuine compliance win worth noting.

**Verdict: many-variants** for spacing/tracking/radius scales; **consistent** for colour-token discipline (no raw colours).

---

## 12. Destructive & confirm flows with forms in dialogs

- `ConfirmDialog` is correctly used for two destructive actions: iteration delete (`ProjectBacklogTab.tsx:150-161`, with a body: "Its tasks return to the backlog.") and column delete (`ProjectSettingsPage.tsx:118-128`, no body — a bare question, which `ConfirmDialog`'s own docstring explicitly sanctions as optional).
- No native `window.confirm` anywhere in this slice — clean.
- **But** `TaskDialog.tsx` has three destructive/state-changing actions — "Cancel task" (line 343-350), "Unarchive" (line 326-333), "Restore" (line 334-341) — and **none of them go through `ConfirmDialog`**: clicking "Cancel task" calls `handleStatus('cancelled')` immediately, with zero confirmation step, in the same feature area where iteration/column deletion are correctly guarded. This is a real inconsistency in destructive-action coverage, not just a styling one.

**Verdict: two-variants** (`ConfirmDialog` used correctly for iteration/column delete; `TaskDialog`'s three status-changing actions bypass confirmation entirely, despite "Cancel task" being at least as destructive as deleting an empty column).

---

## Good model / worst offender

- **Good model**: `components/features/projects/DashboardSectionCard.tsx` plus its four consistent consumers (`ProjectChannelsSection`, `ProjectDocumentsSection`, `ProjectMembersSection`, `ProjectWorkSection`). One shared card shell (`SectionLabel`-based header, `· N` count, optional right-aligned links), one shared skeleton (`SectionSkeleton`), one shared notice (`SectionNotice`), one shared row class (`dashboardRowClass`), one shared "N more" hint (`SectionOverflowHint`) — genuinely the only sub-system in this slice where four sibling files agree on every visual decision. `ProjectAgentsSection` is the one partial defector (no skeleton while pending, §7).
- **Worst offender**: `pages/project/ProjectSettingsPage.tsx`. It duplicates the five-times-copied `label` string (§1/§4) rather than importing it from anywhere; expresses a binary choice with two ad hoc buttons instead of `Switch` (§4); has fully silent autosave with zero success/failure feedback for column rename (§6); its two early-return states ("Loading…" and the non-owner refusal) are bare unstyled `<div>`s with no card, no `QueryState`, no `EmptyState` — the least-dressed loading/gating text in the whole slice (§7); and its inline `<input>`s for column/sprint naming have no `<label>` at all (§4). `components/shared/EditProjectDialog.tsx` is a close second, for the layered-vs-unlayered radius trap on its avatar panel (§11) and its bare-div (non-`Notice`) form error (§5).

---

## Top 5 unification wins for this slice

1. **One tab-body shell.** Six different `max-width`/padding/gap combinations across seven sibling tabs (Backlog `max-w-3xl p-4 gap-6`, Executors `max-w-4xl p-6 gap-5`, Insights/Settings `max-w-2xl p-6 gap-8`, Board full-bleed `p-4 gap-3`, Dashboard `max-w-[1040px]`) → one shared `ProjectTabBody` wrapper.
2. **One section/field-label export.** The exact string `text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]` is hand-typed as a local const in five separate files (`ProjectBacklogTab`, `ProjectInsightsTab`, `ProjectSettingsPage`, `TaskDialog`'s `fieldLabel`, `TaskDocuments`' `fieldLabel`) instead of being one export — and it doesn't even match `SectionLabel`'s own tracking value (`0.2em`/`0.18em`), so unifying it also means resolving that mismatch.
3. **Adopt `QueryState`/`EmptyState` for the tab-level loading/error/empty triad.** Zero uses of either primitive across six tabs; Insights and Settings each hand-roll "Loading…" slightly differently, Backlog and Insights silently swallow query errors (indistinguishable from "still loading" or "genuinely empty"), and Executors' documented empty-card opt-out uses a solid `admin-card p-5` where `EmptyState`'s dashed-border treatment already exists for exactly this.
4. **Route bare status spans through `Pill`.** `TaskRow`'s task-status text (`ProjectBacklogTab.tsx:58`) and `TaskDocuments`' page-status text (`TaskDocuments.tsx:141`) each hand-roll an uppercase span with their own tone map and their own one-off `0.14em` tracking, duplicating exactly what `Pill` already does correctly for `IterationCard` and `KanbanCard` in the same feature area.
5. **Confirm every destructive action the same way.** Iteration delete and column delete go through `ConfirmDialog`; `TaskDialog`'s "Cancel task" (and Unarchive/Restore) fire immediately with no confirmation at all — a functional gap, not just a visual one, in the same dialog family.
