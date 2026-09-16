# Documents as a Finder — the browser

Part of [the Finder plan](overview.md). The screen itself: routes, layout,
the root column, folder and virtual columns, the row and its states, list
view, the toolbar with sort and view, keyboard and selection, moving by drag,
the phone, and theming. Menus and dialogs are in
[menus-and-dialogs.md](menus-and-dialogs.md); upload rows in
[uploads-and-indexing.md](uploads-and-indexing.md).

## 1. Routes and the registry

`admin/src/navigation/surfaces.ts` — Knowledge rows after this change. The
totality lint (`scripts/lint-navigation-surfaces.mjs`) fails the build until
`router.tsx` and this table agree.

| Pattern | type | depth | identity | notes |
|---|---|---|---|---|
| `/knowledge-base` | root | 0 | — | **`contextualList` removed**: the outlet is the root page on `single`. |
| `/knowledge-base/latest` | detail | 1 | `virtual:latest` | new; `parentOf: toKnowledge` |
| `/knowledge-base/shared-with-me` | detail | 1 | `virtual:shared` | new |
| `/knowledge-base/spaces/:spaceId` | detail | 1 | `space` (unchanged) | |
| `/knowledge-base/views/:productView` | detail | 1 | `view:<id>` (unchanged) | |
| `/dashboards`, `/dashboards/:id` | unchanged | | | |

`KNOWLEDGE_INTENT` becomes:

```ts
const KNOWLEDGE_INTENT: SurfaceIntent = {
  consume: ['spaceId', 'pageId'],            // unchanged: open this document
  state: ['view', 'sort', 'folder'],         // sort and folder are new
}
```

- `?view=columns|list` — the view strip (`useTabParam('view', FINDER_VIEWS, cookieDefault)`),
  written with `replace`. Old values `column` → `columns`, `full`/`tree` →
  `list` by the hook's unknown-value fallback; the cookie
  `knowledgeViewMode` is rewritten with the new vocabulary on first change.
- `?sort=` — one of the ten sort keys (§6), `useTabParam('sort', FINDER_SORTS, cookieDefault)`.
- `?folder=<pageId>` — the deepest open folder. Read with `useSearchParams`,
  written with `replace` on every browse, deleted at a root. On load the
  provider rebuilds `pagePath` by walking `parentPageId` from that page up
  (the pages list is already loaded whole per space). A folder id that is not
  in the space reads as the root.

`router.tsx` gains two `lazyElement(KnowledgeBasePage, 'list')` entries for
the virtual routes; `KnowledgeBasePage` reads the pathname and calls
`selectVirtual('latest' | 'shared-with-me')` the way it calls `selectSpace`
today. `PROJECT_INTENT` inherits the two new state names automatically.

## 2. Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ScreenHeader / column-0 header  [Sort ▾] [View ▾] [Needs review] [⚙] [New folder] [New file ▾] │
├────────────────┬────────────────┬────────────────┬───────────────────────┤
│ ROOT           │ My Documents   │ Contracts      │ (document pane /      │
│ ◷ Latest     › │ ▸ Contracts  › │ ▸ 2025       › │  empty)               │
│ ⇄ Shared w/me› │   Plan.docx    │ █ Lease.pdf █  │                       │
│ ────────────── │   Notes        │                │                       │
│ ⌂ My Documents›│                │                │                       │
│ ▤ Marketing  › │                │                │                       │
│ ────────────── │                │                │                       │
│ ⊞ Dashboards › │                │                │                       │
├────────────────┴────────────────┴────────────────┴───────────────────────┤
│ 3 items, 1 selected                     ▮ 3.2 GB of 10 GB used           │
└──────────────────────────────────────────────────────────────────────────┘
```

- The browser is `ColumnBrowserViewport` with `columnWidth` (the persisted
  `knowledgeColumnWidth`, default 320, 300–720) and every column a
  `ColumnBrowserColumn` with `resize`. On `split` the viewport composes the
  track; on `single` every column beyond 0 is a `column:<k>` stage
  (docs/navigation §6) — no Finder-specific stage code.
- **Column 0** on `/knowledge-base*` is the root column and is the route's
  own screen: `ColumnBrowserColumn screen` renders the `ScreenHeader`
  (`h1` "Documents") and the toolbar actions. On `/projects/:id/docs` and the
  agent tab column 0 is the scope's folder listing and is **not** `screen`
  (the project tab host and the agent page own their `h1`); the toolbar
  renders in that column's own header row via `actions`.
- **The document pane** — `KnowledgeDocumentPane` inside the
  `knowledge:document` stage — is the rightmost region on `split` when a
  document is open, exactly as today; it takes the remaining width after the
  columns (`flex-1 min-w-[360px]`), and the track scrolls the columns left to
  make room the way Finder's preview column does.
- **The status bar** (`FinderStatusBar`, new) is a 28px strip under the
  track: `text-xs text-[color:var(--tx3)]`, left "{n} items{, m selected}"
  for the active column (virtual columns: "{n} items" of the loaded page,
  "Showing 50 of more" while a next cursor exists), right `StorageUsageMeter`
  (organisation scope; hidden in project and agent scope). The upload queue
  ([uploads-and-indexing.md](uploads-and-indexing.md) §2) docks into this
  strip while active. Border-top `--sep`, background `--main`.
- **Surface class.** The whole Finder region is `bg-[color:var(--main)]`
  with `color: var(--tx)` — the work surface, never `.admin-nav-surface`. The
  design-system rule "a navigational page takes the menus' colour" applies
  to a screen a person passes *through*; the Finder is worked in. In the
  default `nessie` theme `--main` is white, which is the screenshot; in
  `midnight` it is dark, in `contrast` it is black with `--sep #f0f0f0`
  hairlines — the look survives because nothing is hard-coded (§9).

## 3. The root column

Rows are `FinderRow` (§4) with `variant="root"`: no size, no date, no
indexing glyph, always a chevron. The overview's root model fixes the order;
this fixes the pixels.

| Row | Leading (20px, `fixedWidth`) | Title | Subtitle | Trailing |
|---|---|---|---|---|
| Latest | `faClockRotateLeft` in `--accent` | "Latest" | — | chevron |
| Shared with me | `faShareNodes` in `--accent` | "Shared with me" | — | `Pill size="sm" tone="accent"` with `sharedWithMeCount` when > 0, then chevron |
| My Documents | `faHouse` in `--accent` | "My Documents" | — | chevron |
| a project | `ProjectAvatar` 20px (one identity tile, never a folder glyph) | project name | — | chevron |
| a shared folder | `faLayerGroup` in `--accent`; `writeRestricted` adds a `faLock` 10px badge bottom-right in `--tx3` | space name | project name (`text-xs --tx3`) | chevron |
| an agent home | `AgentAvatar` 20px | space name (`<Agent> — Documents`) | "Agent documents" | chevron |
| Dashboards | `faChartColumn` in `--tx2` | "Dashboards" | — | chevron |
| a product view | product `iconGlyph` or `faBook` in `--tx2` | surface label | product name | chevron |

Separators: `<div role="separator" className="my-1.5 border-t border-[color:var(--sep)]" />`.
The list is `role="listbox"` with `aria-label="Documents"`; rows are
`role="option"` with `aria-selected`. The selected root row uses the same
pill as any selected row (§4).

Loading: five `Skeleton variant="list"` rows for 300ms minimum then the
list; a failed `GET /root` renders `QueryState`'s error line "Couldn't load
your documents." with Retry in the column body. Permission-denied cannot
happen at the root (the route answers for any user).

Project scope (`/projects/:id/docs`): there is no root column. Column 0 is
the project's Documents folder listing; **above** its page rows, when the
project has other spaces, those render as `variant="root"` shared-folder
rows followed by a separator, so an ad-hoc space filed under this project is
one click away here even though org-wide it lives in the shared group.
Agent scope: column 0 is the agent home's listing; nothing above it.

## 4. The row

`FinderRow` replaces `KnowledgeItemRow`. It is built on the shared `Row`
(`components/shared/RowList.tsx`), which gains three props rather than being
forked: `size="finder"` (44px, `min-h-11 py-0`), `selectionStyle="pill"`
(the full-width accent pill instead of the left border + soft fill; the
`ColumnBrowserItem` card and the five drill-down lists keep the border), and
`draggable` handlers passthrough. *Rejected:* a fourth row component — the
2026-09-01 audit counted six; this converges to one with two modes.

### Anatomy (columns view), left to right

```
│ [icon 20] [name — middle-truncated ..................] [meta] [status] [›] │
   12px gutter, 10px gap, 8px gap, 8px gap, 12px gutter; height 44px
```

- **Icon** — 20×20 `FontAwesomeIcon fixedWidth`, tone per kind (§5).
- **Name** — `text-sm` (15px base, `--tx`), one line, **middle-truncated**
  by `MiddleTruncate` (new, `components/shared/MiddleTruncate.tsx`): keeps
  the extension plus up to 10 trailing characters and replaces the middle
  with a single `…` (U+2026), measured with a hidden canvas
  (`measureText` in the row's computed font) on mount and on `ResizeObserver`
  of the name cell. The full name is on `title` and is what assistive tech
  reads (`aria-label` = full title). Finder's `Fire_Risk_Ass…Distillery.docx`
  is the reference.
- **Meta** — optional, `text-xs --tx3`, right-aligned, only in list view
  (§5) except one case: a folder in columns view shows nothing (Finder's
  columns show no counts; the count is in the status bar and Get Info).
- **Status** — one 14px glyph, only when there is something to say:
  `shareCount > 0` → `faUserGroup` in `--tx3` (`title="Shared with {n}
  {person|people}"`); indexing `pending` → `faSpinner spin` in `--tx3`;
  `not_indexed` → `faMagnifyingGlassMinus` in `--tx3`; `failed` →
  `faTriangleExclamation` in `--warning`. Draft documents show the existing
  `AgentDraftBadge` when `isAgentDraft`. Nothing for `indexed`: a quiet row
  is the point. Full sentences live in the tooltip and Get Info
  ([uploads-and-indexing.md](uploads-and-indexing.md) §4).
- **Chevron** — `faChevronRight` 12px `--tx3` on folders and root rows only.

### States

| State | Paint | Notes |
|---|---|---|
| default | transparent, `--tx` | |
| hover (`:hover:not([aria-disabled])`) | `--overlay-weak` | pointer only; no hover on `coarsePointer` |
| selected, column focused | background `--accent`, text `--on-accent`, icon and chevron `--on-accent`, radius `--radius-sm` (6px), pill inset `mx-1.5` so it is full width minus the 6px column padding — Finder's look | `aria-selected="true"` |
| selected, column not focused | background `--overlay`, text `--tx` | Finder's grey inactive selection; the active column is the one holding DOM focus or the deepest column when none does |
| focused (`:focus-visible`) | `outline: 2px solid var(--accent); outline-offset: -2px` on top of whichever background | roving `tabIndex`: one row per column is tabbable |
| dragging | the dragged rows at `opacity: 0.6`; the source row keeps its place | HTML5 `draggable`, custom ghost = row clone capped at 240px |
| drop target (a folder row under a drag) | background `--accent-soft`, `outline: 2px solid var(--accent)` | also the column's empty body when hovered |
| renaming | the title cell is replaced by `Input size="compact"` prefilled, extension excluded from the initial selection for files | Enter commits, Escape reverts, blur commits; §7 |
| uploading | see [uploads-and-indexing.md](uploads-and-indexing.md) §3 | placeholder row |
| disabled (`aria-disabled`, e.g. a row whose open is refused in a virtual column) | `opacity-50`, no hover | `:not(:disabled)`-style guards |
| transferring (`transfer` set on the record) | name at `opacity-60`, trailing "Moving…" / "Copying…" `text-xs --tx3` | menu offers Get Info only; [transfer.md](transfer.md) §5–6 |
| agent draft | `AgentDraftBadge` before the status glyph | unchanged |

Rows never carry a border between them and there is no zebra striping.

### Copy inside rows

None beyond the title; every state sentence is a `title`/tooltip and is
listed in [uploads-and-indexing.md](uploads-and-indexing.md) §4 and
[menus-and-dialogs.md](menus-and-dialogs.md).

### List view (`?view=list`)

One folder at a time, full width, in place of the column track:
`KnowledgeBreadcrumb` (kept from today, restyled to `text-sm`) across the
top with the root folder as its first crumb, then a header row and the rows.

```
│ Name                                    │ Date modified     │ Size     │ Kind          │
│ ▸ 📁 2025                               │ 3 Sep 2026 14:02  │ —        │ Folder        │
│   📄 Lease.pdf                          │ 1 Sep 2026 09:15  │ 1.2 MB   │ PDF document  │
```

- The header row is `role="row"` inside `role="grid"`; each header cell is
  a `<button>` that sets `?sort=` to that key (a second press flips the
  direction) with `aria-sort="ascending|descending|none"`. Column widths:
  Name `1fr min 240px`, Date modified `max-content`, Size `88px`
  right-aligned tabular numerals (`font-variant-numeric: tabular-nums`),
  Kind `160px`; below 640 px measured width (`ResizeObserver` on the grid,
  never a breakpoint) Kind hides, below 480 px Size hides too, and the
  hidden values stay in Get Info.
- Rows are the same `FinderRow` in `variant="item"` with `layout="grid"`;
  a folder row opens the folder in place (the breadcrumb grows); `←`/Back
  walks up. Dates are `formatDateTime` short form ("3 Sep 2026 14:02");
  a folder's Size cell is "—"; Kind is `familyLabel`.
- Everything else — selection, keyboard, rename, menus, drag, placeholders,
  the status glyph (rendered after the name) — is identical to columns view.
- On `single` the view does not exist: a column *is* one folder full-width.

*Rejected:* a tree view with disclosure triangles (today's `tree`). It was a
sidebar affordance; with the sidebar gone and columns doing the drilling, a
third way to expand folders is the fork Rule zero names.

## 5. Icons

`components/shared/file-icons.ts` gains:

```ts
// Which family a name belongs to, for the tone and for Sort by kind.
export type FileFamily =
  | 'folder' | 'document' | 'pdf' | 'word' | 'excel' | 'powerpoint'
  | 'image' | 'audio' | 'video' | 'archive' | 'code' | 'text' | 'mail' | 'book' | 'unknown'
export const familyForFilename = (filename: string): FileFamily
export const familyLabel: Record<FileFamily, string> // "PDF document", "Word document", "Image", …; the Kind column and Get Info
// Colour is a token per family, never per extension:
export const familyTone: Record<FileFamily, string> // CSS var name
```

Tones (all existing tokens): folder `--accent`; document `--accent`
(`faFileLines`); pdf `--danger`; word
`--info`; excel `--success`; powerpoint `--warning`; image `--thinking`;
audio/video `--executing`; archive `--tx3`; code `--tx2`; text `--tx2`; mail
`--info`; book `--warning`; unknown `--tx3` (`faFile`). Extensions added to
`EXTENSION_ICONS`: `pages`→word, `numbers`→excel, `keynote` stays powerpoint,
`epub`→`faBook`, `eml`/`msg`→`faEnvelope`, `avif`/`bmp`/`tiff`/`tif`→image,
`ogg`/`aac`/`opus`→audio, `avi`/`m4v`→video, `sql`/`toml`/`ini`/`env`/`ipynb`→code,
`log`/`rtf`→text. Markdown files (`isMarkdownFilename`) take the *document*
icon and tone: they open as documents.

At a glance: a folder is the only blue folder glyph; a rich-text document is
a blue page with lines; an uploaded file is a page glyph in its family's
colour with the family badge (Word's `W`, Excel's `X`, PDF's ribbon — what
the FontAwesome `faFile*` set already draws); an unknown type is a grey
blank page. Contrast theme: every tone above is declared in
`[data-theme="contrast"]`, so they stay distinct. `familyForRow` switches
exhaustively on `KnowledgePageKind`; a future kind (a spreadsheet, say)
fails to compile until it names its family and tone.

## 6. The toolbar

All header actions are `PageHeaderAction`s in `finder-toolbar-actions.ts`
(replacing `knowledge-workspace-actions.ts`); `ResponsivePageHeader`
measures them and moves the lowest priorities into More, so narrow windows
and the project tab need no separate rules. Order is priority, high first.

| id | kind | label | icon | priority | primary | shown when |
|---|---|---|---|---|---|---|
| `new-file` | menu | "New file" | `faPlus` | 100 | **yes** | the active column is writable (`canWrite` of its space) and not virtual |
| `new-folder` | button | "New folder" | `faFolderPlus` | 90 | | same; at the root column it opens **New shared folder…** instead |
| `sort` | menu | "Sort: {Name}" | `faArrowDownWideShort` | 80 | | always, disabled (`aria-disabled`) in virtual columns with `title="Latest and Shared with me are ordered by time"` |
| `view` | menu | "View: {Columns}" | `faColumns` / `faList` | 70 | | `split` only — on `single` a column *is* a list |
| `needs-review` | toggle | "Needs review ({n})" | | 60 | | `agentDraftCount > 0 || needsReviewOnly` for the active space (unchanged behaviour) |
| `open-agent` | button | "Open agent" | | 50 | | the active space has `ownerAgentId` and it is not the scoping agent |
| `sharing-settings` | button, compact | "Sharing & settings" | `faGear` | 10 | | active space `canManageAccess || canWrite`, and the space is neither personal nor a project Documents space (those have nothing to set — the read-out covers them) |

One primary: New file. New page used to be primary; "file" is the owner's
word and the menu holds the three kinds. *Rejected:* keeping New folder
primary alongside (two filled buttons name no decision).

**New file** menu items: Document, Upload… — the contract is
[menus-and-dialogs.md](menus-and-dialogs.md) §6.

**Sort** menu (role `menu`, items `menuitemradio`): Name, Date modified,
Date created, Size, Kind — the current key `checked`; a separator; Ascending,
Descending (`menuitemradio`, the current direction checked). The label shows
the key, and a `faArrowUp`/`faArrowDown` 10px glyph after it shows the
direction. The ten values:

```ts
export const FINDER_SORTS = [
  'name', 'name-desc', 'modified', 'modified-desc', 'created', 'created-desc',
  'size', 'size-desc', 'kind', 'kind-desc',
] as const
```

Rules: **folders first**, always (Finder's default "keep folders on top";
no option to turn it off — one fewer state). Within a group: `name` by
`localeCompare` with `numeric: true` (`file2` before `file10`); `modified`
by `updatedAt`; `created` by `createdAt`; `size` by `Number(sizeBytes)` with
nulls (folders, documents without body) last; `kind` by `familyLabel` then
name. Ties break on `position`, then `id`. Default `name`. The choice is
**global** (one browser, every column) and persists in the cookie
`knowledgeSort` as the `useTabParam` fallback. Virtual columns ignore it.
*Rejected:* per-folder sort — Finder keeps it in `.DS_Store`; we would need a
`(userId, folderId)` store and a write on every menu pick.

**View** menu: Columns (`faColumns`), List (`faList`), `menuitemradio`.
`?view=` is the state. On `single` the action is omitted, not disabled.

Where the actions render: on `/knowledge-base*` in the root column's
`ScreenHeader` (the screen's one header); on the project tab and the agent
tab in column 0's header row through `ColumnBrowserColumn actions`, which
already renders button actions and gains menu and toggle rendering by
delegating to `ResponsivePageHeader`'s action renderer (one component, not a
second strip). *Rejected:* a Finder-only toolbar component.

Active column: the column that holds the selection, or the deepest open
column when nothing is selected. The toolbar acts on it: New folder creates
there, New file → Document opens the editor with that folder as parent,
Upload uploads there.

## 7. Keyboard, selection, rename

Selection model (`finder-selection.ts`, pure, unit-tested):

- One active column; a `Set<pageId>` of selected ids in it; an anchor id for
  Shift ranges; selections in other columns are the path (one folder each).
- Click selects one. Cmd/Ctrl-click toggles. Shift-click selects the range
  from the anchor in the current sort order. Cmd/Ctrl-A selects the column.
  Escape clears the selection (and closes an open menu first, through the
  overlay's own Escape).
- Opening a folder (click, →, Enter) makes its column active and selects
  nothing in it; the parent column keeps that folder as its one selected
  (grey) row.

Keys, with the row focused (`role="option"`, roving tabindex):

| Key | Does |
|---|---|
| ↓ / ↑ | move selection (and focus) one row; Shift extends |
| Home / End | first / last row |
| → | on a folder: open it and focus its first row; on an item: nothing |
| ← | focus the parent column's selected row (the folder you came from); at column 0 nothing |
| Enter | open: folder → its column; document/file → the document pane; root row → navigate |
| Space | nothing (Quick Look is out of scope; do not reassign it) |
| F2 | rename the focused row (if `canWrite`) |
| Delete / Backspace | Delete… for the selection (confirm; [menus-and-dialogs.md](menus-and-dialogs.md) §8) |
| Shift+F10 / ContextMenu | open the row's context menu anchored to the row |
| Cmd/Ctrl+I | Get Info for the selection |
| Cmd/Ctrl+Shift+N | New folder in the active column |
| a–z, 0–9 | type-ahead: select the first row whose name starts with the buffer (buffer resets after 700ms) |
| Tab | leaves the column to the next column's tabbable row (then the pane, then the status bar) |

Rename (`RenameRow` inside `FinderRow`): F2, the menu's Rename, or a
click-pause-click on an already-selected row's name (Finder's gesture; 500ms
window, cancelled by a double-click which opens). The name cell becomes an
`Input size="compact"` with the whole title selected for folders and
documents, and the stem selected (extension excluded) for files. Enter
commits, Escape reverts, blur commits, an empty or unchanged value reverts
silently. The commit is optimistic: the row shows the new name at once and
reverts on a 409 with the toast in [data-and-api.md](data-and-api.md) §10.
Root rows rename only for shared folders the viewer may write
(`PATCH /spaces/:id`); My Documents and project folders refuse with the
menu item absent.

## 8. Moving by drag

Inside one root folder (one space), rows are HTML5 `draggable` and a folder
row or a column's empty body is a drop target. Drop = `POST /pages/:id/move`
with `{ parentPageId: target ?? null, position: <last position in target + 1> }`
and `If-Match`. Multi-selection moves each in order and reports the first
failure. The drop is optimistic (the rows disappear from the source column
and appear in the target) and reverts on error. Nothing asks: a move inside
one root is a move.

Between root folders (different `spaceId`) the target highlights like any
other and releasing opens the **move-or-copy prompt** at the pointer — the
whole of that path, including Alt/⌥ to copy without asking, the audience
line, the refusals and the background job for large trees, is
[transfer.md](transfer.md). A root row (My Documents, a project, a shared
folder) is a valid drop target meaning "the root of that folder". Virtual
columns are never drop targets. Dropping onto a page that is a *document with
sub-pages* is refused (only folders receive drops; a document's sub-pages
are edited from the document). Dragging a folder onto its own descendant is
refused client-side before the server's cycle check answers 409.

The file-drop overlay and the row drag share `dragover`; the host tells them
apart by `dataTransfer.types` including `'Files'` (`useFileDrop`'s existing
`hasFiles`), so an in-app row drag never opens the upload overlay.

## 9. Theming

Every colour is a token: `--main`, `--tx`, `--tx2`, `--tx3`, `--sep`,
`--accent`, `--on-accent`, `--accent-soft`, `--overlay-weak`, `--overlay`,
the family tones in §5, `--warning`, `--danger`. No hex, no Tailwind
palette word, no `/opacity` suffix on a variable. The Finder never uses
`.kb-reader`'s hard-coded paper; that class stays what it is for the document
body.

- **nessie (default):** `--main` white, chrome navy — the screenshot.
- **midnight / graphite / forest / ocean:** dark `--main`; the selected pill
  stays the theme's `--accent` with `--on-accent` text; folder glyphs take
  the theme's accent.
- **contrast:** `--main #000`, `--sep #f0f0f0`, `--accent #4da3ff`,
  `--on-accent #000`. Hairlines are visible; the pill is high-contrast by the
  theme's own declaration. The focus outline uses `--accent` at 2px, which
  the theme makes visible on black.
- **focus mode:** the shell's monochrome rule already flattens tones to
  `--tx3`; the family tones are declared through the same tokens, so the
  Finder goes quiet with everything else.
- The page-header e2e (`test:e2e:page-header`) already screenshots every
  theme's header; the Finder suite adds a per-theme screenshot of column 0
  with one selected row ([verification-and-waves.md](verification-and-waves.md) §1, F-THEME).

Radii: the pill is `--radius-sm` (6px) at 44px — proportional enough not to
read as a capsule; nothing uses `rounded-xl`.

## 10. The phone (`single`)

- `/knowledge-base` is the root column full-width, `ScreenHeader` "Documents"
  with the toolbar's actions in the native bar (`toScreenBarActions`); the
  View action is absent; Sort stays.
- A root row navigates: Latest → `/knowledge-base/latest` (route push, depth
  1), Shared with me → `/knowledge-base/shared-with-me`, a root folder →
  `/knowledge-base/spaces/:id`. These are real routes, so a surface reached
  by leaving another screen is a route, not component state (the phone-stack
  rule).
- Inside a space, each folder is a `column:<k>` stage pushed by
  `ColumnBrowserViewport`; the document is the `knowledge:document` stage
  above it; Back unwinds one level through the one resolver. `?folder=` is
  still written, so a refresh lands on the same folder with its ancestors
  seeded beneath (§8 cold start).
- The context menu is a bottom `Sheet` on long-press
  ([menus-and-dialogs.md](menus-and-dialogs.md) §1).
- No drag and drop of either kind; Upload… uses the native file picker
  (`<input type="file" multiple>`).
- The status bar is hidden; item count is unnecessary on a screen that shows
  one column, and storage usage moves to Get Info on My Documents.
- Rename is the menu's Rename → the same inline input, with the on-screen
  keyboard's Done as Enter.

## 11. Components and files (`admin/src/components/features/knowledge/finder/`)

| File | Owns |
|---|---|
| `DocumentsFinder.tsx` | composes the viewport, columns, pane, status bar; takes `scope: { kind: 'org' } \| { kind: 'project'; projectId } \| { kind: 'agent'; spaceId; agentId }` |
| `FinderRootColumn.tsx` | §3; reads `useKnowledgeRoot()` |
| `FinderFolderColumn.tsx` | one space folder level: rows, NewFolderRow, upload placeholders, drop target |
| `FinderVirtualColumn.tsx` | Latest and Shared with me: paged rows with `home` line, "Load more" row at the cursor |
| `FinderListView.tsx` | §4's list view: header row with sortable columns Name / Date modified / Size / Kind, one folder at a time with `KnowledgeBreadcrumb` |
| `FinderRow.tsx` | §4; `variant: 'item' \| 'root' \| 'virtual' \| 'upload'` |
| `FinderStatusBar.tsx` | §2 |
| `NewFolderRow.tsx` | moved from `KnowledgeFilesystemRows.tsx`, unchanged |
| `RenameRow.tsx` | §7 |
| `finder-sort.ts` | `FINDER_SORTS`, `sortFinderRows`, `familyForRow` |
| `finder-selection.ts` | the pure selection reducer |
| `finder-view.ts` | `FINDER_VIEWS = ['columns','list']`, cookie migration |
| `finder-toolbar-actions.ts` | §6 |
| `useFinderKeyboard.ts` | §7's key table |
| `useFinderDrag.ts` | §8, and the cross-root branch in [transfer.md](transfer.md) §1 |
| `TransferPrompt.tsx` | the move-or-copy menu and the Move to… footer variant — [transfer.md](transfer.md) §1 |
| `useUploadQueue.ts`, `UploadQueue.tsx` | [uploads-and-indexing.md](uploads-and-indexing.md) |
| `FinderContextMenus.tsx`, `GetInfoDialog.tsx`, `ShareDialog.tsx`, `AccessReadoutDialog.tsx`, `MoveToDialog.tsx`, `NewFilePicker.tsx`, `new-file-types.ts` | [menus-and-dialogs.md](menus-and-dialogs.md) |

Each file stays under 500 lines; `DocumentsFinder.tsx` composes and holds no
row markup.

### Facade additions (`admin/src/facades/knowledge/finder-hooks.ts`, keys in `keys.ts`)

```ts
knowledgeKeys.root                          // ['knowledge-root']
knowledgeKeys.latest(projectId?)            // ['knowledge-latest', projectId ?? 'organization']
knowledgeKeys.sharedWithMe                  // ['knowledge-shared-with-me']
knowledgeKeys.pageInfo(pageId?)             // ['knowledge-page', pageId, 'info']
knowledgeKeys.spaceInfo(spaceId?)           // ['knowledge-spaces', spaceId, 'info']
knowledgeKeys.pageShares(pageId?)           // ['knowledge-page', pageId, 'shares']
knowledgeKeys.sharedSubtree(spaceId, rootPageId) // ['knowledge-pages', spaceId, 'shared', rootPageId]

useKnowledgeRoot()                           // GET /root, staleTime 30s, placeholderData keepPrevious
useLatestPages(projectId?)                   // useInfiniteQuery over GET /latest
useSharedWithMe()                            // useInfiniteQuery over GET /shared-with-me
usePageInfo(pageId?) / useSpaceInfo(spaceId?)
usePageShares(pageId?) / useSharePage() / useUpdateShare() / useUnsharePage()
useEnsureProjectDocuments()                  // POST /projects/:id/documents
useReindexPage()
useRenamePage()                              // PATCH with If-Match, optimistic
useMovePages()                               // sequential in-space moves, optimistic
useTransferPages()                           // POST /transfers (move | copy), not optimistic: the prompt already waited
useTransferStatus(transferId?)               // GET /transfers/:id, refetchInterval 2s while queued|running
```

Every mutation invalidates `knowledgeKeys.pages(spaceId)`, `knowledgeKeys.root`
and, for shares, `knowledgeKeys.sharedWithMe` and `knowledgeKeys.pageInfo`.
Query keys follow `src/lib/query-keys.ts` (family root prefix, no literals at
call sites); id-keyed queries carry `placeholderData: keepPreviousData` so a
column swap never flashes empty.

### Provider changes (`KnowledgeProvider.tsx`, `useKnowledgeNavigation.ts`)

- `selectedRoot: { kind: 'space'; spaceId } | { kind: 'latest' } | { kind: 'shared-with-me' } | null`
  replaces the bare `selectedSpaceId` as the source of truth; `selectedSpaceId`
  stays as a derived field so the document, history and editor panes are
  untouched.
- `selectVirtual(kind)` beside `selectSpace`. `activeProductView` and
  `selectProductView` are unchanged.
- `pagePath` is seeded from `?folder=` on mount (§1) and mirrored back on
  every `browseTo`.
- Selection state (`finder-selection.ts`) lives in `DocumentsFinder`, not in
  the provider: it is view state of one browser instance.
- The first-visit seeding of a "General" space with an example page is
  **removed**: the root always has My Documents, so "no spaces" is no longer
  a state to rescue, and seeding a shared space nobody asked for was the
  duplicate-space defect Rule zero cites. `useSeedKnowledgeBase` and
  `example-page.ts` are deleted.
- `KnowledgeProvider` and `KnowledgeWorkspace` both land under 400 lines
  after the folder stage, the seeding and the upload wiring leave them.
