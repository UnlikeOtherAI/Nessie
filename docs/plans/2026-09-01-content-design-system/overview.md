# Content design system — audit and unification plan

Status: **proposal** (2026-09-01). Nothing in this document is built yet.

Scope: the *content* of admin pages — tables, lists, pagination, forms,
validation, feedback, loading/empty/error states, chips, key-value views,
in-body filters, spacing and typography, confirm flows. Explicitly **out of
scope**, because another session owns them: navigation (sidebar, rail, topbar,
mobile tab bar), page headers (`AdminPageHeader`, `ResponsivePageHeader`,
`PageHeaderMenu`, the hand-rolled hero headers on Agents/Executors/Dashboards),
`TabBar`, button styling (`.admin-button*`), and every chat surface (feed,
composer, message rows, reply panel, thinking bubbles).

Method: eleven parallel code audits, one per content area, against a common
twelve-category brief (`audit/00-brief.md`). Every claim in the per-slice
reports cites `path:line`. The reports are filed unedited under `audit/`; this
overview is the synthesis. The audit was code-only: this environment has no
database, so no page was rendered. Before any migration lands, the Playwright
verification rule in `AGENTS.md` applies as usual.

Reports: [governance](audit/01-governance.md) ·
[ops & billing](audit/02-ops-billing.md) ·
[personal settings](audit/03-settings-personal.md) ·
[org settings](audit/04-settings-org.md) · [projects](audit/05-projects.md) ·
[knowledge base](audit/06-knowledge.md) · [agents](audit/07-agents.md) ·
[automation](audit/08-automation.md) ·
[apps & integrations](audit/09-apps-integrations.md) ·
[dashboards, search, auth](audit/10-dashboards-search-auth.md) ·
[shared dialogs & stylesheet](audit/11-shared-dialogs-css.md).

## 1. The one-paragraph diagnosis

The admin already has most of the primitives a Bootstrap-style content system
needs — `QueryState`, `EmptyState`, `PaginationFooter`, `ExpandableTable` +
`.admin-table`, `Notice`, `Pill`, `SectionLabel`, `Switch`, `FormFieldError`,
`Dialog`, `ConfirmDialog`, `.admin-input`. **The problem is not missing
primitives; it is that they are used on a minority of surfaces and every
other surface re-derives the same shape by hand, slightly differently.** Each
primitive also has one or two real gaps (no `info` tone on `Notice`, no
outline variant or fixed height on `Pill`, no `0.16em` size on `SectionLabel`,
no load-more mode on `PaginationFooter`, no 680px `Dialog`), and those gaps are
exactly what the self-documented "Not `Pill`" / "Not `QueryState`" / "Not the
shared `Dialog`" comments across the codebase point at. So the plan is in two
halves: close the gaps in the primitives, then adopt them everywhere with a
lint gate so the forks cannot grow back.

## 2. Adoption today (files importing each primitive, `admin/src`)

| Primitive | Files using it | Hand-rolled equivalents found by the audits |
|---|---|---|
| `QueryState` | 12 | ~60 hand-spelled loading/error/empty blocks across every slice; ~10 lists with **no error state at all** |
| `EmptyState` | 15 | ~12 near-miss dashed boxes (different padding, no fill) plus ~20 bare "nothing here" lines |
| `PaginationFooter` | 4 | 1 custom Previous/Next strip, 2 "Load more" buttons, 1 in-place "Show all"; most lists unpaginated |
| `ExpandableTable` / `.admin-table` | 7 | only 7 `<table>` elements exist at all; ~30 div/card "list of things" shapes elsewhere |
| `Notice` | 20 | ~12 hand-rolled tone banners (4 warning boxes byte-identical to `Notice tone="warning"`) |
| `Pill` | 66 | ~15 hand-rolled chips; 9 independent status→tone maps; 5 bare-coloured-text "status" spans |
| `SectionLabel` | 54 | the uppercase label string `tracking-[0.16em] text-[color:var(--tx3)]` is typed out in **29 files** |
| `FormFieldError` | 2 | ~40 error lines in 4+ shapes; roughly half missing `role="alert"`; `aria-invalid` wired nowhere else |
| `Switch` | 16 | 1 duplicate switch (`NotificationToggle`, 9 call sites), ~6 raw checkboxes for booleans, 1 button-pair toggle |
| `Dialog` | 9 | **11 hand-rolled modal shells**, 4 of them with no focus trap / Escape / `aria-modal` |
| `ConfirmDialog` | 6 | 4 two-click "arm" patterns, ~14 destructive actions with **no confirmation at all** |

Other repeated strings with no home: the bordered `divide-y … rounded-xl border`
list container (10 files), the inline 20px card `rounded-xl border … bg-panel`
(16 files), a "label / big value / small detail" stat tile (4 components + 9
inline copies), a bordered metadata tile `rounded border border-sep px-3 py-2`
(≥8 files across settings, apps, integrations), a "FactRow" `<dl>` row
(byte-identical in `TriggerDetail` and `WorkflowInstallationDetail`), and a
slide-in `aside` panel shell (identical in `AddWidgetPanel` and
`DashboardVersionsPanel`).

## 3. Inventory by element type

Each row: what the audits found, the verdict, and the canonical answer this
plan proposes. Line-level evidence is in the slice reports.

### 3.1 Body containers and sections

- Page bodies are `p-4` (governance, ops), `p-5` (`SettingsPanel`), `p-6`
  (projects, dashboards) or full-bleed, with six different max-widths across
  the seven **project tabs alone** (`max-w-2xl`/`3xl`/`4xl`/`[1040px]`/none)
  and five gap values. Detail panes in the column-browser pages all use
  `grid max-w-3xl gap-5`, copied four times.
- Three card systems: `.admin-card` (12px, 65 files), the inline `rounded-xl`
  string (20px, 16 files — a *deliberately separate* card per the stylesheet's
  own comment at `styles.css:1939-1971`, after two reverted merges), and
  `.create-channel-panel` (14px, the dialog panel). Plus `.glass-panel` for the
  auth screens, `rounded-lg` nested cards in billing, and `rounded` (4px)
  inner tiles in settings/integrations.
- **Nested containers.** Cards inside cards, or bordered boxes inside cards,
  in eight files: the five billing panels (22 `rounded-lg border` boxes inside
  `admin-card` section wrappers), `ConnectionCard` (a `<dl>` of bordered
  tiles inside a card), `StatusesPage` (bordered schedule/rule boxes inside
  cards), `ExecutorDetailPanels`, `IntegrationsPage` (stat tiles inside the
  product card), `SettingsProfilePage` (three `admin-card p-3` boxes inside an
  `admin-card p-4` section) and `NotificationsPage` (card rows inside the
  muted-channels card). Tables inside cards in two: the to-do step tables in
  `TodoInstanceCard` and `TodoTemplateCard`. No table-inside-table exists.
- Section headings inside bodies: `SectionLabel` in ~54 files, but the
  `0.16em` label string in 29 files, `0.18em` hand-rolled in 4 files (three
  carry the *same* comment explaining `SectionLabel` cannot express it),
  `0.14em` and `0.12em` in a handful, `tracking-wide` in executors, and bare
  `h2`/`h3` at three different sizes.

**Verdict: many variants. Canonical:** `PageBody` (width tier + padding + gap)
and `Card` (see §4). One radius per container role. `SectionLabel` gains the
size the 29 copies actually want (§4.2).

### 3.2 Tables and data lists

- Real tables: 7. `ActiveSessionsTable`, `SecretMetadataTable`, `AgentsTable`,
  the two to-do step tables and the dashboard table widget. Even these differ:
  one adds an outer `TableFrame`, one hides columns responsively while its
  sibling pins `min-w-[46rem]`, one uses skeleton rows while its sibling uses a
  text row, and the dashboard table skips `.admin-table` zebra entirely.
- Everything else is a div list, in at least **six** row shapes: `admin-card
  p-3` rows (members, invitations, audit, policy, approvals), `divide-y`
  bordered containers with `border-l-2` accent-selected rows (triggers,
  workflows, tools — 5 verbatim copies), `hoverCardClass` links (statuses),
  bare `<ul>` hover rows (agents, attachments, zip entries), `dashboardRowClass`
  buttons (project overview — the one shared one), and `rowShell` `<li>`s
  (apps, duplicated inline in two sibling files). Knowledge base reimplements
  the whole column browser (`KnowledgeColumns.tsx`) instead of using the shared
  `ColumnBrowserViewport/Column/Item`, down to the same `h-[50px]` header.
- No sorting, selection or sticky header conventions exist anywhere; numeric
  alignment and `font-mono` on numbers are decided per file.

**Verdict: many variants. Canonical:** `DataTable` for tabular data (thin
column-definition wrapper over `ExpandableTable` + `.admin-table`, with
skeleton, numeric alignment and an actions column built in) and `RowList` +
`Row` for entity lists (§4.3). Knowledge's column browser migrates to the
shared one (a resize handle is the one feature the shared primitive lacks and
the likely reason for the fork — add it there).

### 3.3 Pagination and loading more

`PaginationFooter` is faithful where used (agents list + detail). Elsewhere:
`FeedbackList` ships a custom Previous/Next strip that its own comment declares
deliberately non-shared; `ThreadsPage` and `AppCategorySection` hand-roll
"Load more"; `AppCategorySection` also has a plain-link "Show all N"; most
lists that can grow (delivery history, statement lines, tool registry,
triggers, secrets, members) simply do not paginate.

**Verdict: two variants plus absence. Canonical:** `PaginationFooter` gains a
`mode="loadMore"` (one centred secondary button with the same label slot), and
the "Show all" affordance becomes `SectionOverflowHint` (already exists in
project dashboard) promoted to shared.

### 3.4 Forms

- Label markup, four shapes: label-wraps-control with bare text (settings,
  budgets), label-wraps-control with a `<span>` (push, integrations, editor),
  `htmlFor`/`id` siblings with an uppercase micro-label (dialogs, designer,
  triggers), and no visible label at all (`PolicyPage` create-rule form, the
  four `StatusesPage` forms, telemetry selects, several inline "add a named
  thing" inputs). Two `fieldLabelClass` constants with the same name and
  different values exist (`trigger-config.ts` 12px/0.16em vs
  `WorkflowNodeInspector.tsx` 11px/0.14em).
- Controls: `.admin-input` is well adopted (69 files) but `AppSearchInput`,
  `AppCategorySelect`, `AddWidgetPanel`, `MemberManagementPopup`'s search, the
  KB new-folder input and `DashboardsPage`'s search each re-derive it by hand
  (different radius, no focus ring). Two dense variants compete:
  `.admin-input-compact` (13 files) and `.admin-input-sm` (1 file, which stacks
  an inert `text-xs` on it).
- Booleans: `Switch` in 16 files, a duplicate `NotificationToggle` with raw
  `text-white`/`bg-white`, raw checkboxes for on/off settings in
  `SpaceSettingsDialog`, `BudgetManager`, `IntegrationsPage`,
  `AgentDesignerForm` (same form also uses `Switch`), and a two-button toggle
  in `ProjectSettingsPage`. Segmented single-select is copy-pasted as a
  button row three times in integrations, as radio cards in appearance, as
  ring-selected buttons in `CreateSpaceDialog`, and as solid-fill buttons in
  `VersionHistory`.
- Required markers: none, anywhere. Help text: placeholder-as-instructions in
  several forms. Footer placement: right-aligned in dialogs (consistent),
  left-aligned `justify-self-start` in page forms (mostly consistent), one form
  saves from the page header, one wraps Save/Test/Remove in one row.
- Save model: explicit save everywhere except appearance (autosave), avatar,
  muted channels, story points, iteration move, column rename and board style
  (silent autosave), with no visual cue which is which.

**Verdict: many variants. Canonical:** the form kit in §4.4.

### 3.5 Validation and field errors

`FormFieldError` is used by two files (the channel dialogs). Everywhere else
errors are bare paragraphs in four shapes (`text-xs`/`text-sm`, with/without
`role="alert"`, with/without margin), a boxed banner, or — in `PolicyPage`,
`AgentAvailableTools`, `ConnectionCard`, `CreateProjectDialog` — no error
surface at all, so a failed mutation is silently swallowed. `aria-invalid`
and `aria-describedby` appear only in those two files. **13 sites** colour
error prose with `--danger` (the fill token) instead of `--danger-text`.
Validation timing is consistently submit-time, which is correct.

**Verdict: many variants. Canonical:** `FieldError` (the one visual, built on
`renderFieldError`) and `FormError` (form-level, `Notice tone="danger"
role="alert"`), both mandatory wherever a mutation can fail (§4.4).

### 3.6 Feedback after actions

Success is almost never announced: dialogs close, lists refetch, and the
person infers. Where feedback exists it is `FeedbackBanner`/`Notice` (settings,
triggers), toasts (to-dos, run continue), a persistent neutral line
(`PricingManager`, `WorkspaceAvatarPanel` — success rendered in the same grey
as help text), or `PushResultBanner`, a knowingly-deferred fork of `Notice`.
Four warning banners are byte-identical to `Notice tone="warning"` and one of
them (`OperationalTelemetryPage`) does not render its tint at all because
`.admin-card` beats the override — a visible bug. `Notice` has no `info` tone,
which is the stated reason `ConnectProgress`, `ReviewPanel`,
`PersonalAssistantSurface` and `DeepWaterResearchLauncher` hand-roll theirs.

**Verdict: many variants. Canonical:** `Notice` gains `info` and `neutral`
tones; rule: outcome of a submit renders inline under the form as a `Notice`;
a toast only when the surface that triggered the action is no longer on
screen (§4.5).

### 3.7 Loading, error and empty states

The widest gap. `QueryState` covers 12 files; the audits counted ~60
hand-spelled triads, with padding ranging `py-3`…`py-16` for the same sentence
and the ellipsis sometimes three dots. More importantly, the audits found
**real bugs of the exact kind `QueryState` was written to prevent**:

- Fetch failure renders as an empty list: `TriggerListColumn`, `WorkflowsPage`
  template list, `DashboardVersionsPanel`, `SettingsProfilePage` (org/team/
  provider), `ProjectBacklogTab`, `ProjectInsightsTab`, `ProjectSettingsPage`,
  `StatusesPage`, `NotificationsPage` channels.
- Loading and empty indistinguishable: `ProjectBacklogTab` ("No sprints yet"
  before data arrives), `StatusesPage`, ops/budget pages (render zeros while
  loading).
- Loading and not-found conflated: `DashboardDetailPage`.
- No `isError` branch at all, would crash on error: `WorkflowRunDetail`.
- No loading state while a query is in flight: `SearchPage`.
- Retry offered almost nowhere outside `QueryState`.

Skeletons are legitimately different (`AgentsTable`, `ActiveSessionsTable`,
`AppSkeletons`, `DashboardSectionCard`, `EmbeddedWidget`, `WidgetFrame`) but
there are six of them with no shared `Pulse`.

**Verdict: many variants. Canonical:** `QueryState` stays the one triad; add a
`Skeleton` primitive for surfaces that earn one; `EmptyState` gains optional
`title` and `action` (the "empty with CTA" card exists in four slices).

### 3.8 Status chips and badges

`Pill` is the best-adopted primitive (66 files) and its own doc comment
already lists the known holdouts. Beyond those: three local tone tables in
apps (`app-trust.ts`, `KIND_PILL_TONE`, the kind span), four in dashboards
(`toneVars`, `stateDot`, `WidgetPlaceholder`, `STATE_TONE`), four status→dot
maps in automation plus a dead third mapping in `workflows/presentation.tsx`,
`getStatusTone` duplicated in `AgentDetailPage`/`AgentDetailDrawer`, and
`ToolBadge`/`ToolCategoryIcon` maintaining the same ramp twice. KB page status
is bare coloured text with no chip at all. Seven billing chips and one
executor chip are border-only and say so ("Unconverted: Pill has no outline
tone"); `DeepWaterRunHistory` needs a fixed 24px height `Pill` lacks.
`uppercase` defaults on in some settings pills and off in adjacent ones.

**Verdict: two variants plus map sprawl. Canonical:** `Pill` gains `outline`
(border-only) and `info` tones and a `height="control"` option; every domain
keeps **one** `*-presentation.ts` tone map (the `todos/todo-presentation.ts`
pattern) that returns `{ tone, dotClass }` so pills and dots agree.

### 3.9 Detail and key-value views

Zero shared component. Shapes found: `<dl>` bordered rows (apps overview),
`<dl>` boxed panel with stacked pairs (connect review), `FactRow` `<dl>` in a
`divide-y` container (triggers, installations — byte-identical, two files), a
2-column `<dl>` grid (tool drawer), "Label: value" prose (executors, PA
surface), `PushStatusRow` flex rows, `fieldLabelClass` boxes (profile),
stacked `<div>`s (bootstrap, version history), and four stat-tile components
(`Stat`, `CreditCard`, `SummaryCard`, nine inline copies) at three value sizes
and two radii.

**Verdict: many variants. Canonical:** `KeyValueList` (`layout="rows"|"grid"`,
semantic `<dl>`) and `StatTile` (§4.6).

### 3.10 In-body filters, search and toolbars

Triggers and tools share one good idiom: `admin-input` search on top, `TabBar`
for the primary dimension, compact selects for secondary ones. Apps has one
sticky toolbar built from primitives. Elsewhere: `AuditLogPage` keeps a text
filter in-body while `AlertsPage`/`ThreadsPage` moved the equivalent toggle
into the page header; `ExecutorsPage`, members, statuses, connections and
secrets have unbounded lists with no filter. Count summaries appear in five
phrasings (`Label (N)`, `title · N`, `N total`, `N of M granted`, `N shown`).

**Verdict: two variants. Canonical:** `ListToolbar` (search + filters +
count slot) placed in-body above the list. Whether a filter lives in the body
or in the header is a boundary with the navigation session — see §7.

### 3.11 Typography and spacing

Muted-text usage is actually disciplined (`--tx2` prose, `--tx3` meta) with a
few slips (`--muted` in `SubAgentTree`, `--tx2` labels in `PageEditor`).
Everything else is unscaled: six tracking values for uppercase labels, text at
`10px`/`11px`/`xs`/`sm`/`base`/`lg`/`xl`/`2xl`/`3xl` with no tiering, card
padding `p-3`…`p-6` by taste, five radii for containers, and two authoring
conventions for the same token (`text-[color:var(--x)]` in apps,
`text-[var(--x)]` in integrations, `style={{ color: 'var(--x)' }}` across
**15 files**, nearly all dashboards). Raw colours, all defects per
`CLAUDE.md`:

- `WorkflowNodeInspector.tsx` / `WorkflowSamplePicker.tsx`: a whole
  light-only palette (`bg-white`, `border-black/10`, `#433349`, `#7445c7`,
  `#faf7fc`, `amber-*`, `emerald-*`, `red-*`).
- `ExecutorsPage.tsx:34-36`: `text-emerald-600`, `text-amber-600`.
- `IntegrationsPage.tsx:101-104`: four hex product accents.
- `notification-preference-controls.tsx`: `text-white`, `bg-white`.
- `UoaBillingRecurringAddonsPanel.tsx`: `bg-black/40` scrim;
  `SecretCaptureDialog.tsx`: `bg-black/50` scrim.
- `ExecutorWorkspacePromotionsPanel.tsx:39`: `var(--border)` — **the token
  does not exist**; the border falls back to the browser default.
- `styles.css:1299`: `rgba(0,0,0,.35)` tooltip shadow.
- Deliberate and to be documented as exceptions if kept: `.kb-reader`'s paper
  palette, `ColoursPanel` swatches, `PhoneBackButton` (nav).

**Verdict: many variants. Canonical:** a written scale (§4.7) plus lint rules
(§6, Phase 0).

### 3.12 Destructive and confirm flows

`ConfirmDialog` is used in six files and is exemplary where used (apps
remove/disconnect, iteration/column delete). Against that: a nested
hand-rolled confirm dialog in `ChannelSettingsDialog` beside a two-click
toggle three lines later; two-click "arm" patterns in `StatusesPage`,
`ConnectionCard` (`DangerButton`), `TriggerDetail`, `DocumentStreamDialog`; and
**no confirmation at all** for: policy rule delete, budget delete, pricing
delete, secret revoke, session revoke, push credential remove, avatar remove
(×2), task cancel, to-do template archive, to-do cancel, attachment/version
delete, external-agent deactivate, end call. Eleven modal shells bypass
`Dialog`; four (`FileVersionUploadDialog`, `AddonCancellationDialog`,
`CircleImageCropper`, `ExecutorRunLauncherDialog`'s scrim) lack the focus
trap, Escape or drag-safe dismiss the shell exists to guarantee.

**Verdict: many variants. Canonical:** every irreversible action goes through
`ConfirmDialog`; every centred modal through `Dialog`, which gains the one
missing geometry (`TriggerEditorDialog`'s 680px).

## 4. The proposed content system

Design rules, in order of precedence:

1. **Extend, never fork.** Where a primitive exists and lacks one prop, the
   prop is added to the primitive. The self-documented "Not X because…"
   comments are the backlog, and each one closes by deleting the comment.
2. **One component per job, parameterised by scope** (Rule zero, check 4).
3. **Atoms in `components/primitives/`, composites in `components/shared/`**,
   as today. No new top-level directory; the kit is a catalogue, not a
   package.
4. **Tokens only.** No raw colour, no Tailwind named colour, no inline
   `style={{ color: 'var(--x)' }}`; one arbitrary-value spelling
   (`text-[color:var(--x)]`, the majority form).
5. **Every fetch surface has all three states, and error has Retry.** Every
   mutation surface has a visible failure state with `role="alert"`.
6. **Every irreversible action confirms.**
7. **No nesting. A card never contains a card; a table never contains a
   table; a bordered box never sits inside a bordered box.** A card is a
   leaf: its contents are flat rows, text, a key-value list or controls,
   separated by dividers and spacing, never by another frame. A section of a
   page is delimited by a `SectionLabel` and vertical rhythm, not by wrapping
   everything in a card. A table stands on its own with its own frame; an
   expanded table opens in the `ExpandableTable` dialog, never inside another
   table. The audits found the nested shape in eight files today (§3.1) and
   it is the main reason "admin" and "documents" read as different products:
   one nests boxes three deep, the other draws none.

### 4.1 Layout

| Component | Replaces | Notes |
|---|---|---|
| `PageBody` (`width="narrow"\|"regular"\|"wide"\|"full"`) | six project-tab wrappers, `p-4`/`p-5`/`p-6` bodies, `grid max-w-3xl gap-5` ×4 | narrow = `max-w-2xl`, regular = `max-w-3xl`, wide = `max-w-5xl`; padding `p-5`, gap `gap-6`. Sits *below* whatever header the navigation session produces. |
| `Card` (`variant="section"\|"row"`, `tone="default"\|"attention"`) | `.admin-card` (kept as the CSS), the 20px inline string (16 files), the accent-bordered executor cards | section = `.admin-card p-4`, row = `.admin-card p-3`. **A `Card` refuses to render inside another `Card`** (a dev-mode context check, mirroring how `Dialog` owns its shell). There is no tile variant: the nested `rounded-lg`/`rounded` boxes in billing, connections, statuses, integrations and profile become `KeyValueList` rows, `StatTile`s laid out in a grid *beside* each other, or divided `Row`s, all flat inside the one card. Migrating the 16 inline panels is a **visible 20→12px change** and lands as its own pinned PR per the stylesheet comment. |
| `Section` (`SectionLabel` + `gap-3` body, no frame) | the habit of wrapping every page section in a card | the default grouping; a `Card` is used only when a block must read as one object (a row, a stat, a dialog panel, a form in a settings page). |
| `SidePanel` | `AddWidgetPanel` / `DashboardVersionsPanel` `aside` shells | header + close + scroll body. |
| `DetailPane` | the four `grid max-w-3xl gap-5` detail bodies | `PageBody width="regular"` with `SectionLabel`-headed sections; may collapse into `PageBody`. |

### 4.2 Labels

`SectionLabel` gains `size="sm"` = `text-xs tracking-[0.16em]` (the value 29
files actually type) and a `FieldLabel` sibling for form labels (same look,
renders `<label htmlFor>`, optional `(optional)` suffix and required marker).
The `0.14em`/`0.12em`/`tracking-wide` outliers are migrated onto `sm` or
`2xs`; the two `fieldLabelClass` constants are deleted.

### 4.3 Lists and tables

| Component | Replaces |
|---|---|
| `DataTable` — column defs `{ key, header, align, width, render }`, `rows`, `rowKey`, optional `actions`, `skeletonRows`, `expandable` (wraps `ExpandableTable` + `.admin-table`) | the 7 tables' divergent frames/skeletons/header cells; the dashboard table widget's missing zebra. Owns its own frame and never renders inside a `Card`: the two to-do cards become a flat header (title, pills, actions) above a standalone `DataTable`. |
| `RowList` (`divided`, `bordered`) + `Row` (`leading`, `title`, `subtitle`, `meta`, `trailing`, `selected`, `depth`, `href`/`onClick`) | the 10 `divide-y` containers, the 5 `border-l-2` selectable rows, `admin-card p-3` rows, `rowShell`, `hoverCardClass`, `KnowledgeItemRow`, attachment/zip rows, member rows, `dashboardRowClass` |
| `SectionOverflowHint` (promoted from projects) | "…and N more", "Show all N" |
| `PaginationFooter mode="loadMore"` | the two Load-more buttons, `FeedbackList`'s strip |
| Shared `ColumnBrowser*` gains a resize handle | `KnowledgeColumns.tsx` |

### 4.4 Forms

| Component | Replaces |
|---|---|
| `FormField` (`label`, `htmlFor`, `help`, `error`, `required`) — composes `FieldLabel`, the control, help text and `FieldError`; wires `aria-invalid`/`aria-describedby` via `fieldErrorAria` | four label shapes, unlabeled fields, placeholder-as-help |
| `Input` / `Select` / `Textarea` (`size="default"\|"compact"`, `mono`, `leading` icon slot) — thin wrappers emitting `.admin-input` classes | the five hand-rolled input look-alikes; `.admin-input-sm` is retired in favour of `compact` (one caller) |
| `Checkbox` (themed, `accent-[var(--accent)]`) | the unthemed raw checkboxes; **`Switch` for on/off settings, `Checkbox` for pick-many** is the rule |
| `ChoiceGroup` (`variant="segment"\|"card"`, single-select, `role="radiogroup"`) | the three copy-pasted button rows, the appearance radio cards, `CreateSpaceDialog`/`VersionHistory` pickers, `ProjectSettingsPage`'s button pair, `AddWidgetPanel`'s tone picker |
| `FormActions` (`align="end"\|"start"`) | footer drift; rule: `end` in dialogs (Cancel + primary), `start` for inline page forms (primary only) |
| `FieldError` (= `renderFieldError`, the boxed line) and `FormError` (= `Notice tone="danger" role="alert"`) | ~40 bare error lines; the 13 `--danger` text sites |
| `NotificationToggle` deleted; `PushResultBanner` deleted | duplicates of `Switch` and `Notice` |

Required-marker and autosave cue are two small conventions to add: `*` after
a required `FieldLabel`; an autosaving control shows a transient "Saved"
`Notice tone="neutral" size="sm"` or the `Switch`'s own pending state, so a
person can tell autosave from explicit save.

### 4.5 Feedback and states

- `Notice` gains `tone="info"` and `tone="neutral"`; `role="alert"` for
  failures, `role="status"` for successes.
- `QueryState` unchanged in contract; adoption is the work. A list surface
  with a skeleton uses `Skeleton` (one `Pulse` primitive with `rows`/`shape`)
  and still routes error/empty through `QueryState`.
- `EmptyState` gains `title` and `action` (secondary button) props.
- Toasts (`useToasts`) are reserved for outcomes whose triggering surface is
  gone (dialog closed, navigated away). Inline `Notice` otherwise.

### 4.6 Detail views

- `KeyValueList` (`items: {label, value, mono?}`, `layout="rows"|"grid"`,
  `bordered`) renders a semantic `<dl>`; replaces every shape in §3.9.
- `StatTile` (`label`, `value`, `detail`, `tone`) replaces `Stat`,
  `CreditCard`, `SummaryCard`, the nine inline copies and the apps/integrations
  stat boxes.
- `CopyField` (from `TriggerDetail`) promoted to shared.

### 4.7 Scale (to be written into `styles.css` as the header comment of the
content section, and into `CLAUDE.md`)

- Radius by role: card 12px (`.admin-card`), dialog panel 14px, chip
  `rounded` (4px) or capsule. Nothing else, and never one inside another.
- Padding by role: card section `p-4`, card row `p-3`, list row
  `px-3 py-2.5`, page body `p-5`, dialog panel 24px (fixed). Depth is
  expressed with dividers (`divide-y --sep`) and spacing, never with a second
  border.
- Type by role: page hero `text-2xl` (navigation session's call), section
  title `text-sm font-semibold`, label `SectionLabel`/`FieldLabel`, body
  `text-sm --tx2`, meta `text-xs --tx3`, stat value `text-2xl font-semibold`.
  `text-[10px]`/`text-[11px]` only inside `Pill`/`SectionLabel 2xs`.
- Tracking: only the three `SectionLabel` sizes (`0.2em`, `0.18em`, `0.16em`)
  and `Pill`'s `0.16em`.
- Tokens: `--danger-text`/`--success-text`/`--warning-text`/`--info-text` for
  prose, never the fill token; `--sep` for borders, `--border-strong` only on
  focused/hovered controls; one relative-time formatter
  (`workflows/presentation.ts`'s, moved to `lib/`).

## 5. Bugs found on the way (fix regardless of the system)

Functional, not stylistic; each is cited in the slice reports.

1. Fetch failure shown as "empty" (nine surfaces, §3.7) and `WorkflowRunDetail`
   with no error branch.
2. `OperationalTelemetryPage` warning banner never renders its tint.
3. `ExecutorWorkspacePromotionsPanel` references the undefined `--border`.
4. Four modals without focus trap / Escape / `aria-modal`
   (`FileVersionUploadDialog`, `AddonCancellationDialog`,
   `CircleImageCropper` — no scrim dismiss, `ExecutorRunLauncherDialog` — raw
   `onMouseDown` dismiss).
5. ~14 destructive actions with no confirmation (§3.12).
6. Roughly half of all mutation error lines lack `role="alert"`; 13 use the
   wrong danger token.
7. `ThreadsPage.tsx:61` `admin-button-secondary` without the `admin-button`
   base class.
8. `NotificationToggle` raw `bg-white` thumb; `IntegrationsPage` raw hex
   accents; the workflow-designer inspector's light-only palette.
9. Dead code: `runStatusClass`/`stepStatusClass` in
   `workflows/presentation.tsx`; `ColumnBrowserItem` unused by knowledge.

## 6. Migration plan

Ordered so that each phase is independently mergeable and each PR is small
enough to review by eye. Counts are approximate and come from the reports.

**Phase 0 — stop the bleeding (1 PR).** ESLint rules, all erroring: no
Tailwind named colours or hex in `admin/src` outside `styles.css` and the two
documented exceptions; no `style={{ … var(--` for colour; no `var(--danger)`
et al. in a `text-` utility; no literal `uppercase tracking-[` outside
`SectionLabel`/`Pill`; `role="dialog"` only inside `Dialog`/`ConfirmDialog`
and the documented exceptions. Nesting is enforced at runtime rather than by
lint, because a lint rule cannot see across component boundaries: `Card` and
`DataTable` each throw in development when rendered inside a `Card`. Fix the ~12 raw-colour sites and the `--border`
reference in the same PR so it lands green.

**Phase 1 — close the primitive gaps (1–2 PRs, no call-site changes).**
`Notice` info/neutral; `Pill` outline/info/height; `SectionLabel sm` +
`FieldLabel`; `PaginationFooter loadMore`; `EmptyState title/action`;
`Dialog` 680px size; `Skeleton`; `Checkbox`; `ChoiceGroup`; `FormField` +
`FormError`; `Input/Select/Textarea`; `KeyValueList`; `StatTile`; `RowList/Row`;
`DataTable`; `PageBody`/`Card`; `SidePanel`; `ListToolbar`. Each ships with a
node test and a Playwright screenshot of a kitchen-sink route under
`/settings/appearance` (already the design-system home).

**Phase 2 — mechanical adoption by category (one PR per row, cross-slice).**

| Sweep | Approx. sites | Risk |
|---|---|---|
| Error lines → `FieldError`/`FormError` (+ `role="alert"`, token fix) | ~40 | low |
| Loading/error/empty → `QueryState`/`EmptyState`/`Skeleton` | ~60 | low; fixes §5.1 |
| Uppercase label strings → `SectionLabel sm`/`FieldLabel` | 29 files | low |
| Hand-rolled chips + tone maps → `Pill` + one `*-presentation.ts` per domain | ~25 | low |
| Hand-rolled banners → `Notice` | ~12 | low |
| Unconfirmed destructive actions → `ConfirmDialog` | ~14 | low, behaviour change is the point |
| Hand-rolled modal shells → `Dialog` | 11 | medium (a11y wins, geometry diffs) |
| Flatten nested containers: inner boxes → `KeyValueList`/`StatTile`/`Row`, tables out of cards | 10 files | medium (visible, screenshot every panel) |
| Raw checkboxes/toggles → `Switch`/`Checkbox`/`ChoiceGroup`; delete `NotificationToggle` | ~15 | low |
| `style={{ var }}` and `text-[var(` → `text-[color:var(` | 15 files | none (mechanical) |

**Phase 3 — surface-by-surface layout migration (one PR per surface).**
Order by user-visible inconsistency, which is also the order Ondrej named:

1. Project tabs → `PageBody` + `Card` + `RowList` (+ `Pill` for task status).
2. Knowledge base → shared `ColumnBrowser*`, `Row`, `QueryState`, `Pill` for
   page status, `FileVersionUploadDialog` → `Dialog`.
3. Settings (personal + org) → `FormField`, `KeyValueList`, `Card tile`,
   `ConfirmDialog`, `CircleImageCropper` → `Dialog`.
4. Integrations (the older half of apps) → `KeyValueList`/`StatTile`,
   `ChoiceGroup`, `Switch`, `Notice info`, launcher dialog → `Dialog`.
5. Ops, budgets, billing → `StatTile`, `RowList`, `Pill outline`, `Notice`,
   `ConfirmDialog`, addon dialog → `Dialog`.
6. Dashboards → `SidePanel`, `Pill`, `QueryState`, `Input`.
7. Automation → `RowList` for the 10 containers, `KeyValueList` for `FactRow`,
   executors and workflow-designer panels onto tokens,
   `TriggerEditorDialog`/`ExecutorRunLauncherDialog` → `Dialog`.
8. Governance → `RowList`, `QueryState`, `PaginationFooter loadMore`,
   `FormField` on `PolicyPage`/`FeedbackComposer`.

The 20→12px card unification (16 files) is its own PR inside Phase 3, with
before/after screenshots of every affected panel, as the stylesheet comment
requires.

**Phase 4 — delete the forks and document.** Remove retired classes
(`.admin-input-sm`, `.glass-panel` if auth adopts the kit), the file-local
`rowClass`/`sectionHeadingClass`/`fieldLabelClass` constants, the duplicate
formatters and tone maps; move this document to `docs/done/`; replace the
"Theming / design system" bullets in `CLAUDE.md` with the scale in §4.7 and a
one-line rule per component.

Each Phase 2/3 PR is verified with headless Playwright screenshots of every
touched route at `http://localhost:5455`, per `AGENTS.md`.

## 7. Boundary with the navigation session

Both sessions touch the same page files, so:

- This plan never edits `AdminPageHeader`, `ResponsivePageHeader`,
  `PageHeaderMenu`, `TabBar`, the sidebar/rail/topbar, `.admin-button*`, or the
  hand-rolled hero headers (`AgentsList`, `AgentDetailPage`, `ExecutorsPage`,
  `DashboardsPage`, `DashboardDetailPage`). `PageBody` is a body-only
  component and composes under any header.
- Two decisions straddle the line and need one owner: whether list filters
  live in the body (`ListToolbar`) or as header actions (`AlertsPage`,
  `ThreadsPage`, `NotificationsPage` Save); and the page hero type size.
  Recommendation: filters in-body, headers keep only actions.
- Phase 0 lint rules apply repo-wide and will flag `PhoneBackButton`'s raw
  colours; that file is theirs to fix or exempt.
- Sequence Phase 3 after the navigation session's header changes have merged
  on each surface, to avoid conflicting edits in the same files.

## 8. Decisions needed

Recommendations are stated; silence means the recommendation ships.

1. **One card radius or two?** Recommend one: 12px `.admin-card`, migrating
   the 16 inline 20px panels deliberately (Phase 3). The alternative is to
   name the 20px card `Card variant="panel"` and keep both.
2. **Form footer alignment.** Recommend the two-context rule (end in dialogs,
   start for inline page forms) rather than forcing one everywhere.
3. **Exceptions to keep and document:** `.kb-reader` paper palette,
   `ColoursPanel` swatches, the login/bootstrap glass shell. Recommend keeping
   the first two, and migrating login/bootstrap onto `Input`/`FormError`
   while keeping the glass card (the two pages share byte-identical constants
   today).
4. **`.admin-input-sm` vs `-compact`.** Recommend retiring `-sm` (one caller).
