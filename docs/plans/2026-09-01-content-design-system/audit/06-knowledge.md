# Knowledge base / documents — content design-system audit

Slice: `admin/src/pages/KnowledgeBasePage.tsx`, all 48 files under
`admin/src/components/features/knowledge/`, plus
`admin/src/components/shared/column-browser/*` (3 files) and
`admin/src/components/shared/AttachmentViewer.tsx`.

Files with no in-scope markup (pure logic/registries, checked and skipped from
further citation): `KnowledgeProvider.tsx`, `file-icons.ts`, `page-status.ts`,
`product-documents-registry.ts`, `example-page.ts`,
`useKnowledgePageDeepLink.ts`, `comments/useAnnotationActions.ts`,
`comments/useAnnotationAuthors.ts`, `notes/doc-text.ts`,
`notes/note-highlight-extension.ts`, `widget-embed/widget-embed-node.ts`,
`wikilink/wikilink-node.ts`, `wikilink/wikilink-suggestion.ts`,
`wikilink/use-wikilink-navigation.ts`, `KnowledgeViewToggle.tsx` (data only —
its rendering lives in the out-of-scope header-action row).
`RichTextContent.tsx` is the read-only ProseMirror renderer itself — out of
scope per brief ("not the ProseMirror editing itself"), noted only in passing.

---

## 1. Body containers & sections

Two competing "card with `h-[50px]` header" shells coexist for exactly the
same job (a titled scroll region), never unified:

- `admin-card` used as a column shell in `KnowledgeColumns.tsx:118` (`<div
  className="admin-card flex h-full flex-shrink-0 flex-col overflow-hidden">`)
  with its own hand-rolled `h-[50px]` header row
  (`KnowledgeColumns.tsx:119-123`, `border-b border-[color:var(--sep)] px-4`).
- The shared `ColumnBrowserColumn.tsx:54-55` primitive (used by
  Tools/Triggers/Workflows/Integrations pages) renders the **identical**
  shape — `border-r … bg-[color:var(--main)]` shell + `h-[50px] … border-b …
  px-4` header — but Knowledge does not import it. `KnowledgeColumns.tsx` is a
  from-scratch reimplementation of the same "titled column with scrollable
  body" container, right down to the `50px` magic number, not a variant using
  the shared one.
- `KnowledgePane.tsx:21` is a third titled-body shell (`flex h-full flex-col
  bg-[color:var(--main)]` + `ResponsivePageHeader` + `overflow-y-auto`), used
  for every full-width main-area view (editor, history, file/page preview,
  filesystem root). It is consistent within itself (good — every full-width
  KB screen goes through it) but is architecturally unrelated to
  `admin-card`/`ColumnBrowserColumn`.

Max-width / centering for reading surfaces is inconsistent: `PagePreview.tsx:99`
uses `mx-auto my-8 w-full max-w-3xl px-8 py-8` (plus the `.kb-reader` paper
class); `FileNodeViewer.tsx:115` uses `mx-auto my-8 w-full max-w-4xl px-4`
(no vertical padding, no reader-paper background); `KnowledgeWorkspace.tsx:332`
uses `mx-auto w-full max-w-3xl px-6 py-6` for version history;
`DeepWaterResearchView.tsx:35` uses `mx-auto w-full max-w-3xl px-6 pb-8`. Four
detail/document containers, four different `max-w-*`/padding combinations,
none sharing a constant.

Section-heading-inside-body treatment fragments into at least four shapes: a
few call sites correctly use `SectionLabel` (`VersionHistory.tsx:2,69`); most
hand-roll the near-identical `text-xs font-semibold uppercase
tracking-[0.16em] text-[color:var(--tx3)]` (`CreateSpaceDialog.tsx:60-63,
80-84, 108-113`, `SpaceSettingsDialog.tsx:97-101, 121-126, 174-179`); three
sites go further and hand-roll `tracking-[0.18em]` instead, each carrying the
**same verbatim code comment** explaining why: *"SectionLabel cannot express
tracking-[0.18em] at text-xs (xs is 0.2em, 2xs is 11px)"* —
`PagePreview.tsx:151-154`, `comments/CommentsSection.tsx:35-38`,
`backlinks/BacklinksPanel.tsx:26-29`. This is a self-documented primitive gap:
three independent authors hit the same missing `SectionLabel` size and wrote
the same workaround comment instead of adding it. A fourth tracking value,
`0.14em`, appears on status-text-as-label uses (`KnowledgeFilesystemRows.tsx:133,139`,
`PagePreview.tsx:191`). A fifth, `0.12em`, is on `AgentDraftBadge.tsx:9`.

**Verdict: many-variants.** Missing/needed primitive: a section-body titled
container generalizing `ColumnBrowserColumn`/`admin-card`-as-column, and a
`SectionLabel` size token that actually covers `0.18em`-at-12px (or the three
call sites should just take the existing `2xs` size, which is 11px/0.18em —
the comment's own arithmetic shows `2xs` already matches, but the sites keep
`text-xs` instead).

---

## 2. Tables & data lists

**No `<table>` element and no `ExpandableTable` appear anywhere in this
slice.** Every "list" is a hand-rolled `<div>`/`<button>` row or a `<ul>`.
Documents/files are not tabular data in this UI, which is a reasonable
product choice — but the row-rendering itself is reinvented at least five
separate times for the same "icon + title + trailing meta" shape:

1. `KnowledgeItemRow` (`KnowledgeFilesystemRows.tsx:89-153`) — the "real" row
   component, reused by column/tree/full-page views. `min-h-10`, chevron icon
   trailing, folder item-count or file/status badge trailing.
2. `ColumnBrowserItem.tsx:24-56` — the shared primitive with the *same*
   concept (title/subtitle/meta/chevron) but a card shape (`rounded-xl border
   p-3`) instead of a flat row — Knowledge never uses it despite owning the
   conceptually identical job.
3. `PagePreview.tsx:172-197` — a **fourth** sub-page row, hand-rolled again
   inline (`px-3 py-2.5` vs `KnowledgeItemRow`'s `py-2`, a literal `→`
   character instead of the `faChevronRight`/`faChevronDown` icon
   `KnowledgeItemRow` uses, no `min-h-10`).
4. `AttachmentsDrawer.tsx:88-134` — attachment rows as `<ul>`/`<li>`
   (`flex items-center gap-2 rounded-md px-2 py-2`), a fifth shape.
5. `ZipContents.tsx:46-90` — zip-entry rows as `<ul>`/`<li>` with
   `divide-y divide-[color:var(--sep)]` and its own `py-1.5` button row, a
   sixth shape, plus its own depth-indent scheme (`depthOf`) parallel to
   `KnowledgeItemRow`'s `depth * 18px` indent.
6. `KnowledgeSpaceList.tsx:33-72` — space rows via the sidebar's
   `.admin-sb-item` class (out-of-scope nav styling, noted only for
   completeness).

No row anywhere in this slice has selection checkboxes, multi-select, or a
sort affordance — none is needed structurally, but it means "row" here always
means exactly one interaction (click-to-open), so the six shapes above differ
for no functional reason.

Selection-highlight color choice is inconsistent: `ColumnBrowserItem.tsx:27-29`
paints the selected state with **`--success-border`/`--success-soft`** (a
semantic tone meaning "success", reused as a plain "selected" indicator);
`KnowledgeItemRow` (`KnowledgeFilesystemRows.tsx:113-115`) and
`KnowledgeColumns.tsx`'s selected-column tracking instead use
`--overlay`/`--tx` (neutral, no color meaning). One of these is a tone misuse.

**Verdict: many-variants.** Missing/needed primitive: one shared "browsable
item row" component (title/subtitle/leading-icon/trailing-meta/depth), which
`ColumnBrowserItem` is the closest existing candidate for but does not cover
the flat-row (non-card) shape Knowledge needs everywhere.

---

## 3. Pagination & loading more

**N/A in this slice.** Nothing here paginates — spaces, pages, attachments,
zip entries and comments are all rendered as complete lists with no
page/cursor control and no `PaginationFooter` usage. Nothing to unify.

---

## 4. Forms

Three distinct label treatments for the same "field label above a control"
job coexist within a few hundred lines of each other:

- **Uppercase micro-label + separate `<label htmlFor>`** —
  `CreateSpaceDialog.tsx:59-67` / `SpaceSettingsDialog.tsx:96-105`:
  `text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]`.
- **Sentence-case, label-wraps-input** — `PageEditor.tsx:71-78`:
  `<label className="text-xs text-[color:var(--tx2)]">Title<input …
  className="admin-input mt-1" /></label>` — no `htmlFor`/`id` pairing at all
  (implicit wrap instead), a different color token (`--tx2` not `--tx3`), no
  uppercase/tracking.
- **Bare `<span>` with no label semantics at all** —
  `PageEditor.tsx:99` (`Body`), `MemberChecklist`-adjacent usages.

Controls: `admin-input` is used correctly for text inputs/textarea
everywhere it appears (`CreateSpaceDialog.tsx:71`, `SpaceSettingsDialog.tsx:106,131`,
`PageEditor.tsx:73`). But checkboxes never use the `Switch` primitive: raw
`<input type="checkbox" className="accent-[var(--accent)]">` appears in
`SpaceSettingsDialog.tsx:144-154` (a boolean "Restrict editing" toggle — the
canonical `Switch` use case) and `MemberChecklist.tsx:51-56` (a real
multi-select checklist, where a checkbox is the right control — not a
`Switch` miss, just noted for contrast). The `writeRestricted` boolean in
`SpaceSettingsDialog` is exactly the kind of on/off setting `Switch` exists
for elsewhere in the admin, and reaches for a bare checkbox instead.

A new-folder inline text field (`KnowledgeFilesystemRows.tsx:196-213`) is a
raw, from-scratch `<input>` — `rounded border border-[color:var(--sep)]
bg-[color:var(--main)] px-2 py-1 text-sm … focus:border-[color:var(--accent)]`
— reimplementing (not reusing) what `.admin-input`/`.admin-input-sm` already
declare in `styles.css:1978-1993`, with a slightly different border-radius
mechanism (Tailwind `rounded` vs the CSS class's `border-radius: 8px`) and no
focus box-shadow.

Form action-row placement disagrees: `CreateSpaceDialog.tsx:125` and
`SpaceSettingsDialog.tsx:192` both right-align with `flex justify-end gap-2
pt-1`; `PageEditor.tsx:115` left-aligns the same Save/Cancel pair with plain
`flex items-center gap-2` (no `justify-end`). Save vs. Cancel button order is
consistent (primary first) but the row's horizontal position is not.

Save/submit vs. autosave: every form here is explicit-submit (a Save/Create
button), consistent throughout — no autosave surfaces in this slice.

Radio-like selection groups are hand-rolled buttons rather than native
radios or a shared control: `CreateSpaceDialog.tsx:88-105` (visibility
picker) uses `<button>` rows with a `ring-1 ring-inset ring-[color:var(--accent)]`
selected state; `VersionHistory.tsx:70-86` uses a *different* selected
treatment (`bg-[color:var(--accent)] text-[var(--on-accent)]` solid fill) for
conceptually the same "pick one of N" job. Two selected-state idioms for the
same interaction pattern.

**Verdict: many-variants.** Missing primitive: a labeled-field wrapper (label
+ optional help text + consistent `htmlFor`/`id` wiring) that would collapse
the three label treatments into one, plus routing the one real boolean
setting through `Switch`.

---

## 5. Validation & field errors

`FormFieldError` (`fieldErrorAria`/`renderFieldError`/`fieldErrorProps`) is
used **nowhere** in this slice — no `aria-invalid`, no `aria-describedby`, no
`role="alert"` on any error in the knowledge feature, despite five separate
hand-rolled error renderings:

- `PageEditor.tsx:114`: `{error ? <div className="text-sm
  text-[var(--danger-text)]">{error}</div> : null}` — appears after submit
  when title is empty, but the title `<input>` at `PageEditor.tsx:73` gets no
  `aria-invalid`/`aria-describedby` pointing at it.
- `SpaceSettingsDialog.tsx:116-118`: `<div className="text-xs
  text-[color:var(--danger-text)]">{formError}</div>` — a form-level error
  from a caught exception, `text-xs` this time (vs. `text-sm` above).
- `FileVersionUploadDialog.tsx:95`: `<p className="mt-3 text-xs
  text-[color:var(--danger)]">{error}</p>` — note the **token**: `--danger`
  here, not `--danger-text` like every other error in this slice (and not
  the theme's designated error-text token).
- `comments/CommentComposer.tsx:64`: `{error ? <p className="text-xs
  text-[var(--danger-text)]">{error}</p> : null}` — a fourth near-identical
  but independently-written rendering.
- Diff/version tone maps borrow danger/success/warning soft-fill tokens for
  non-error content (`VersionHistory.tsx:42-47`, `ReviewPanel.tsx:15-19`) —
  correct token reuse, not an error state, noted only because it is the same
  palette doing double duty.

None of the five error renderings above use `role="alert"`, none are wired to
their field via `aria-describedby`, and errors surface only on submit (no
keystroke validation) — consistent in *timing* even though not in markup.

**Verdict: many-variants** (five hand-rolled shapes, zero use of the shared
helper, one raw-token defect). Missing primitive: none missing —
`FormFieldError`'s `renderFieldError`/`fieldErrorProps` already solves this
and is simply unused here.

---

## 6. Feedback after actions

There is no success/"Saved" banner anywhere in this slice — saves close the
dialog/editor and return to the read view, which is itself a form of
feedback, so there's little to compare. The one persistent contextual banner,
`ReviewPanel.tsx:54` (`rounded-lg border border-[color:var(--accent)]/30
bg-[color:var(--overlay-weak)] p-4`), is a hand-rolled "info" tone that
`Notice` cannot currently express (`Notice`'s `NoticeTone` is
`danger|success|warning` only — no accent/info tone exists). It also uses a
Tailwind opacity-suffix on a CSS custom property (`border-[color:var(--accent)]/30`)
rather than a pre-mixed soft token like `--accent-soft`, which every other
soft-tint background in the codebase uses instead.

**Verdict: n/a in this slice** for After-save feedback proper; the one
contextual banner is a `Notice`-shaped gap (no accent/info tone) worth
flagging to the synthesizer.

---

## 7. Loading / error / empty states

This is the single largest source of duplication in the slice. `QueryState`
(loading/error+Retry/empty triad) is used **zero times** in the entire
knowledge feature. Every list/detail surface hand-rolls its own triad, and
almost none of them offer Retry:

- `KnowledgeWorkspace.tsx:305-307`: `Loading…` — `flex h-full items-center
  justify-center text-sm text-[color:var(--tx3)]`.
- `KnowledgeWorkspace.tsx:413-419`: two empty-state lines, `py-16
  text-center text-sm text-[color:var(--tx3)]`, no Retry (there is nothing to
  retry, but also no visual distinction from a loading state).
- `KnowledgeSpaceList.tsx:27`: empty state as `px-4 py-3 text-sm
  text-[color:var(--tx3)]` — no `text-center`, different padding again.
- `KnowledgeFilesystemRows.tsx:155-157` (`EmptyFolder`): `py-12 text-center
  text-sm text-[color:var(--tx3)]` — a fourth padding value for the same kind
  of message.
- `AttachmentsDrawer.tsx:81-86`: `px-1 py-6 text-center text-sm
  text-[color:var(--tx3)]` — a fifth.
- `MemberChecklist.tsx:28-34`: empty state as a bordered box (`rounded-lg
  border … bg-[var(--scrim-weak)] px-3 py-2 text-xs`) — the only one of these
  that's a box rather than bare centered text, and closest in spirit to
  `EmptyState.tsx`, but not using it (different radius token usage, `--scrim-weak`
  vs `EmptyState`'s `--overlay-weak`, `text-xs` vs `text-sm`).
- `FileNodeViewer.tsx:167,169,187,189,203`: **five separate** `py-12
  text-center text-sm text-[color:var(--tx3)]` "Loading preview…" /
  "Preview unavailable." lines within one component, none sharing a helper —
  each `previewKind` branch spells its own loading/error pair by hand.
- `ZipContents.tsx:16-18` (`note()`): a local helper reinventing exactly
  `QueryState`'s job (loading line / error line / oversize line) but without
  Retry and without the shared component — `py-12 text-center text-sm
  text-[color:var(--tx3)]` again.
- `ZipContents.tsx:76,78`: a nested loading/error pair for the inline text
  preview, `text-xs` this time, no padding/centering at all — an even smaller
  sixth/seventh variant inside the same file that already has its own `note()`
  helper.
- `ProductDocumentsView.tsx:19-26` and `DeepWaterResearchView.tsx:7-12`
  (`CenteredNote`): near-identical `mx-auto max-w-md px-6 py-16 text-center`
  placeholder blocks — the same shape reinvented twice, one with a title,
  one without.
- `PagePreview.tsx:126-143,166-167`: three more `text-sm
  text-[color:var(--tx3)]` states (loading body, empty body, empty sub-pages)
  with three different wrapper paddings (`mt-6`, `mt-6`, `py-4`).

None of the above offer a Retry action; only `ZipContents` and
`FileNodeViewer`'s text-preview states even distinguish "loading" from
"error" textually (most just show one sentence either way).

The one dashed-border "nothing here" box that resembles `EmptyState.tsx`
structurally is `FileNodeViewer.tsx:205`: `rounded-xl border border-dashed
border-[color:var(--sep)] py-16 text-center` — close to `EmptyState`'s
`rounded-xl border border-dashed border-[color:var(--sep)] bg-[color:var(--overlay-weak)]
p-5` but missing the background fill and using different padding, plus it
carries an icon + button `EmptyState` doesn't support.

**Worst offender for this category: `FileNodeViewer.tsx`** — five
independent loading/error/empty text renderings in one 229-line file, none
sharing a helper, plus a sixth dashed-empty-box variant.

**Verdict: many-variants.** `QueryState`/`EmptyState` exist and solve exactly
this, and are unused throughout the slice.

---

## 8. Status chips & badges

`Pill` is used correctly exactly once in this slice:
`comments/CommentThread.tsx:75-77` (`<Pill radius="chip" size="sm"
tone="muted">agent</Pill>`) — a good, small model of the intended usage.

Everything else hand-rolls:

- `AgentDraftBadge.tsx:6-15` — explicitly called out in `Pill.tsx`'s own doc
  comment (`Pill.tsx:36-42`) as one of four unconverted `--accent` chips that
  should be on `Pill`'s `accent` tone (`--thinking`) but isn't.
- Page status (`draft`/`published`/`archived`) is never a chip at all — it's
  bare colored **text**, `pageStatusTone` (`page-status.ts:3-7`) applied as
  `text-[10px] uppercase tracking-[0.14em] ${pageStatusTone[page.status]}`
  (`KnowledgeFilesystemRows.tsx:139`, `PagePreview.tsx:100-101,191`) — no
  background, no border, no pill shape, unlike every other status indicator
  in the admin baseline (`.admin-status-badge`). This is the KB's status
  indicator diverging from the baseline's badge shape entirely, not just its
  color mapping.
- Page labels/tags render as a hand-rolled chip: `PagePreview.tsx:116-121`
  (`rounded bg-[var(--overlay-weak)] px-2 py-1 text-xs text-[color:var(--tx2)]`)
  — structurally a `Pill radius="chip" tone="muted" uppercase={false}` but not
  using it (and `rounded` vs `Pill`'s `chip` radius, which is also plain
  `rounded`, so this one is actually a near-exact match to an unused prop
  combination).
- "file" / "agent" tag chips inline in rows: `KnowledgeFilesystemRows.tsx:133-135`
  (`text-[10px] uppercase tracking-[0.14em] text-[color:var(--tx3)]`, no
  background at all — text-only, not even a chip) vs.
  `KnowledgeSpaceList.tsx:62-70` (`rounded-full px-1.5 py-0.5 text-[10px]
  font-medium bg-[color:var(--overlay)] text-[color:var(--tx3)]` — a real
  pill shape, close to `Pill size="sm" tone="muted"` but `px-1.5` instead of
  `Pill`'s `px-2`, and not uppercase).
- `ZipContents.tsx:43-45` file-count header uses yet another uppercase-label
  treatment (`text-xs font-semibold uppercase tracking-[0.16em]`) that is
  functionally a section label, not a chip, filed here only because it
  competes with the same visual vocabulary.

**Verdict: many-variants.** `Pill` is the obvious existing primitive; the KB's
own status (draft/published/archived) needs a tone in it that doesn't exist
yet (draft=warning, published=success, archived=muted would map cleanly onto
`Pill`'s existing tones) and currently isn't a chip-shape at all anywhere in
this slice.

---

## 9. Detail / key-value views

No `<dl>` appears anywhere in this slice. Metadata is always ad hoc prose
inside a detail header:

- `FileNodeViewer.tsx:122-127`: icon + `<h1 className="truncate text-2xl
  font-semibold">` + one metadata line (`Version {n}`, `text-xs
  text-[color:var(--tx3)]`).
- `PagePreview.tsx:100-105`: status text + `AgentDraftBadge` on one line,
  `<h1 className="mt-3 text-3xl font-semibold">` (note: **`text-3xl`**, a
  full size step larger than `FileNodeViewer`'s `text-2xl` for the
  conceptually identical "document detail title"), then an optional summary
  paragraph.
- `VersionHistory.tsx:92-98`: a version's metadata as three stacked lines
  (`v{n}` bold / `date by author` / optional change comment) inside a
  `border-b … p-4` block — not a `<dl>`, not the two-column grid the brief
  calls out as a possible shape, just stacked `<div>`s.
- `VersionHistory.tsx:111-129`: the diff view *is* a genuine two-column grid
  (`grid min-w-[520px] grid-cols-2`) — the only real "two-column" detail shape
  in the slice, and it's a diff table, not a metadata `<dl>`.
- `ZipContents.tsx:43-45`: a one-line count summary standing in for a header
  above the list, styled as an uppercase section label rather than a detail
  field.

**Verdict: two-variants** (stacked-line metadata vs. the one genuine 2-column
diff grid) shading into **n/a** — this slice mostly doesn't have classic
key-value detail views because "detail" here means a rendered document, not a
record. No `<dl>` primitive exists to point at; none is obviously missing
either, since nothing here is really tabular metadata.

---

## 10. In-content filters, search boxes & toolbars

Out of scope per the brief for the page-header action row (view-mode toggle,
Needs-review filter, New page/folder, Upload, Space settings — all rendered
through `ResponsivePageHeader`/`PageHeaderMenu` via
`knowledge-workspace-actions.ts` and `FileNodeViewer.tsx:76-107`,
`PagePreview.tsx:59-91`). No search box, filter row, or count summary exists
*inside* the content body itself in this slice (the "Needs review (N)" count
lives in the header action, not the body). The one summary line that does
render in the body — `ZipContents.tsx:43-45`'s "N files in archive" — sits
directly above its list, which is the right position, just styled as a
section label rather than a distinct toolbar/count idiom.

`StorageUsageMeter.tsx:17-37` is a small inline usage-with-progress-bar
summary, rendered in the (out-of-scope) header area — noted only because its
progress-bar idiom (`h-1.5 w-16 rounded-full bg-[color:var(--overlay)]` fill
track) reappears independently in `FileVersionUploadDialog.tsx:76-81`
(`h-1.5 w-full … bg-[color:var(--overlay)]`) with matching height/track
tokens — this one **is** consistent, worth calling out as a small win
already in place.

**Verdict: n/a in this slice** (toolbars are out of scope; the one in-body
count line is a non-issue).

---

## 11. Typography & spacing inside content

- **Uppercase micro-label tracking has at least five values in play**:
  `0.12em` (`AgentDraftBadge.tsx:9`), `0.14em` (status text, `KnowledgeFilesystemRows.tsx:133,139`,
  `PagePreview.tsx:191`), `0.16em` (the majority — form labels, section
  headers, `ZipContents.tsx:43`, `notes/PageNotesLayer.tsx:171`), `0.18em`
  (the three `SectionLabel`-gap sites above), and `SectionLabel`'s own
  `0.2em`/`0.18em` pair. Six numbers doing one job.
- **Two mechanisms for applying the same CSS-variable colors**: the
  overwhelming majority use Tailwind arbitrary-value classes
  (`text-[color:var(--tx3)]` / `bg-[color:var(--sep)]`), but
  `widget-embed/WidgetEmbedView.tsx:16` uses a plain inline `style={{
  background: 'var(--overlay-weak)', borderColor: 'var(--sep)', color:
  'var(--tx2)' }}` object for the identical tokens — no functional
  difference, but a second idiom for the same thing.
- **`--tx2` vs `--tx3` usage is inconsistent for "secondary body text"**:
  `PageEditor.tsx`'s field labels use `--tx2` (`PageEditor.tsx:71,79,87,99`)
  while every other field label in the slice (`CreateSpaceDialog.tsx`,
  `SpaceSettingsDialog.tsx`) uses `--tx3`. Both are "label" text in a form,
  one shade darker in one file.
- **Padding scale around empty/loading text** ranges freely across
  `py-3`/`py-4`/`py-6`/`py-8`/`py-12`/`py-16` for what is semantically the
  same "nothing to show" sentence (see §7's citations) — no shared constant.
- **Border-radius scale**: `rounded` (chips, `PagePreview.tsx:117`),
  `rounded-md` (most buttons/rows), `rounded-lg` (`AttachmentsDrawer.tsx:66`
  drawer items' container, popovers), `rounded-xl` (`admin-card`,
  `KnowledgeItemRow`), `rounded-2xl` (`FileVersionUploadDialog.tsx:42,59`) —
  the full Tailwind scale is in play with no visible rule for which radius a
  given container class gets.
- **`kb-reader` (`styles.css:2795-2812`) hardcodes raw hex colors** (`#ffffff`,
  `#111827`, `#334155`, `#64748b`, `#d8dee8`, `#92400e`, `#166534`) rather
  than theme tokens, deliberately fixing the document-reading surface to a
  light "paper" look regardless of the active admin theme. This is very
  likely an intentional editorial choice (documents read like paper) rather
  than a bug, but it is exactly the kind of raw-hex the brief asks to flag —
  worth the synthesizer confirming it's deliberate and, if so, documenting
  the exception rather than leaving it silently divergent from "all colour
  lives in CSS custom properties."
- Inline error color token drifts once from the pack: `FileVersionUploadDialog.tsx:95`
  uses `text-[color:var(--danger)]` where every sibling error uses
  `--danger-text` (see §5).

**Verdict: many-variants.** No single missing primitive fixes this — it's a
scale-discipline problem (tracking, padding, radius) that a shared spacing/
typography token set (or stricter reuse of `SectionLabel`/`EmptyState`) would
narrow substantially.

---

## 12. Destructive & confirm flows with forms in dialogs

- `CreateSpaceDialog.tsx` and `SpaceSettingsDialog.tsx` both correctly use
  the shared `Dialog` shell (`Dialog.tsx` import at line 5/6 of each), with
  the form footer right-aligned inside it — the best-behaved dialogs in this
  slice.
- `FileVersionUploadDialog.tsx:33-109` is **not** the shared `Dialog` and
  says so in its own code comment (`FileVersionUploadDialog.tsx:34-36`: "Not
  the shared `Dialog`: a `rounded-2xl` / `--main` / `p-5` card … none of
  which the shell's `.create-channel-panel` chrome expresses"). Concretely,
  it is missing everything `Dialog`/`useModalA11y`/`useOverlayDismiss` exist
  to guarantee: no `role="dialog"`, no `aria-modal`, no focus trap, no
  Escape-to-close, and its scrim dismiss is a bare `onClick={onClose}`
  (`FileVersionUploadDialog.tsx:38-40`) rather than the drag-safe
  `useOverlayDismiss` gesture — precisely the "a drag released outside the
  panel discards an in-progress edit" bug class `useOverlayDismiss` was built
  to fix (per `AttachmentViewer.tsx`'s own use of it, and the CLAUDE.md
  `Dialog.tsx` entry). This is a genuine accessibility/UX regression, not
  just a style inconsistency.
- `AttachmentViewer.tsx:74-153` is also not the shared `Dialog` (by design —
  CLAUDE.md documents it as a deliberate exception, "the scroll-locking
  attachment viewer... deliberately not this component") but, unlike
  `FileVersionUploadDialog`, it *does* compose `useModalA11y` +
  `useOverlayDismiss` (`AttachmentViewer.tsx:46-47`) and does carry
  `role="dialog"`/`aria-modal` (`AttachmentViewer.tsx:91-92`) — so it gets
  the a11y contract right via the lower-level hooks even without the `Dialog`
  wrapper. `FileVersionUploadDialog` is the one custom modal in this slice
  that gets none of that.
- Small anchored popovers (`WikilinkCreateConfirm.tsx`,
  `notes/PageNotesLayer.tsx:139-146`'s note-composer aside,
  `wikilink/WikilinkSuggestionMenu.tsx`) are position-anchored, not centered
  modals, so `Dialog` genuinely doesn't fit them — these are a legitimate
  third category (anchored popover), consistent with each other
  (`rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] …
  shadow-[0_16px_40px_var(--scrim-strong)]` repeats verbatim across all
  three), and not a finding against `Dialog` itself.
- No true "destructive confirm" (delete-with-consequences) flow exists in
  this slice as a dialog — attachment/version deletes
  (`AttachmentsDrawer.tsx:126`) fire immediately on click with no
  `ConfirmDialog`, which may be an intentional low-stakes UX call (files can
  be re-uploaded) but is worth flagging since every other admin surface that
  deletes something reaches for `ConfirmDialog`.

**Verdict: two-variants** (one dialog correctly-built pair vs. one
genuinely-broken custom modal), plus a **missing use of `ConfirmDialog`** for
attachment/version delete. `FileVersionUploadDialog.tsx` is the clear worst
offender in this whole category across the slice.

---

## Good models / worst offenders

- **Best model**: `CreateSpaceDialog.tsx` and `SpaceSettingsDialog.tsx` — the
  only files in the slice using the shared `Dialog` shell correctly, with a
  right-aligned form footer and `admin-input` throughout. Not perfect (hand-rolled
  labels, no `FormFieldError`, checkbox instead of `Switch`) but structurally
  the closest to "do it right."
- **`comments/CommentThread.tsx`** is also worth calling out narrowly: it is
  the only file in the slice using `Pill` as intended (`radius="chip"
  size="sm" tone="muted"`, `CommentThread.tsx:75-77`).
- **Worst offender**: `FileVersionUploadDialog.tsx` — a hand-rolled modal
  with none of `Dialog`'s accessibility guarantees (no focus trap, no
  Escape, no `aria-modal`, drag-unsafe scrim dismiss), self-documented in
  its own comment as deliberately bypassing the shared shell.
- **Runner-up worst**: `FileNodeViewer.tsx` — five independent hand-rolled
  loading/error/empty text renderings in one file, none sharing a helper,
  none using `QueryState`.
- **Structural worst finding overall**: `KnowledgeColumns.tsx` — a complete,
  ground-up reimplementation of the multi-column drill-down browser pattern
  that `ColumnBrowserViewport`/`ColumnBrowserColumn`/`ColumnBrowserItem`
  already exist to serve (used by Tools/Triggers/Workflows/Integrations),
  down to matching magic numbers (`h-[50px]` header) arrived at
  independently.

---

## Top 5 unification wins for this slice

1. **Loading/error/empty text → `QueryState`/`EmptyState`.** ~15+ hand-rolled
   one-off renderings across `KnowledgeWorkspace.tsx`, `KnowledgeSpaceList.tsx`,
   `KnowledgeFilesystemRows.tsx` (`EmptyFolder`), `AttachmentsDrawer.tsx`,
   `FileNodeViewer.tsx` (5 in one file), `ZipContents.tsx` (its own `note()`
   helper reinvents `QueryState`), `ProductDocumentsView.tsx` +
   `DeepWaterResearchView.tsx` (duplicate `CenteredNote`), `PagePreview.tsx`
   (3 more) → one shared triad, most gaining a Retry they currently lack.

2. **`FileVersionUploadDialog.tsx` → the shared `Dialog` shell.** Currently
   the only modal in the slice with no focus trap, no Escape, no
   `aria-modal`, and a drag-unsafe scrim — a real a11y/UX bug, not just a
   style mismatch, and a one-file fix.

3. **Six reimplementations of the same "browsable row" → one shared row
   component.** `KnowledgeItemRow`, `ColumnBrowserItem` (already shared
   elsewhere but unused here), the inline sub-page row in `PagePreview.tsx`,
   attachment rows in `AttachmentsDrawer.tsx`, zip-entry rows in
   `ZipContents.tsx`, and space rows in `KnowledgeSpaceList.tsx` all render
   "icon + title + trailing meta," each with its own padding/indent/hover
   treatment.

4. **`KnowledgeColumns.tsx`'s hand-rolled column browser → the shared
   `ColumnBrowserViewport`/`ColumnBrowserColumn`/`ColumnBrowserItem` used by
   four other pages.** The single biggest structural duplication in the
   slice: a second, independently-built implementation of the exact same
   "drill into columns" interaction, including a hand-rolled resize handle
   the shared primitive doesn't even offer (worth checking whether that gap
   is why Knowledge forked instead of reusing).

5. **Page status (draft/published/archived) + page labels → `Pill`.** Status
   is currently bare colored text with no chip shape anywhere
   (`pageStatusTone`), diverging from the admin's `.admin-status-badge`
   baseline entirely; page labels are a hand-rolled chip one prop
   combination away from `Pill radius="chip" tone="muted" uppercase={false}`;
   `AgentDraftBadge` is already named in `Pill.tsx`'s own doc comment as an
   unconverted holdout.
