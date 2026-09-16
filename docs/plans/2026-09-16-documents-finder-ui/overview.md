# Documents as a Finder — overview

Status: designed 2026-09-16, not built. This directory is the built contract
for the implementation waves in
[verification-and-waves.md](verification-and-waves.md); an implementer who
has read nothing else must be able to build from it. Every decision below
names the alternative it rejected, so nobody re-litigates. Where the brief
that commissioned this design disagreed with the code, the code won and the
disagreement is recorded in "Contradictions" at the end.

## Table of Contents

Files in this directory, in reading order:

1. **This file** — what is wanted, the root model, the decisions, what the
   redesign replaces, what it deliberately leaves out, the contradictions,
   and the questions the owner must answer before Wave 0 starts.
2. [data-and-api.md](data-and-api.md) — the two schema changes with their
   migration notes, every wire shape in typed code, access rules, audit
   actions, and how indexing status and Get Info are computed.
3. [browser-ui.md](browser-ui.md) — the browser itself: surfaces, the root
   column, columns and list view, the row to the pixel with every state,
   icons, the toolbar, sort and view state, keyboard and selection, the
   phone, and theming.
4. [menus-and-dialogs.md](menus-and-dialogs.md) — the context-menu
   primitive, the five menus item by item, Get Info, Share, the access
   read-out, New file, Move to, Delete, and Rename, with exact copy.
5. [uploads-and-indexing.md](uploads-and-indexing.md) — multi-file and
   folder drop, the upload queue, quota refusal, and the honest indexing
   states a row shows.
6. [transfer.md](transfer.md) — moving and copying between root folders:
   the move-or-copy prompt, what each operation rewrites down to the chunk
   mirrors and the storage ledger, the refusals that stay, and the bound
   past which a transfer becomes a job.
7. [verification-and-waves.md](verification-and-waves.md) — the enumerated
   Playwright cases, the unit tests, and the waves with exclusive file lists
   and their dependency edges.

Revised 2026-09-16 after the owner answered the first draft's questions:
cross-root moves are no longer refused (they ask move-or-copy), shares carry
a view/edit level, and the spreadsheet work is left entirely alone. The
answers are recorded at the end.

## What the owner asked for

Documents should look and behave like the macOS Finder: a white multi-column
browser starting straight at folders, no navy space picker in between. The
root holds **Latest** (virtual), **Shared with me** (virtual), a separator,
**My Documents**, one folder per project, and documents shared outside any
project. Every row has a typed icon and a right-click menu that gives Get
Info (size including everything inside), and Sharing — a read-out of who is
in there for project documents, a real person-to-person share with **no
approval gate** for his own documents. The toolbar carries Finder's sort and
view controls, New folder, and New file (Document, Spreadsheet, Upload).
Dropping files onto a column uploads them there, and the screen is honest
about when they are indexed and embedded. Dashboards will be re-homed later
and must keep a doorway meanwhile. A separate session builds the spreadsheet
editor; this design builds the seam it plugs into.

## Vocabulary

- **Root** — the first Finder column. It replaces the navy
  `KnowledgeSidebarNav` and, in project and agent scope, the project's own
  208px `KnowledgeSpaceList` rail and the agent tab's single-space mount.
- **Root folder** — a row of the root that is a `KnowledgeSpace`: My
  Documents (the `ensureMyDocsSpace` space), a project (its
  `ensureProjectDocumentsSpace` space), or a shared folder (any other space
  the viewer can read, including an agent's `<Agent> — Documents` home).
- **Virtual folder** — Latest or Shared with me: a listing the server
  computes, whose rows are real pages living elsewhere.
- **Folder** — a `KnowledgePage` of `kind: 'folder'` (new; see below).
- **Document** — `kind: 'document'` (rich text). **File** — `kind: 'file'`
  (an uploaded blob; each version is an `Attachment`). There is no
  spreadsheet kind in this design; see "Spreadsheets" below.
- **Item** — any row that is a page: folder, document, file.
- **Share** — a `KnowledgePageShare` row (new): one person granted access to
  one page (and, for a folder, everything under it) at a **level**, `view`
  (read and download) or `edit` (also change its content).
- **Transfer** — a move or a copy of pages from one root folder (space) to
  another; it always asks which ([transfer.md](transfer.md)).
- **Home** — where an item lives: its root folder and the folder path under
  it. A virtual row shows its home; an ordinary row is standing in it.

## The root model

The root column, top to bottom. Groups are separated by a hairline
(`border-t border-[color:var(--sep)]` with 6px of space either side), never
by a heading; an empty group omits itself and its separator.

| Order | Row | What it is | Opens |
|---|---|---|---|
| 1 | **Latest** | virtual | `/knowledge-base/latest` |
| 2 | **Shared with me** | virtual | `/knowledge-base/shared-with-me` |
| — | separator | | |
| 3 | **My Documents** | the viewer's personal space (`metadata.personal === true`, `userId` = viewer), provisioned on first open through the existing `POST /api/knowledge-base/my-docs` | `/knowledge-base/spaces/:spaceId` |
| 4… | **One row per project** the viewer belongs to, alphabetical | the project's Documents space (`metadata.projectDocuments === true`), provisioned on first open through the new `POST /api/knowledge-base/projects/:projectId/documents` ([data-and-api.md](data-and-api.md)) | `/knowledge-base/spaces/:spaceId` |
| — | separator | | |
| 5… | **Shared folders**, alphabetical | every other readable space: ad-hoc spaces from `CreateSpaceDialog` (any visibility) and agent homes (`ownerAgentId` set). The row's subtitle names the project the space is filed under; an agent home's leading is the agent's `AgentAvatar`. | `/knowledge-base/spaces/:spaceId` |
| — | separator | | |
| 6 | **Dashboards** | a link row, chart glyph, chevron | `/dashboards` |
| 7… | **Product views** (`useProductSurfaces().documentsSections`, e.g. DeepWater Research), only while the product is active | link rows | `/knowledge-base/views/:productView` |

**Decision — the third group is a read-time grouping, not a schema change.**
Every space carries a `projectId`, so "documents shared outside of projects"
has no schema home. The group is defined by convention: a readable space that
is neither `metadata.personal` nor `metadata.projectDocuments`. A project
folder therefore *is* its Project Documents space and nothing else; an ad-hoc
space a member created under a project appears in the shared group with the
project's name as its subtitle, not inside the project's folder.
*Rejected:* nesting ad-hoc spaces inside their project's folder — a project
folder would then have two write targets (which space does New folder write
to?) and a second "which space" level, which is the space picker he wants
gone. *Rejected:* a new `KnowledgeSpace.kind` column — it would restate what
the two metadata flags and `ownerAgentId` already say, in a third place.

**Decision — a project row flattens to its Documents space.** The row opens
the space's root listing directly. *Rejected:* expanding a project row into
its spaces (the picker again).

**Decision — agent homes live in the shared group.** They are readable
documents that are neither yours nor a project's, exactly the group's
definition, and `canReadSpace` already decides who sees them. The agent's
identity tile tells them apart at a glance. Their existing doorway, the agent
page's Documents tab, stays. *Rejected:* a fourth "Agents" group (a heading
for a bucket that is usually one or two rows) and hiding them from the root
(a readable folder nobody can navigate to is Rule zero's defect).

**Decision — task folders are ordinary folders.** `ensureTaskFolder` files a
ticket's documents as a folder inside the project's Documents space; the row
is a folder with the ticket's title. Get Info names the ticket and links to
it. *Rejected:* a ticket badge on every task folder — most rows in a busy
project would carry one, which says nothing.

**A person with no projects** sees Latest, Shared with me, My Documents, any
shared folders, and Dashboards. No "no projects" line: the absence is the
information.

**Dashboards** keep a working doorway as row 6 until he re-homes them; the
`/dashboards` surfaces stay in section `knowledge` so the rail item keeps
lighting. *Rejected:* moving Dashboards to the Admin section (it is a reading
surface, not administration) and burying it in the toolbar's More menu.

**Space creation** moves to the root: right-click the root's empty background
→ **New shared folder…**, and the toolbar's New folder, while the root column
is active, opens the same dialog (today's `CreateSpaceDialog`, retitled). A
top-level folder needs a visibility choice, which an inline name field cannot
carry. *Rejected:* a separate "New space" toolbar button (a fourth creation
control for a word nobody uses).

**The storage meter** moves to the Finder's status bar, the strip under the
columns Finder itself uses for "12 items, 3.2 GB available": item count on the
left, organisation usage on the right, hidden in project scope as today.

## Decisions at a glance

Each row is decided here and specified in the linked file.

| # | Decision | Rejected | Where |
|---|---|---|---|
| 1 | `folder` becomes a real `KnowledgePageKind`; `metadata.folder` rows are backfilled; a document with children stays a document | keeping the "has children" convention (any document with a sub-page rendered as a folder, breaking icons, Get Info and sharing) | [data-and-api.md](data-and-api.md) §1 |
| 2 | Person-to-person sharing is a page-level `KnowledgePageShare` row on the sharer's own personal documents only, written immediately with no approval, at level `view` by default or `edit` when the owner chooses; an edit grant reaches exactly that page and its descendants, never the space | space-level `KnowledgeSpaceMember` (shares all of My Docs); a hidden per-share space (moves break the owner's tree and the chunk mirrors); view-only (the owner wants to be able to grant edit) | [data-and-api.md](data-and-api.md) §2 |
| 3 | Latest is `GET /api/knowledge-base/latest`, viewer-scoped over `readableSpaceIdsSql`, keyset-paged, 50 rows a page, folders excluded | widening `recent-pages` (it is the project Overview's five-row read, with its own cap) | [data-and-api.md](data-and-api.md) §3 |
| 4 | Shared with me lists page shares to the viewer, newest share first | including spaces someone added you to (those are already folders in the shared group) | [data-and-api.md](data-and-api.md) §4 |
| 5 | Get Info is a `Dialog` fed by `GET …/pages/:pageId/info`, computed on read with one recursive CTE and a hard row cap | a `Sheet` (a drawer is for a task that lasts; Get Info is a glance); maintained counters (a second ledger to keep true) | [data-and-api.md](data-and-api.md) §5, [menus-and-dialogs.md](menus-and-dialogs.md) §3 |
| 6 | The context menu is one new `ContextMenu` on `Popover`, anchored at the pointer, a bottom `Sheet` on `single`; no submenus | a bespoke fixed div (the third private flip routine); submenus (a hover-timing problem on touch) | [menus-and-dialogs.md](menus-and-dialogs.md) §1 |
| 7 | Sort is one global choice in `?sort=` (10 values, direction folded in), cookie default, folders always first | per-folder sort (needs a per-person-per-folder store) | [browser-ui.md](browser-ui.md) §6 |
| 8 | Two view modes, `columns` and `list`; `full` and `tree` retire | keeping three (tree was a sidebar affordance; full *is* list) | [browser-ui.md](browser-ui.md) §6 |
| 9 | New file is a `Popover` menu off the one primary button: Document → the editor, Upload → the file input; a Spreadsheet item is a reserved seam that is absent, not disabled, until a spreadsheet kind exists | a `Dialog` picker (two dialogs to reach an editor); a greyed "coming soon" item | [menus-and-dialogs.md](menus-and-dialogs.md) §6 |
| 10 | Drop uploads every file (and folders, via `webkitGetAsEntry`) into the column dropped on, two at a time, with a placeholder row per file and a queue in the status bar | first-file-only (today); an overlay card per file | [uploads-and-indexing.md](uploads-and-indexing.md) |
| 11 | Indexing state is derived server-side from chunks, embeddings and the queue job, and polled every 5 s only while a row is pending | a status column (a second truth beside the chunks); a new realtime kind (a mixed-version deploy hazard for a progress glyph) | [uploads-and-indexing.md](uploads-and-indexing.md) §4 |
| 12 | Rows are 44px, name middle-truncated, selected row a full-width `--accent` pill with `--on-accent` text; the browser paints `--main`, never white | hard-coded white (`.kb-reader` does that deliberately for paper; a browser must survive dark and contrast themes) | [browser-ui.md](browser-ui.md) §4, §9 |
| 13 | Delete is today's archive with a `ConfirmDialog`; there is no Trash | inventing a Trash (files are purged on archive today; a restorable Trash is a storage-ledger design of its own) | [menus-and-dialogs.md](menus-and-dialogs.md) §8 |
| 14 | A drag or Move to… across root folders **asks move or copy** at the drop point; a move rewrites the pages, every chunk's scope mirror, annotations and the storage ledger in one transaction and ends shares; a copy re-stores bytes and carries only the current version; both refuse to widen past a version's basis; above 500 pages the transfer is a job | refusing cross-root moves (the first draft — overturned by the owner); referencing the source `Attachment` from a copy (a purge on either page would delete the other's bytes); stripping the basis on move | [transfer.md](transfer.md) |
| 15 | Alt/⌥ held on release copies without asking; nothing else is a modifier | Shift/Ctrl variants (they already mean selection) | [transfer.md](transfer.md) §1 |

## What this replaces

Explicitly, so nothing lingers.

- **`admin/src/layouts/admin-shell/KnowledgeSidebarNav.tsx` — deleted.**
  `AdminShellLayout` renders no secondary sidebar for the Knowledge section
  (`secNavElement` is `null` there, as it is for Feedback), and the
  `/knowledge-base` surface row drops `contextualList`, so on a phone the
  root page is the outlet — the Finder root — exactly as `/dashboards` and
  `/search` already work. The `ResizableSidebar` `knowledge` section width
  becomes unused and its cookie is left to expire.
- **`KnowledgeSpaceList.tsx`, `KnowledgeSidebarPageTree.tsx` — deleted.**
  Both existed to fill the sidebar. `ProjectDocsTab.tsx` loses its 208px
  navy rail and mounts the Finder in project scope.
- **`KnowledgeColumns.tsx`, `KnowledgeFilesystemBrowser.tsx`,
  `KnowledgeFilesystemRows.tsx`, `KnowledgeViewToggle.tsx` — replaced** by
  `components/features/knowledge/finder/*` ([browser-ui.md](browser-ui.md)).
  `NewFolderRow` moves into `finder/` unchanged in behaviour.
- **View modes.** `column` survives as `columns`; `full` becomes `list`;
  `tree` is gone. An old `?view=tree` link degrades to the fallback the way
  `useTabParam` already degrades an unknown value.
- **`NestedStage` layers.** `knowledge:folder` is retired: the Finder sits on
  `ColumnBrowserViewport`, whose columns are already `column:<k>` stages on
  `single`. `knowledge:document` (12), `knowledge:history` (13) and
  `knowledge:editor` (14) stay exactly as they are.
- **`KnowledgePane`** stays as the chrome of the document, history and editor
  panes. The browser's own header is `ColumnBrowserColumn screen` for column
  0 on the root route and `ScreenHeader` actions elsewhere.
- **Header actions.** `View: Column`, `Needs review (n)`, `Open agent`,
  `Upload file`, `New folder`, `New page` and ⚙ are all re-homed in
  [browser-ui.md](browser-ui.md) §6; none vanishes.
- **`useFileDrop`'s `firstFileOnly`** loses its last knowledge caller; it stays
  for the attachment and version uploaders.
- **Three mount sites afterwards.** `/knowledge-base*` — the full Finder with
  the root column. `/projects/:id/docs` (`ProjectDocsTab`) — the Finder with
  the project's Documents folder as column 0 and no root column; the
  project's other spaces (ad-hoc ones filed under it) appear as
  space-folder rows at the top of that column, because in project scope the
  shared group does not exist and they must still be reachable. The agent
  Documents tab (`AgentDocumentsTab`) — the Finder with the agent home as
  column 0, its warning `Notice` kept above.

## Deliberately left out, and why

- **Retrieval over shared pages.** A page shared with you appears in Shared
  with me and opens, but your search does not return its passages. The
  chunk-scope mirror (`KnowledgePageChunk`) has no per-person arm, and adding
  one is a retrieval change (`docs/standards/embeddings.md`,
  `2026-07-06-documents-rag-redesign.md`). Stated in the Share dialog and
  Get Info as "Shared pages are not included in the recipient's search".
- **Re-sharing by an edit recipient, and edit recipients publishing, moving
  or deleting.** An edit grant is a grant to change content; the tree and
  the audience stay the owner's ([data-and-api.md](data-and-api.md) §2).
- **Copy/paste or duplicate inside one root.** A transfer needs two roots;
  an in-space duplicate is a separate feature nobody asked for.
- **A Trash.** See decision 13.
- **Quick Look (Space to preview).** The document pane is the preview; a
  second preview surface would be a fork.
- **Column-specific widths.** One shared width, as today
  (`knowledgeColumnWidth`).
- **Tags, colour labels, comments in Get Info.** Labels exist on pages and
  stay editable in the editor; the Finder does not add a second editor.
- **Spreadsheets, entirely.** The owner's instruction is to leave them
  alone until they are done. This design is built against `main` as it
  stands — no `spreadsheet` kind, no import from any `agent/sheets-*`
  branch, no merge-order coordination. It reserves exactly one seam: the
  New file picker's item registry ([menus-and-dialogs.md](menus-and-dialogs.md) §6),
  where a future integrator adds one entry.
- **Reordering rows by drag (position).** Sort by name/date/size/kind makes
  manual position a fourth ordering; `position` remains the tie-breaker under
  Name and is set by creation order.

## Contradictions between the brief and the code

The code won in every case.

1. **`KnowledgeColumns.tsx` no longer hand-rolls an `admin-card` column.** It
   sits on `ColumnBrowserColumn` with the shared `resize` handle and on
   `ColumnBrowserViewport` with `columnWidth`. The 2026-09-01 audit that the
   brief cites predates that convergence; the audit's other stale claims
   (`KnowledgeItemRow` bespoke — it is the shared `Row`; `NewFolderRow` a
   raw input — it is the shared `Input`) are stale too. What still differs is
   the *row* (`Row` vs `ColumnBrowserItem`'s card), which this design settles
   in favour of a flat row for both.
2. **The redesign does not land in `ProjectDocumentsSection.tsx`.** That file
   is the project Overview's "Latest documents" card. The project mount of the
   knowledge workspace is `admin/src/pages/project/ProjectDocsTab.tsx`, which
   also carries its own navy `KnowledgeSpaceList` rail — a second navy
   column the brief did not name and this design removes.
3. **The API contract omits `kind`.** `KnowledgePageRecordSchema` in
   `api/src/contracts/knowledge-base.ts` has no `kind` and no `revision`,
   while the provider record and the admin type both carry them and the
   route spreads the record onto the wire unparsed. Wave 0 fixes the drift.
4. **Known collision, deliberately not coordinated.** Spreadsheet code
   exists on `agent/sheets-api` (a migration adding `spreadsheet` to
   `KnowledgePageKind`, `POST /api/knowledge-base/spaces/:spaceId/spreadsheets`
   and fourteen more routes) and `agent/sheets-ui` (`useCreateSpreadsheet`,
   `SpreadsheetCreateDialog`, a `faTable` row icon), and `agent/sheets-ui`
   edits six files this design replaces: `KnowledgeWorkspace`,
   `knowledge-workspace-actions`, `KnowledgeFilesystemRows`,
   `KnowledgeDocumentPane`, `FileNodeViewer`, `PageEditor`. The owner has
   decided the collision is that branch's to rebase; this design does not
   design around it and carries no dependency on it. Recorded so the
   integrator is not surprised.
5. **`movePage` is within-space only.** The provider requires the new parent
   to be in the page's own space and never changes `spaceId`. A Finder move
   between My Documents and a project is therefore new API surface
   ([transfer.md](transfer.md)), not a widened `movePage`.
5a. **`FileService` has no copy and no scope transfer.** Its surface is
   `store`, `openStream`, `openDownload`, `delete`, the two purges, quota
   and usage reads; `Attachment` rows carry no space, and scope lives only
   in `StorageUsageEvent` rows. `file-storage.md` makes the ledger part of
   the file operation, so a cross-space move needs `FileService.reassignScope`
   and a copy needs `FileService.copy`, both new ([transfer.md](transfer.md) §2–3).
5b. **`KnowledgePageAnnotation` denormalises `spaceId`.** A move must
   rewrite it or comments stop resolving in the new space.
6. **`DELETE /pages/:pageId` archives.** It sets `status = 'archived'` and
   purges the page's stored files through `FileService` first. Nothing is
   restorable, so "Move to Trash" would be a lie (decision 13).
7. **`GET /api/knowledge-base/spaces` takes `includePersonal`**, absent from
   the brief's route list; the personal space is excluded from the paged
   list by default and read through `POST /my-docs`, which the root keeps
   doing.
8. **`knowledge-base-files.ts` is 619 lines**, also over the 500 cap; the
   brief named only `knowledge-base.ts` (666). Neither grows here: every new
   route lands in new files.
9. **The phone root page is the sidebar today.** `/knowledge-base` is
   `contextualList: true`, so on `single` the root screen is
   `KnowledgeSidebarNav` rendered as a page. Deleting the sidebar therefore
   changes the phone root, which the brief did not mention; the row loses
   the flag and the Finder root is the page.
10. **Documents are indexed on publish, not on save.** `publishPage` calls
    `indexVersionChunks`; a draft document has no chunks. "Searchable" for a
    document therefore means "published", and the honest row state for a
    draft is "Not indexed — draft" ([uploads-and-indexing.md](uploads-and-indexing.md) §4).

## Owner decisions recorded (2026-09-16)

The first draft asked eleven questions. The answers, now part of the
contract:

| # | Question | Answer | Effect |
|---|---|---|---|
| 1 | Delete | archive with confirm, no Trash | decision 13 stands |
| 2 | Share level | "Read and download, but I can grant them edit if I want to" | decision 2 revised: `view` \| `edit`; [data-and-api.md](data-and-api.md) §2 |
| 3 | Moves across roots | "If we're moving between spaces, we need to ask if it's a copy or move" | decision 14 overturned; [transfer.md](transfer.md) |
| 4 | Spreadsheet merge order | "Leave the spreadsheets alone. They're going to get integrated once they're done." | no dependency, no coordination; contradiction 4 reframed; the picker seam kept |
| 5 | Dashboards as the root's last row | yes | stands |
| 6 | Ad-hoc project spaces in the shared group, project in the subtitle | yes | stands |
| 7 | Agent homes in the shared group | yes | stands |
| 8 | Shared with me = pages shared to you, not spaces | yes | stands |
| 9 | Latest 50 a page, newest modified first, folders excluded | yes | stands |
| 10 | Multi-select with the minimal menu | yes | stands |
| 11 | Task folders as plain folders | yes | stands |

## Open for the owner in the two new pieces

Each has the default the design takes.

1. **Ordinary widening is allowed, with a sentence.** Moving a private
   document into a project folder makes it visible to the project; the
   prompt says so and proceeds. Only material with a version basis the new
   audience cannot satisfy is refused ([transfer.md](transfer.md) §4.1). If
   you want *every* audience widening to need a second confirmation, say
   so — it is one more item in the prompt.
2. **A copy carries the current version only**, with the change comment
   "Copied from {space}"; the history stays with the source.
3. **An edit recipient may change content and rename, but not publish,
   move, delete or re-share.** Publishing stays the owner's act.
4. **500 pages** is where a transfer becomes a background job.
5. **Alt/⌥ on release copies without asking**; nothing else is a modifier.
6. **A read-only viewer of a shared folder may copy out of it** into a
   folder they can write (they can already read every byte); they cannot
   move out (no write on the source). Refuse copying too if you prefer.

## Standards this design lives inside

`AGENTS.md` → Rule zero (every action below names its doorway);
`docs/standards/design-system.md` (tokens only, no nesting, one primary per
header, 44px targets, measured collapse, one dialog shell, one identity
tile); `docs/navigation/overview.md` §1 tab hosts and `?state` params, §6
nested stages, §7 overlays, §8 intents, §9 screen headers;
`docs/standards/file-storage.md` (one `FileService`, streaming, quota, BigInt
as string); `docs/standards/agent-documents.md` (provisioners);
`docs/standards/disclosure-boundaries.md` (version basis is checked on every
read path, including the new ones); `docs/standards/embeddings.md`;
`docs/standards/team-model.md` (rule 2: every project member has equal
rights; rule 3: org owner/admin outside). Cited, never restated.
