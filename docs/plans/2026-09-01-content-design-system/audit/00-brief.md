# Nessie admin — content design-system audit brief

You are one of several auditors. Each auditor owns a slice of `admin/src` (given in your task). Your job is a **code-level inventory of content-element patterns** in your slice, so a later pass can unify them into one Bootstrap-style content system. This is a read-only audit: do NOT edit any file.

Repo root: `/home/user/Nessie`. Admin app: `admin/src`. Tailwind v4 + CSS custom properties; all colour tokens live in `admin/src/styles.css` (read the `.admin-table`, `.admin-input`, `.admin-input-sm`, `.admin-card`, `.admin-frame`, `.admin-sec-hdr`, `.admin-sec-row`, `.agents-table`, `.admin-expandable-table*`, `.admin-status-badge` rules there first — they are the existing baseline).

## Existing shared primitives (the baseline to compare against)

Read each of these once before auditing so you can say "uses X" vs "hand-rolls X":

- `admin/src/components/shared/PaginationFooter.tsx` — Previous / label / Next strip.
- `admin/src/components/shared/ExpandableTable.tsx` — the one table viewport (`.admin-expandable-table`).
- `admin/src/components/shared/QueryState.tsx` — loading / error+Retry / empty line triad.
- `admin/src/components/shared/EmptyState.tsx` — dashed empty card.
- `admin/src/components/shared/FormFieldError.tsx` — `fieldErrorAria`, `renderFieldError`, `fieldErrorProps`.
- `admin/src/components/primitives/Notice.tsx` — tone banner (danger/success/warning).
- `admin/src/components/primitives/Pill.tsx` — the one chip.
- `admin/src/components/primitives/SectionLabel.tsx` — uppercase dim section heading.
- `admin/src/components/primitives/Switch.tsx`.
- `admin/src/pages/settings/settings-shared.tsx` — `SettingsPanel`, `FeedbackBanner`, `sectionTitleClass`, `hoverCardClass`.
- `admin/src/components/shared/Dialog.tsx` + `ConfirmDialog.tsx` — the one modal shell.

## OUT OF SCOPE — do not report on these (another session owns them)

- Navigation: sidebar, rail, topbar, mobile tab bar, `AdminPageHeader`, `ResponsivePageHeader`, `PageHeaderMenu`, breadcrumbs, `TabBar` strips, page-title rows and their action buttons.
- Button *styling* itself (`.admin-button*`). You MAY report *where* buttons sit inside content (e.g. form footer placement, a table's action column) but not how a button looks.
- Chat: channel conversation feed, composer, message rows/bubbles, reply-thread panel, thinking bubbles, reactions, mentions.
- Canvas interactions (workflow designer graph, kanban drag). Their side panels / property forms ARE in scope.

## IN SCOPE — the categories to inventory (use these exact headings)

1. **Body containers & sections** — how page bodies wrap content: `admin-card`, `admin-frame`, bare `div`s, `glass-panel`, section spacing (`space-y-*`, `p-*`), section heading treatment inside the body (`SectionLabel`, `sectionTitleClass`, hand-rolled `h2`/`h3`), max-width, column layouts.
2. **Tables & data lists** — `<table>` (`.admin-table`? `.agents-table`? bare?), `ExpandableTable` or not, div/grid "tables", card lists, `<ul>` rows. Header cell style, row hover, density (row padding), numeric/right alignment, actions column, sorting/selection affordances, sticky header, responsive/overflow handling, zebra, borders.
3. **Pagination & loading more** — `PaginationFooter`, hand-rolled prev/next, "Load more" button, infinite scroll, cursor vs page number, page-size, label wording.
4. **Forms** — field layout (label above/inline, `<label>` vs bare text, help/description text, required marker), controls (`admin-input` / `admin-input-sm` / raw `<input>`/`<select>`/`<textarea>` with ad-hoc classes, checkbox vs `Switch`, radio), fieldset/grouping, form action row placement (bottom-right? left? sticky?), disabled/pending state, autosave vs explicit save.
5. **Validation & field errors** — `FormFieldError` helpers used or not, inline error markup (boxed vs bare red line), form-level error, when errors appear (submit vs keystroke), aria-invalid/describedby, `role="alert"`.
6. **Feedback after actions** — `Notice`, `FeedbackBanner`, hand-rolled banners, toasts, inline "Saved" text, transient vs persistent, placement (top of form vs beside button).
7. **Loading / error / empty states** — `QueryState`, `EmptyState`, bespoke skeletons, spinners, text-only, Retry present or not, wording (ellipsis style), for both lists and detail views.
8. **Status chips & badges** — `Pill` vs hand-rolled spans (`rounded-full`, `uppercase tracking`), `admin-status-badge`, tone mapping (status → colour) done locally.
9. **Detail / key-value views** — `<dl>`, two-column grids, "metadata" rows, label/value typography, how a detail page is composed vs a list page.
10. **In-content filters, search boxes & toolbars** — filter rows above lists, search inputs, select filters, date pickers, count summaries ("34 items"), where they sit relative to the table.
11. **Typography & spacing inside content** — heading sizes used in bodies, muted text token usage (`--tx2` vs `--tx3`), `text-xs`/`text-sm` mix, padding scale (`p-3`/`p-4`/`p-5`/`p-6`), gap scale, border radius scale (`rounded-md/lg/xl/2xl`), border tokens (`--sep` vs `--line` vs `--border-strong`).
12. **Destructive & confirm flows with forms in dialogs** — `ConfirmDialog` vs custom, form-in-Dialog layout, footer placement.

## Reporting rules

- Every finding cites `path:line` (relative to repo root) and quotes the actual class string or markup shape briefly. No vague "looks inconsistent" — say *what* differs from *what*.
- Prefer breadth: cover every file in your slice, but summarise repeats ("same pattern in 6 more files: a, b, c…").
- For each category end with a **one-line verdict**: `consistent` / `two-variants` / `many-variants` / `n/a in this slice`, plus which shared primitive (existing or missing) would resolve it.
- Note any file that is a GOOD model worth generalising, and any file that is the WORST offender.
- Note raw colours/hex or Tailwind named colours (`text-emerald-500`, `bg-black/20`) you stumble on — they are a defect per CLAUDE.md.
- Do not propose the full design system; that is the synthesiser's job. Do end with **"Top 5 unification wins for this slice"** (concrete: "8 hand-rolled prev/next strips → PaginationFooter").

## Output

Write your full report to the path given in your task (markdown, the 12 headings above in order, then the two closing sections). Then reply with a ≤15-line summary: files covered, the five wins, best model file, worst offender.
