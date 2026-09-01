# Agents slice — content design-system audit

Scope: `admin/src/pages/AgentsPage.tsx`, `AgentDetailPage.tsx`, `AgentDesignerPage.tsx`, every file under `admin/src/components/features/agents/` (37 files), `admin/src/components/shared/AgentRow.tsx`, `admin/src/components/features/personal-assistant/PersonalAssistantSurface.tsx`. All 42 files read in full.

---

## 1. Body containers & sections

- **`admin-card` is the majority container** for a "box of content" inside a tab body: `AgentDetailTabs.tsx:161` (Current activity), `AgentTriggerPanel.tsx:40,136,144` (trigger row + panel), `AgentDesignerPage.tsx:315` (avatar row), `todos/AgentTodosTab.tsx:17` (disabled state), `todos/TodoTemplateCard.tsx:46`, `todos/TodoInstanceCard.tsx:64`.
- **A second, un-named "inline card" look** — `rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)] p-4` — repeats verbatim as its own literal string instead of `admin-card` (which is 12px radius vs this 20px `rounded-xl`, per the styles.css comment at `admin/src/styles.css:1941-1953` explicitly warning these are *not* the same card): `AgentAvailableTools.tsx:148`, `AgentMessagePreview.tsx:23`, `ToolExecutionLog.tsx:38`, `AgentDesignerForm.tsx:211` (To-dos row). A third variant swaps the fill to `bg-[var(--scrim-weak)]`: `AgentTriggerPanel.tsx:104` (delivery card). A fourth swaps to dashed border + `--overlay-weak`: `AgentThoughtStream.tsx:4` (near-identical to `EmptyState` but hand-rolled with `p-4`/`text-tx2` instead of `EmptyState`'s `p-5`/`text-tx3`).
- **Page-level header is fully hand-rolled**, not `AdminPageHeader`/`SettingsPanel`, in three different shapes: `AgentsList.tsx:77-93` (24px hero + scope description + create button), `AgentDetailPage.tsx:90-124` (avatar + name + status dot + Pill + role + activity line), `AgentDesignerPage.tsx:272-292` (embedded save bar vs `ResponsivePageHeader`). Each carries an explicit code comment justifying why the shared header can't express it — three separate hand-rolled headers for one page family.
- **`AgentDetailPage`'s identity block is duplicated almost verbatim** in `AgentDetailDrawer.tsx:62-74` (name + `AgentStatusDot` + `Pill` + role + "Active tool: X" / "Last activity Y" line) — same content, independently laid out, including a **duplicated `getStatusTone` function** (`AgentDetailPage.tsx:22-27` vs `AgentDetailDrawer.tsx:16-30`, byte-different formatting of the same four branches).
- Section-heading treatment inside bodies is `SectionLabel` in most places (`AgentDetailTabs`, `AgentAvailableTools`, `AgentTriggerPanel`, `ToolExecutionLog`, `AgentThoughtStream`, `todos/*`), but **`SubAgentTree.tsx:14-16`** hand-rolls the identical look as a bare `div` with `text-[color:var(--muted)]` instead of `SectionLabel`'s `--tx3` — a raw-token divergence, not just a missed import.
- Spacing scale: `grid gap-4`/`gap-5`/`gap-6`/`gap-8` all appear as the outer rhythm for a tab body with no evident rule (`AgentDetailTabs.tsx:160` uses `gap-6`; `AgentAvailableTools.tsx:96,138` use `gap-4`/`gap-6`; `AgentDesignerForm.tsx:66` uses `gap-5`; `AgentTodosTab.tsx:31` uses `gap-8`).

**Verdict: many-variants.** Missing primitive: a generalised content-card component (`admin-card` is fine but a second un-named "wide-radius panel" is load-bearing in ~6 files and should either become `admin-card`'s sibling or be folded in deliberately).

---

## 2. Tables & data lists

- **The one real `<table>` list** is `AgentsTable.tsx` → `ExpandableTable` wrapping `<table className="agents-table w-full border-collapse">` (`AgentsTable.tsx:20`), faithfully using the zebra/hover CSS the brief calls out. Header is a single spanning `<th colSpan={4}>` (`AgentsTable.tsx:27-33`) rather than per-column headers — the row itself supplies visual columns (avatar / name+role / owner / chevron) with no `scope`-per-column semantics.
- **`todos/TodoTemplateCard.tsx:96-116` and `todos/TodoInstanceCard.tsx:95-138`** each independently wrap a `<table className="admin-table ...">` inside `ExpandableTable` for their step rows — faithful reuse of both baseline primitives, real column semantics (numeric index, title+instructions, status), inline `admin-input-sm` selects for editable status cells. **These two files are the strongest table usage in the slice.**
- **Everything else that is conceptually "a list of rows" is a stack of cards, not a table**: `AgentTriggerPanel.tsx` (triggers), `AgentMessagePreview.tsx` (messages), `ToolExecutionLog.tsx` (tool calls), `AgentAvailableTools.tsx`'s `AgentToolsReadOnly` (tools), `SubAgentTree.tsx` (sub-agents, via `AgentRow`), `AgentDesignerForm.tsx`'s `ToolPicker`/`RunLimitsFieldset` fields. None of these is wrong per se (a card list reads fine for 3-8 items) but three different card shells implement the same "row of one thing" idea (see §1) with no shared component. Messages have pagination (`AgentDetailTabs.tsx:191-206`) but tools/triggers/sub-agents/tool-log do not — an unbounded card list with no pagination for triggers/tool-log/messages-preview-content is a scale risk.
- No sorting, no row selection, no sticky header anywhere in this slice.
- Loading state for the one real table is a **bespoke skeleton** (`AgentsTable.tsx:49-72`, `animate-pulse` bars sized per column) rather than `QueryState`'s text triad — a deliberate, reasonable choice for a table (`QueryState`'s own doc says a skeleton keeps its own markup), but it means the admin now has (at least) two shapes of "loading a list": text line (`QueryState`, most of the rest of the admin) vs skeleton bars (`AgentsTable`).

**Verdict: many-variants** (one real faithful `.agents-table`/`ExpandableTable` list-table, two faithful `.admin-table`/`ExpandableTable` step-tables, and five-plus independent card-list shells for everything else). Missing primitive: a `CardList`/`RowCard` shell — `AgentRow` almost is one but is agent-identity-specific (avatar+title+subtitle), so the tool/trigger/message cards can't reuse it even though their markup is near-identical to each other.

---

## 3. Pagination & loading more

- **`PaginationFooter` is used correctly and only** in this slice — no hand-rolled prev/next anywhere. Two call sites, two different arithmetic strategies exactly as the component's own doc predicts:
  - `AgentsList.tsx:124-135` — slices a client-held array, label = `"${rangeStart}–${rangeEnd} of ${scopeAgents.length} · Page ${page+1} of ${totalPages}"`, always visible (no `hideWhenSinglePage`) "so the table above it does not grow and shrink."
  - `AgentDetailTabs.tsx:197-205` — fetches `PAGE_SIZE + 1` to detect a next page, label = `"Page ${messagePage + 1}"` (no total), `hideWhenSinglePage` set.
- No page-size control, no cursor pagination, no "Load more" button anywhere in the slice.
- Triggers, tool-execution log, sub-agent tree, and the read-only tools list are **unpaginated card stacks with no cap** — not a `PaginationFooter` gap exactly, but worth flagging: if any of those lists grows, there is no loading-more affordance at all today.

**Verdict: consistent** for the two places pagination exists (both faithful to `PaginationFooter`, label wording deliberately differs for a stated reason). No unification win here beyond noting the un-paginated lists as a possible future gap, out of scope for this audit's "unify existing patterns" mandate.

---

## 4. Forms

This slice's largest form is `AgentDesignerForm.tsx` (agent create/edit — name, role, visibility, model, effort, run limits, to-dos, system prompt, tools), with smaller forms in `todos/TodoTemplateEditor.tsx`, `todos/ScheduledTodoTemplate.tsx`, and the Tools tab (`AgentAvailableTools.tsx`).

- **Label typography has at least three distinct treatments across forms that ship together in the same tab family:**
  - `AgentDesignerForm.tsx:31-34` `fieldLabelClass = 'text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]'` — used for Name, Role, Visibility, Model, Effort, To-dos, System prompt, Tools (real `<label htmlFor>` for text/select inputs at lines 77, 95, 151, 184, 236; bare `<div>` for the non-single-control sections at lines 70, 112, 213, 259).
  - `designer/RunLimitsFieldset.tsx:82` — sub-field labels are `text-xs font-medium text-[color:var(--tx2)]` (smaller weight, different color token, no uppercase/tracking) even though they sit one level below a `fieldLabelClass` legend in the very same form.
  - `todos/TodoTemplateEditor.tsx:89,106` top-level fields (Name, Description) use `text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]` (matches `fieldLabelClass` byte-for-byte but is re-typed inline, not imported), while its own per-step fields at `:174,190` drop to plain `text-xs text-[color:var(--tx2)]` — a fourth combination, and inconsistent *within the same editor*.
- **Boolean-toggle affordance is not one thing.** `AgentDesignerForm.tsx:226-231` uses the real `Switch` primitive for "Enable to-dos"; nineteen lines earlier, `:124-141`, "Only visible to me" (visibility) is a raw `<input type="checkbox">` inside a clickable card-styled `<label>` — same form, two different controls for the same kind of boolean decision, with no stated reason for the split.
- **Character-count helper text** appears only in `todos/TodoTemplateEditor.tsx` (`name.length / MAX`, `description.length / MAX`, `title.length / MAX`, `instructions.length / MAX` — lines 100-102, 117-119, 185-187, 202-204) and nowhere else in the slice, even though `AgentDesignerForm`'s Name/Role/System-prompt inputs are also length-constrained server-side.
- **Streaming-highlight affordance** — a field gets `border-[var(--accent)] shadow-[0_0_0_1px_var(--accent-soft)]` while the Design Assistant is live-writing it (`AgentDesignerForm.tsx:84,102,158,177,243-246`; `ModelCombobox.tsx:116`) — a real, useful, and unique-to-this-slice control state that exists nowhere else in the audited admin. Not a defect, but worth the synthesiser knowing it needs a named token/utility rather than five independently-typed class strings.
- **Fieldset/grouping**: `RunLimitsFieldset.tsx:73-74` and `TodoTemplateEditor.tsx:138-144` both use real `<fieldset>`/`<legend>` — the two best-grouped forms in the slice.
- **Form action-row placement varies by surface**, all "bottom" but three different shapes: `TodoTemplateEditor.tsx:210-217` bottom-right `flex justify-end gap-2` inside the form; `ScheduledTodoTemplate.tsx:100-104` inline trailing buttons in a single-row form; `AgentDesignerPage.tsx:274-285` a dedicated top-of-panel bar (embedded mode) vs the page header's action slot (standalone mode, out of scope styling-wise but the *placement* differs structurally from the other two forms in the same feature).
- **Inline filter/action `<select>`s use raw `admin-input`/`admin-input-sm`/`admin-input-compact` directly** (no wrapper component) throughout: `todos/TodoInstances.tsx:119-140` (two selects + button in a toolbar row), `todos/ScheduledTodoTemplateForm` (`ScheduledTodoTemplate.tsx:92-98`, `admin-input-compact`), `todos/TodoInstanceCard.tsx:119-129` (`admin-input-sm` per-row status select). Consistent class usage, but three different size modifiers (`admin-input`, `-compact`, `-sm`) chosen per-context with no documented rule for which context gets which.
- Autosave vs explicit save: everything in this slice is **explicit Save** (`AgentAvailableTools`'s dirty-tracked Save button, `AgentDesignerPage`'s Save/Create, `TodoTemplateEditor`'s Save/Create). No autosave anywhere — consistent.
- Disabled/pending state wording is consistent (`"Saving…"`, `"Creating…"`, `"Scheduling…"`) across the slice.

**Verdict: many-variants.** Missing primitive: a `FieldLabel` atom (there are at least 4 near-identical label class strings that should be one thing with a `size`/`weight` prop, the way `SectionLabel` already models for section headings) and a documented choice between `Switch` and checkbox for boolean fields.

---

## 5. Validation & field errors

- **`FormFieldError`'s helpers (`fieldErrorAria`, `renderFieldError`, `fieldErrorProps`) are used nowhere in this slice.** Not once, across three forms and ~15 individually-labelled fields.
- What exists instead, all bare paragraphs with `role="alert"` but no `aria-invalid`/`aria-describedby` wiring back to the control, no box, three different color tokens:
  - `AgentDesignerForm.tsx:175-179` — `text-xs text-[color:var(--danger)]` (the **wrong** token — every other error in the slice uses `--danger-text`; `--danger` is the saturated fill token used for status dots, not text-on-panel).
  - `todos/ScheduledTodoTemplate.tsx:104` — `text-sm text-[color:var(--danger-text)]`, `role="alert"`.
  - `todos/TodoTemplates.tsx:129` / `todos/TodoInstances.tsx:159` — `text-sm text-[color:var(--danger-text)]`, `role="alert"`, but this is a *load* error not a field error (should arguably be `QueryState`, see §7).
  - `AgentAvatarQuickEdit.tsx:245-247` — `text-sm text-[color:var(--danger-text)]`, **no `role="alert"` at all**.
- **`TodoTemplateEditor.tsx` — the slice's largest, most carefully built form — has *no* error display whatsoever.** Required/maxLength fields rely entirely on native HTML5 validation (`required`, `maxLength`) plus a disabled Save button; a person who leaves "Name" blank and clicks the (enabled, since disabled logic isn't even wired to name-emptiness at the button level — only `saving` gates it) Save button gets only the browser's native tooltip.
- Submit-time vs keystroke-time: the two real error surfaces (`AgentDesignerForm`'s model error, `ScheduledTodoTemplate`'s create error) both set on submit/fetch-failure, never per-keystroke — consistent with `FormFieldError`'s own stated rule, just not built on top of it.
- Form-level (not per-field) validation is communicated by a **persistent status bar**, not an alert: `AgentDesignerPage.tsx:296-305`, `bg-[color:var(--overlay-weak)] px-5 py-2 text-xs text-[color:var(--tx2)]`, sourced from `designer/save-readiness.ts`'s `saveBlockedReason`. This is a fourth distinct feedback shape in the slice (see §6) and is itself a reasonable pattern (explains a disabled button) but shares no code or visual language with the field-error paragraphs three sections away in the same file tree.

**Verdict: many-variants**, tending toward **n/a-by-omission** (most forms simply don't validate visibly). The single wrong-token bug (`AgentDesignerForm.tsx:176`, `--danger` vs `--danger-text`) is a concrete, fixable defect. Missing primitive: none missing — `FormFieldError` exists and is simply unused here; this is purely an adoption gap.

---

## 6. Feedback after actions

Four different mechanisms coexist for "something happened, tell the person":

1. **Toasts** (`useToasts()`/`pushToast`) — used exclusively in `todos/TodoTemplates.tsx` and `todos/TodoInstances.tsx` (7 call sites: `TodoTemplates.tsx:40-44,70-74,81-84,149`; `TodoInstances.tsx:67-70,79-82,91,103`), always for *errors* (`onError` mutation callbacks) and one soft-refusal ("Only organization owners can…", `TodoTemplates.tsx:39-44`). No success toast anywhere.
2. **`Notice`** — used exactly once in the whole slice, correctly, for the Design Assistant's chat error: `designer/DesignerChat.tsx:166-170`, `tone="danger" radius="lg" size="sm"`.
3. **Bare inline text (no box, no dismiss)** — the majority pattern: `AgentAvatarQuickEdit.tsx:245-247`, `AgentAvailableTools.tsx` (no error surface for its Save mutation at all — a failed `updateAgent.mutateAsync` at `AgentAvailableTools.tsx:58-60` is silently swallowed, no catch/toast/notice), `ScheduledTodoTemplate.tsx:104`.
4. **Hand-rolled hero banners that are not `Notice`/`FeedbackBanner` at all**:
   - `AgentDocumentsTab.tsx:25-29` — a warning-toned strip (`bg-[color:var(--warning-soft)] ... text-[color:var(--warning-text)]`) that drops the `border-[color:var(--warning-border)]` half of `Notice`'s own `tone="warning"` class list, plus a hand-rolled "Read-only" pill (`rounded-full border border-current px-2 py-0.5`) instead of `Pill`.
   - `PersonalAssistantSurface.tsx:147` (`PersonalAssistantConfigBanner`) — `border-[var(--accent)] bg-[var(--accent-soft)]`, an "accent/info" tone `Notice` has no equivalent for (its tone union is `danger | success | warning` only).
   - `AgentDesignerPage.tsx:296-305` — the save-blocked status bar described in §5, `bg-[color:var(--overlay-weak)]`, a fourth tone/shape again.

No transient auto-dismissing "Saved" confirmation exists anywhere in this slice — every successful mutation is communicated only by its visible effect (list refetch, dialog close, badge update), never a word of confirmation.

**Verdict: many-variants.** Missing primitive: `Notice` needs a neutral/info tone (or the two accent-banner call sites need a named "info banner" sibling) before it can absorb the `AgentDocumentsTab`/`PersonalAssistantSurface` banners; the toast-vs-inline-vs-nothing split for mutation errors is the single biggest inconsistency in this category.

---

## 7. Loading / error / empty states

- **`QueryState` is used nowhere in this slice.** Every list/detail load state is hand-spelled, and drifts in exactly the ways `QueryState`'s own doc comment says it's meant to prevent:
  - `AgentAvailableTools.tsx:128-130`: `"Loading tools…"`, `py-6 text-center text-sm text-[color:var(--tx3)]`.
  - `designer/ToolPicker.tsx:121-123`: `"Loading tools…"` (same words), `py-4 text-center text-sm text-[color:var(--tx3)]` — **different padding for the identical sentence**, one component below the other in the same tree.
  - `todos/TodoTemplates.tsx:128` / `todos/TodoInstances.tsx:158`: `"Loading templates…"` / `"Loading to-dos…"`, `py-4 text-sm text-[color:var(--tx3)]` (no `text-center`).
  - `AgentDocumentsTab.tsx:17-20,42-46`: `"Loading documents…"`, `flex h-full items-center justify-center text-sm text-[color:var(--tx3)]` — yet a third shape (flex-centered full-height, not a padded line).
  - `AgentDesignerPage.tsx:51-53`: `"Loading agent…"` vs `"Agent not found."`, same flex-centered shape as above.
  - `AgentDetailPage.tsx:74-76`: `"Loading agent…"` vs `"This agent could not be found."` — near-duplicate of the previous, independently written.
- **Error states almost never offer Retry.** Only `QueryState` has one, and it's unused. `AgentDocumentsTab.tsx:48-50` turns a load error into an `EmptyState` sentence ("Could not load…") with no retry; `todos/TodoTemplates.tsx:129` / `todos/TodoInstances.tsx:159` show the raw error message with no retry.
- **`EmptyState` is used consistently and correctly** everywhere a true empty (not loading, not error) state is needed: `AgentDetailTabs.tsx:170` (idle), `AgentTriggerPanel.tsx:157-163`, `AgentMessagePreview.tsx:18`, `SubAgentTree.tsx:18`, `ToolExecutionLog.tsx:33`, `todos/TodoTemplates.tsx:131-136`, `todos/TodoInstances.tsx:153-157,161-164`, `AgentAvailableTools.tsx:134`, `AgentDocumentsTab.tsx:49,53-56,60-63` (the latter three uses stretch `EmptyState` to also carry *error* and *no-access* semantics, conflating three different facts into one visual — same criticism `QueryState`'s doc levels at ad-hoc empty-line reuse).
- `AgentThoughtStream.tsx:3-9` is a permanent, static "not built yet" placeholder styled as a near-`EmptyState` (dashed border, `--overlay-weak`) but hand-rolled with different padding/color tokens (see §1) — worth flagging as it's neither loading, error, nor a real empty state, just placeholder content that happens to look like all three.

**Verdict: many-variants.** This is the widest gap in the slice relative to an existing, ready-made primitive (`QueryState`) that would fix the loading-text drift, the missing-Retry problem, and the error/empty conflation in one move.

---

## 8. Status chips & badges

- **`Pill` is used correctly and is the dominant chip** across the slice: agent status (`AgentDetailPage.tsx:110`, `AgentDetailDrawer.tsx:67`), tool enabled/off (`AgentAvailableTools.tsx:155-157`), trigger status (`AgentTriggerPanel.tsx:54,107`), tool-call outcome (`ToolExecutionLog.tsx:42-44`), to-do/template/step status (`todos/TodoTemplateCard.tsx:49-53`, `todos/TodoInstanceCard.tsx:67,131`), PA config pills (`PersonalAssistantSurface.tsx:155-176`).
- **Tone-mapping functions are duplicated rather than shared**, each a small `switch`/`if` returning a `PillTone`: `getStatusTone` (twice, verbatim-ish — `AgentDetailPage.tsx:22-27`, `AgentDetailDrawer.tsx:16-30`), `getTone` for tool-call success (`ToolExecutionLog.tsx:17-27`, local, not exported), `getTriggerTone` (imported from `../triggers/trigger-presentation`, shared — good), `todoStatusTone`/`templateStatusTone`/`stepStatusTone` (centralized in `todos/todo-presentation.ts:10-47` — **this is the good model**: one file owning every to-do-family tone mapping, imported everywhere it's needed).
- **One hand-rolled pill look-alike**: `AgentDocumentsTab.tsx:28`, `rounded-full border border-current px-2 py-0.5 font-semibold` for "Read-only" — not `Pill`, and its border-color-from-`currentColor` trick means it silently inherits whatever text color its warning-strip parent sets rather than an explicit tone.
- **`AgentStatusDot`** (`AgentStatusDot.tsx`) is a separate, deliberately non-`Pill` primitive (a bare colored dot) with its own tone map (`statusClasses`, `:13-20`) — reasonable as a distinct shape, but it's the *fourth* place in the slice mapping the same six-value `AgentStatus` union to a color, alongside the two `getStatusTone` copies.
- No raw/hex/named-Tailwind colors found anywhere in the slice (verified by grep) — every tone reaches its token through `var(--...)`.

**Verdict: two-variants** (real `Pill` usage is consistent; the one hand-rolled look-alike and the duplicated tone-mapping functions are the defect, not a second visual system). `todos/todo-presentation.ts` is the pattern to generalise: a `agent-status-tone.ts` sharing `getStatusTone`/`statusClasses` would remove three of the four duplicate mappings.

---

## 9. Detail / key-value views

- **No `<dl>`/`<dt>`/`<dd>` anywhere in the slice** (grepped, zero hits).
- Every "here are some labelled facts" block is a stack of `<div>`s with an inline bold/semibold label followed by the value, three independently-typed instances of the same idea:
  - `PersonalAssistantSurface.tsx:180-193` — `<span className="font-semibold text-[var(--tx)]">Label:</span> value`, three rows, `grid gap-2 text-xs leading-5`.
  - `AgentTriggerPanel.tsx:59-63` — schedule/next-run/last-fired as three bare `<div>`s with no label styling at all (just plain `text-xs text-[color:var(--tx3)]` lines, label folded into the sentence rather than a separate column).
  - `todos/TodoInstanceCard.tsx:68-70` — a single summary line mixing count + timestamp with a `·` separator rather than discrete label/value pairs.
- **Detail-page composition vs list-page composition**: the list page (`AgentsList.tsx`) is header+tabs+table+pagination; the detail page (`AgentDetailPage.tsx`) is header+tabs+tab-content, with the *edit* tab embedding the entire create form (`AgentDesignerContent`, `AgentDetailPage.tsx:131`) as one of several tabs rather than a separate page — a deliberate, well-documented design (comment at `AgentDetailPage.tsx:29-32`), not an inconsistency.
- The "identity block" (avatar + name + status + role + activity line) is the closest thing to a canonical detail header in this slice, and it is written out fully twice (`AgentDetailPage.tsx:90-124`, `AgentDetailDrawer.tsx:56-75`) rather than shared, as already noted in §1.

**Verdict: many-variants** (three different label/value shapes, none semantic HTML, one identity-block duplicated wholesale). No existing shared primitive covers this; the synthesiser would need to introduce one (e.g. a `KeyValueRow`/`DetailList`) since nothing in the baseline list addresses it.

---

## 10. In-content filters, search boxes & toolbars

- **Search-to-filter inputs**: `designer/ToolPicker.tsx:132-139` (`type="search"`, `admin-input`, filters the tool groups client-side) and `designer/ModelCombobox.tsx:106-133` (a combobox, not a plain filter input, but serves the same "narrow this list" job for the model catalogue). Both are raw `admin-input`, no shared "SearchBox" wrapper, no shared debounce/clear-button treatment.
- **Toolbar row above a list**: `todos/TodoInstances.tsx:116-149` — two `<select className="admin-input min-w-48">` (channel, template) plus a primary button, right-aligned via `flex flex-wrap items-center gap-2` next to the section's own `SectionLabel`+description on the left (`:109-115`) — i.e., the toolbar shares a row with the section heading rather than sitting in a row of its own above the list.
- **Count summaries**: `"{triggers.length} configured"` (`AgentTriggerPanel.tsx:152`, plain `text-xs text-[color:var(--tx3)]`, right side of the section header row) and `"{steps.length} / {AGENT_TODO_MAX_STEPS} steps"` (`todos/TodoTemplateEditor.tsx:83-85`, form-context "capacity" counter rather than a list-count) are the only two; `AgentsList.tsx`'s range summary lives inside `PaginationFooter`'s label, not a separate toolbar element (see §3).
- **Tab-scoped filtering** (`AgentsList.tsx`'s `TabBar` for personal/team/global) is out of scope per the brief (TabBar itself is nav) but its *count* badges (`AgentsList.tsx:99`, `buckets[scope].length`) are the same "count summary" idea as `AgentTriggerPanel.tsx:152`, expressed through `TabBar`'s own `count` prop rather than free text — a third shape for the same underlying fact ("how many of these are there").
- No date pickers in this slice.

**Verdict: two-variants** (raw `admin-input`-based filter controls are consistent in class usage; the count-summary wording/placement is the inconsistent part — free text in two different positions vs a `TabBar` count badge). No dedicated primitive exists for either; not clearly a gap worth a new component given the low count (2-3 sites).

---

## 11. Typography & spacing inside content

- **Muted-text token usage**: `--tx3` dominates (67 occurrences across the slice) as the default "secondary/meta" text color, `--tx2` is the "readable body" color (27 occurrences, e.g. descriptions, previews), `--tx` is primary text (15). One outlier uses `--muted` instead of `--tx3` for what is otherwise an identical section-label string (`SubAgentTree.tsx:14`, see §1) — the only raw-token divergence found.
- **The one confirmed wrong-token bug**: `AgentDesignerForm.tsx:176` uses `text-[color:var(--danger)]` where every sibling error message in the slice uses `--danger-text` (§5) — `--danger` (`#ef4444`) is a saturated fill meant for dots/backgrounds (`AgentStatusDot.tsx:14`), not body text.
- **Border-radius scale is wide and situational rather than tiered**: `rounded-md` (2 files: `AgentsTable.tsx:57` skeleton avatar, `ToolPicker.tsx:79` tool row hover), `rounded-lg` (5 files: `ScheduledTodoTemplate.tsx:89`, `AgentTriggerPanel.tsx:43`, `ModelCombobox.tsx:143`, `AgentDesignerForm.tsx:124`, `ToolPicker.tsx:44`), `rounded-xl` (11 files — the majority, used for both `admin-card`-adjacent panels and the "inline card" look-alike from §1), `rounded-2xl` (`AgentAvatarQuickEdit.tsx:158,173`, `AgentDetailDrawer.tsx:52`), and one bespoke `rounded-[1.5rem]` (`SubAgentTree.tsx:23`, a sub-agent row's selected-state wrapper — an arbitrary value with no token backing it at all).
- **Padding scale**: `p-3`/`p-4`/`p-5`/`p-6` all appear as a card's own padding with no evident rule tied to nesting depth or card type — e.g. `admin-card p-4` is by far the most common (`AgentDetailTabs.tsx:161`, `AgentTriggerPanel.tsx:40,136,144`, `AgentDesignerPage.tsx:315`) but `AgentAvatarDraftPanel`'s dialog-adjacent panel and `AgentAvatarQuickEdit.tsx:158`'s dialog use `p-6`, `todos/ScheduledTodoTemplateForm` uses `p-2` (`ScheduledTodoTemplate.tsx:89`).
- **Heading sizes inside bodies**: `text-2xl font-semibold` for the page-hero name (`AgentsList.tsx:84`, `AgentDetailPage.tsx:107`, `AgentDetailDrawer.tsx:65`), `text-lg font-bold` only inside `Dialog`'s own title (out of scope, baseline), `text-sm font-semibold` for card/section titles (`todos/TodoTemplateCard.tsx:48`, `todos/TodoInstanceCard.tsx:66`, `DesignerChat.tsx:96`, `TodoTemplateEditor.tsx:81`) — this tier is consistent.
- Gap scale for form fields is consistently `gap-1.5` (label+control+hint stacks throughout `AgentDesignerForm.tsx`, `RunLimitsFieldset.tsx`, `TodoTemplateEditor.tsx`) — the one clearly consistent spacing rule in the slice.

**Verdict: many-variants** for radius/padding, **consistent** for heading tiers and form-field gap. No raw hex/Tailwind-named colors found anywhere (clean).

---

## 12. Destructive & confirm flows with forms in dialogs

- **`ConfirmDialog`/`Dialog` are used nowhere in this slice.** There is no destructive-confirm flow at all for agent-level actions that plausibly warrant one (deleting/archiving a to-do template — `todos/TodoTemplateCard.tsx:66-73` — fires `onArchive` directly from a single click on `admin-button-danger`, no confirmation step; cancelling a to-do — `todos/TodoInstanceCard.tsx:86-90` — same, direct click, no confirm).
- **`AgentAvatarQuickEdit.tsx:147-274` hand-rolls a complete centred-modal shell** that duplicates `Dialog.tsx` feature-for-feature instead of using it: its own fixed-inset scrim (`:149`, `bg-[var(--scrim-strong)] backdrop-blur-sm`) with a manual `onMouseDown`-target-check for outside-click dismiss (`:150-152`, the exact pattern `useOverlayDismiss` was written to replace, per `Dialog.tsx`'s own doc comment), its own `role="dialog" aria-modal="true"` panel (`:156-161`) wired to `useModalA11y` directly (`:88`) rather than through `Dialog`, its own close-cross button and SVG (`:163-170`) instead of `Dialog`'s built-in one, and a `"Remove image"` destructive action (`:250-260`) with **no confirmation at all** — a one-click delete of the agent's custom avatar.
- Its content region is a genuine "form in a dialog" (prompt input + Generate/Upload buttons, `:200-243`) but since the shell itself isn't `Dialog`, none of `Dialog`'s size tokens, description-row, or dismiss-disabled-during-submit affordance apply — busy states are handled ad hoc via `avatarChanges.busy` disabling individual buttons rather than the shell.
- `todos/TodoTemplateEditor.tsx` is a **form embedded inline in the page flow, not a dialog** (`:72-77`, a plain `<form>` that appears/disappears in place when "New template" is clicked) — a legitimate alternative to a dialog, but means the slice has zero examples of "form correctly inside `Dialog`" to hold up as a model.

**Verdict: many-variants**, tending to **worst-offender**: this is the one category where the slice doesn't just diverge in styling but skips the shared primitive's actual behavior (focus trap wiring, escape, scrim dismiss) by reimplementing it next to the primitive that exists specifically to prevent that. `AgentAvatarQuickEdit.tsx` should route through `Dialog`, and template archive / to-do cancel are candidates for `ConfirmDialog`.

---

## Good model files

- **`admin/src/components/features/agents/todos/todo-presentation.ts`** — the one place in the slice that centralizes status→tone mapping as pure, exported, reused functions. This is the pattern the rest of the slice's duplicated `getStatusTone`/`getTone` functions should follow.
- **`admin/src/components/features/agents/todos/TodoInstanceCard.tsx`** and **`TodoTemplateCard.tsx`** — faithful, correct composition of `admin-card` + `ExpandableTable`/`.admin-table` + `Pill` + `admin-input-sm` for inline editing. The strongest table usage in the slice and a good template for "a dense sub-table inside a card."
- **`admin/src/components/features/agents/designer/DesignerChat.tsx`** — the only correct `Notice` usage in the slice (danger tone, appropriate size/radius).
- **`admin/src/components/features/agents/AgentsList.tsx`** and **`AgentDetailTabs.tsx`** — faithful `PaginationFooter` usage, each with a stated reason for its own label/arithmetic strategy.

## Worst offender

**`admin/src/components/features/agents/AgentAvatarQuickEdit.tsx`** — hand-rolls a full dialog shell (scrim, outside-click dismiss, focus-trap wiring, close button) that duplicates `Dialog.tsx` instead of using it, and its one destructive action ("Remove image") has no confirmation at all. Runner-up: **`AgentDesignerForm.tsx`**, purely for density of findings — it alone contains the wrong danger-color token (§5), the checkbox-vs-`Switch` inconsistency (§4), and three of the four distinct field-label typographies in the slice (§4).

## Top 5 unification wins for this slice

1. **Adopt `QueryState`** for the ~7 hand-spelled loading/error text lines that all say "Loading X…" / a bare error sentence with no Retry (`AgentAvailableTools.tsx:128-130`, `designer/ToolPicker.tsx:121-123`, `todos/TodoTemplates.tsx:128-129`, `todos/TodoInstances.tsx:158-159`, `AgentDocumentsTab.tsx:17-20,42-46`, `AgentDesignerPage.tsx:51-53`, `AgentDetailPage.tsx:74-76`) — fixes the padding/wording drift and adds Retry where none exists today.
2. **Route `AgentAvatarQuickEdit.tsx`'s modal through `Dialog`** instead of its hand-rolled scrim/focus-trap/close-button, and wrap its "Remove image" action in `ConfirmDialog`.
3. **Centralize agent-status tone mapping** (`getStatusTone` duplicated in `AgentDetailPage.tsx`/`AgentDetailDrawer.tsx`, plus `AgentStatusDot.tsx`'s separate map) into one exported function, following `todos/todo-presentation.ts`'s pattern — collapses 3-4 copies of the same switch into one.
4. **Give `Notice` a neutral/info tone** (or a named sibling) to absorb the two hand-rolled accent/warning banners that currently can't use it as-is: `PersonalAssistantSurface.tsx:147` (accent-toned config banner) and `AgentDocumentsTab.tsx:25-29` (warning banner missing its border, plus a hand-rolled "Read-only" pill that should be `Pill`).
5. **One `FieldLabel` atom** to replace the (at least) four label-typography variants inside forms that ship together (`AgentDesignerForm.tsx`'s `fieldLabelClass`, `RunLimitsFieldset.tsx`'s inline sub-field style, `TodoTemplateEditor.tsx`'s two different inline styles) — same shape `SectionLabel` already models for section headings, just not built for field labels.
