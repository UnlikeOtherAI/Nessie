# Documents as a Finder — verification and waves

Part of [the Finder plan](overview.md). The browser cases an e2e suite
asserts, the unit tests that pin the pure parts, the implementation waves
with exclusive file lists and their dependency edges, and the documents that
change with the code. This design carries no dependency on any spreadsheet
branch and coordinates no merge order with one (overview → "Owner decisions
recorded", 4).

## 1. Playwright cases — `admin/e2e/documents-finder/run.mjs`

Headless `playwright-core` against `http://localhost:5455` and `:5454`, in
the shape of `admin/e2e/knowledge-markdown/run.mjs`: start both dev servers
against `DATABASE_URL`, `dev-login`, seed through the API, drive the
browser, assert through both the screen and the API, screenshot into
`e2e/screenshots/documents-finder/<case>.png`. Two signed-in people are
needed (the sharer and the recipient): the suite creates the second user
through `POST /api/users` in an unbound install, the way
`member-management` seeds, and signs in with a second `dev-login` for that
user (add `?userId=` support to `dev-login` if it does not accept one; it is
a dev-only route). Registered as `test:e2e:documents-finder` and run in the
Navigation Transitions job after the project-usability lifecycle runner.

Seed (once): one project `P` with the caller as member; a second project
`Q` the caller is **not** in; under My Documents a folder `Contracts` with a
document `Plan` (published), a draft `Ideas`, an uploaded `lease.pdf`
(text-bearing) and an uploaded `photo.png`; a shared space `Marketing`
(visibility `organization`) with one document; a folder `Empty`; an
agent-owned space if an agent exists in the fixture (skip its cases
otherwise, saying so in the log).

### The browser, rows and menus

| Id | Steps | Asserts | Screenshot |
|---|---|---|---|
| F-ROOT-01 | open `/knowledge-base` | column 0 lists exactly: Latest, Shared with me, separator, My Documents, `P`, separator, Marketing, separator, Dashboards — and **not** `Q`; no `aside` with `bg-[color:var(--sb)]` inside the content region (the navy column is gone); `h1` text is "Documents" | `root.png` |
| F-ROOT-02 | click `P` | `POST /api/knowledge-base/projects/P/documents` fired once; URL is `/knowledge-base/spaces/<id>`; column 1 header reads `P`; a second click on `P` fires no POST | `project-first-open.png` |
| F-ROOT-03 | click Dashboards | URL `/dashboards`; the Knowledge rail item is `aria-current` | — |
| F-ROOT-04 | as a user with no projects (second user) open `/knowledge-base` | root has no project rows and no empty-state sentence between the separators | `root-no-projects.png` |
| F-ROOT-05 | right-click the root's empty area → "New shared folder…" → name `Ops`, visibility Project → Create | a new root row `Ops` with subtitle `P`; `GET /spaces` shows it with `visibility: 'project'` | `new-shared-folder.png` |
| F-COL-01 | My Documents → Contracts | three columns; `?folder=<Contracts id>` in the URL written without a history entry (`history.length` unchanged); reload lands on the same three columns | `columns.png` |
| F-COL-02 | drag the column-1 resize handle 120 px right | every column's width equals the new value; cookie `knowledgeColumnWidth` updated | — |
| F-COL-03 | open `Empty` | the column body reads "No files in this folder." | — |
| F-ROW-01 | in Contracts, the row `lease.pdf` | icon is the PDF glyph with `color` equal to the computed `--danger`; `Plan` has the document glyph in `--accent`; `Contracts` in column 1 has the folder glyph and a chevron; `photo.png` shows the `faMagnifyingGlassMinus` glyph with `title` "Not indexed — Images aren't searchable" | `row-icons.png` |
| F-ROW-02 | click `Plan` | the row has `aria-selected="true"`, computed `background-color` equals `--accent` and `color` equals `--on-accent`; the document pane opens to the right; column 1's `Contracts` row is `aria-selected` with `--overlay` background (inactive selection) | `selected-pill.png` |
| F-ROW-03 | seed a document with a 70-character title; narrow the column to 300 | the rendered name contains `…` in the middle and ends with the last characters of the title; `aria-label` is the full title | `middle-truncate.png` |
| F-ROW-04 | hover `Plan` (fine pointer) | background `--overlay-weak`; on the mobile preset no hover paint | — |
| F-KEY-01 | focus the first row of Contracts; press ↓, ↓, Home, End, → on a folder, ← | selection follows the key table in [browser-ui.md](browser-ui.md) §7; after → the child column's first row has focus; after ← the parent folder row has focus | — |
| F-KEY-02 | select `Plan`, press F2, type `Plan 2026`, Enter | `PATCH /pages/<id>` sent with `If-Match`; the row reads `Plan 2026`; the pages list from the API agrees | `rename.png` |
| F-KEY-03 | press Escape during a rename | the row reverts; no PATCH | — |
| F-KEY-04 | select `Plan`, Cmd/Ctrl-click `Ideas` | two rows `aria-selected`; status bar reads "4 items, 2 selected" | — |
| F-MENU-01 | right-click `lease.pdf` | a `role="menu"` panel with `aria-label` "Actions for lease.pdf" is within the viewport; its first item has focus; items in order: Open, Download, Get Info, Sharing…, Version history, Upload new version…, Rename, Move to…, Copy link, Delete… (separators between groups); the native menu did not open | `menu-file.png` |
| F-MENU-02 | right-click near the bottom-right corner of the viewport | the panel is fully inside the viewport (flipped) | `menu-flipped.png` |
| F-MENU-03 | focus a row, press Shift+F10 | the menu opens anchored under the row; Escape closes it and focus is back on the row | — |
| F-MENU-04 | right-click a row in Marketing as a user who cannot write (second user, org visibility) | Rename, Move to…, Delete… are absent; Get Info and Sharing… present | `menu-readonly.png` |
| F-MENU-05 | mobile preset, long-press `Plan` 600 ms | a bottom `role="dialog"` sheet with the same items; hardware/back closes it | `menu-phone-sheet.png` |
| F-MENU-06 | right-click a folder column's empty background | items: New folder, New document, Upload files…, Get Info, Sharing… | — |
| F-INFO-01 | Get Info on `Contracts` | the `<dl>` has Kind "Folder", Size equal to `formatBytes` of the API's `sizeBytes` and "for 4 items", Contains matching the API counts, Where "My Documents", Search equal to the API's `indexing` triple, Sharing "Only you, so far." | `get-info-folder.png` |
| F-INFO-02 | Get Info on `lease.pdf` after indexing completes (poll the API up to 60 s) | Search reads "Searchable"; Size equals the attachment's bytes | — |
| F-INFO-03 | Get Info on My Documents (root row) | Kind "Your documents"; On disk equals `GET /storage-usage?scopeType=space` | — |
| F-NEW-01 | in Contracts click the primary "New file" | a `role="menu"` with exactly two items, Document and Upload… | `new-file-menu.png` |
| F-NEW-02 | Document | the editor stage opens with Contracts preselected as the location; Cancel returns to the column with Contracts still open | — |
| F-NEW-03 | New folder in Contracts, type `2026`, Enter | `POST /spaces/<id>/pages` body has `kind: 'folder'`, `parentPageId` = Contracts; the new row is a folder and is selected; the API record has `kind: 'folder'` and no `latestVersion` | `new-folder.png` |
| F-NEW-04 | New folder at the root column | the "New shared folder" dialog opens (F-ROOT-05 covers the rest) | — |
| F-SORT-01 | Sort → Size | `?sort=size`; folders still first; files ordered by `sizeBytes` ascending with documents after them and the label reads "Sort: Size ↑"; Sort → Descending flips | `sort-size.png` |
| F-SORT-02 | reload | the sort persists (cookie `knowledgeSort`) and the URL param is absent for the default only | — |
| F-SORT-03 | open Latest | the Sort action is `aria-disabled` with the tooltip sentence | — |
| F-VIEW-01 | View → List | `?view=list`; one folder at a time with the breadcrumb and a header row Name / Date modified / Size / Kind; clicking Size sets `?sort=size` | `list-view.png` |
| F-VIEW-02 | open `/knowledge-base?view=tree` | the view is `list` (unknown value degraded); no `?view=tree` remains after the first interaction | — |
| F-LATEST-01 | edit `Plan`, then open Latest | `Plan` is the first row with the home line "My Documents › Contracts"; folders are absent; the row's menu has "Show in folder"; choosing it lands on `/knowledge-base/spaces/<id>?folder=<Contracts>` with `Plan` selected | `latest.png` |
| F-LATEST-02 | seed 60 documents | 50 rows, a "Load more" row, then 60 after clicking it; `meta.nextCursor` null on the second page | — |
| F-MOVE-01 | drag `Plan` onto the `2026` folder row (same root) | `POST /pages/<id>/move` with `parentPageId` = 2026; no prompt; `Plan` is gone from Contracts and present in 2026 | `move.png` |
| F-MOVE-02 | Move to… on `Plan`; pick a folder in the same root | one primary "Move"; Contracts marked "(current)"; a descendant of a moving folder is disabled | `move-to.png` |
| F-DELETE-01 | Delete… on `2026` (a folder with `Plan` inside) | the confirm reads "Delete “2026”?" with the folder body sentence; Delete sends `DELETE /pages/<id>`; both are gone; the API pages list shows `status: 'archived'` for both | `delete-confirm.png` |
| F-PROJECT-01 | open `/projects/P/docs` | column 0 is `P`'s Documents listing (no root column, no navy rail); the `Ops` space (F-ROOT-05) appears as a root-variant row above a separator | `project-docs-tab.png` |
| F-AGENT-01 | (if an agent with a home exists) open its Documents tab | column 0 is the home's listing under the existing warning notice; "Open agent" is absent (it is the scoping agent) | `agent-docs-tab.png` |
| F-PHONE-01 | mobile preset, `/knowledge-base` | the root column is the page; header title "Documents"; tapping My Documents pushes `/knowledge-base/spaces/<id>` (`history.length` +1); tapping Contracts pushes a stage; Back unwinds one level each time; reload at `?folder=` lands with the ancestors seeded | `phone-root.png`, `phone-folder.png` |
| F-PHONE-02 | mobile preset | the View action is absent from the header; Sort present | — |
| F-THEME-01 | for each theme id in `styles.css`: set `data-theme`, select `Plan` | screenshot; the selected row's computed `background-color` equals the theme's `--accent` and the column background its `--main`; in `contrast` the separator colour equals `--sep` | `theme-<id>.png` |
| F-A11Y-01 | axe-core over the root and a folder column | no violations of `aria-required-children`, `color-contrast` on the pill, or `button-name` | — |
| F-GONE-01 | grep the served bundle | no occurrence of `KnowledgeSidebarNav`, `KnowledgeSpaceList`, `knowledgeViewMode=tree` | — |

### Sharing, both levels

| Id | Steps | Asserts | Screenshot |
|---|---|---|---|
| F-SHARE-01 | as the sharer: right-click `Plan` → Sharing… | the dialog title is "Share “Plan”"; the sentence containing "nobody has to approve it" is on screen; the level control shows "Can view" selected | `share-dialog.png` |
| F-SHARE-02 | pick the second user (level left at Can view) | `POST /pages/<id>/shares` body `{ granteeUserId, access: 'view' }` returned 201; the row shows the `faUserGroup` glyph with `title` "Shared with 1 person"; `GET /api/approvals` contains **no** new approval; an audit row `kb.page.shared` with `access: 'view'` | `share-added.png` |
| F-SHARE-03 | as the recipient: open `/knowledge-base/shared-with-me` | one row `Plan` with subtitle "{Sharer} · Can view" and the home line "{Sharer}'s documents › Contracts"; opening it renders the document; `GET /pages/<id>` is 200 | `shared-with-me.png` |
| F-SHARE-04 | as the recipient (view): right-click `Plan` | Edit, Rename, Delete…, Move to… absent; "Remove from Shared with me" present; Sharing… opens the read-out "{Sharer} shared this with you."; `PATCH /pages/<id>` with a title → 403 | `shared-readout.png` |
| F-SHARE-05 | as the recipient: `GET /spaces/<sharer's My Docs>/pages` without `sharedRootPageId` | 403 | — |
| F-SHARE-06 | as the sharer: share the **folder** `Contracts` (view); as the recipient open it from Shared with me | `GET /spaces/<id>/pages?sharedRootPageId=<Contracts>` is 200 and lists its children; a sibling outside the folder is not listed | `shared-folder.png` |
| F-SHARE-07 | as the sharer: in the Share dialog change the recipient's level to Can edit | `PATCH /pages/<id>/shares/<grantee>` `{ access: 'edit' }` → 200; audit `kb.page.share_changed` `{ from: 'view', to: 'edit' }`; the row's button reads "Can edit ▾" | `share-level-edit.png` |
| F-SHARE-08 | as the recipient (edit): the Shared with me row | subtitle "{Sharer} · Can edit"; menu has Edit and Rename; Publish, Move to…, Delete…, and Sharing's Share button absent; the read-out sentence is the edit variant | `shared-edit-menu.png` |
| F-SHARE-09 | as the recipient (edit): open the editor, change the body, Save | `PATCH /pages/<id>` → 200; a new `KnowledgePageVersion` with `authorType: 'user'`, `authorId` = recipient; Version history (as the sharer) names the recipient through `ActorName` with "(person)" and no other marker; the page's `spaceId` and every chunk's scope columns unchanged (SQL) | `share-edit-version.png` |
| F-SHARE-10 | as the recipient (edit): `POST /pages/<id>/publish`, `POST /pages/<id>/move`, `DELETE /pages/<id>`, `POST /pages/<id>/shares` (re-share) | every one 403; nothing changed | — |
| F-SHARE-11 | as the recipient (edit) on the shared folder `Contracts`: New folder inside → `Notes`; New document inside | both created with `createdBy` = recipient in the sharer's space; the sharer sees them in Contracts; a sibling folder of Contracts is still 403 to write | `share-edit-create.png` |
| F-SHARE-12 | as the sharer: Remove the recipient | `DELETE` 204; the recipient's `GET /pages/<id>` is now 403/404; the glyph is gone | — |
| F-SHARE-13 | as a member of `P`: right-click a document in `P` → Sharing… | the read-out "Everyone in the project P can see this." with the member list; no picker, no level control, no Share button | `project-readout.png` |
| F-SHARE-14 | as any user: `POST /pages/<Marketing doc>/shares` directly | 403 `SHARE_NOT_PERSONAL` | — |
| F-SHARE-15 | as the sharer: share `Ideas` (a draft) with the recipient; as the recipient open it | the draft opens; no "Needs review", no `AgentDraftBadge`; as the recipient with edit, a saved change stays a draft version (publish is 403) | — |

### Uploads and indexing

| Id | Steps | Asserts | Screenshot |
|---|---|---|---|
| F-UPLOAD-01 | drop three files (`a.txt`, `b.pdf`, `c.png`) on the Contracts column via `page.setInputFiles` on the hidden input (the drop handler and the input share `enqueue`) | three placeholder rows appear in name order with "Waiting"/"{pct}%"; the status bar shows "Uploading 1 of 3 · a.txt …"; three `POST /spaces/<id>/files?parentPageId=<Contracts>` requests | `upload-queue.png` |
| F-UPLOAD-02 | after completion | the three real rows replace the placeholders; `a.txt` and `b.pdf` show the spinner then nothing (poll until `indexing.state === 'indexed'`), `c.png` shows the not-indexed glyph with the image sentence; the tray shows "3 files uploaded" then disappears | `upload-done.png` |
| F-UPLOAD-03 | set the organisation `Budget.storageLimitBytes` to 1 byte, drop two files | the first row reads "Not uploaded — storage is full", the second "Skipped — storage is full", the meter is `--danger`; Retry on the second re-queues both | `upload-quota.png` |
| F-UPLOAD-04 | drop onto the root column | nothing uploads; the status bar reads "Drop files into a folder to upload them" | — |
| F-UPLOAD-05 | as the read-only second user in Marketing, drop a file | refused; "You can't add files here" | — |
| F-INDEX-01 | upload a 25 MB text file | glyph `title` "Not indexed — larger than 20 MB"; API `indexing` is `not_indexed/too_large`; no `knowledge.extract` job exists for it | — |
| F-INDEX-02 | force a failed extract job in the DB for `b.pdf` | the row shows the `--warning` triangle; "Retry indexing" POSTs `/reindex` → 202; the glyph turns to the spinner | `index-failed.png` |
| F-INDEX-03 | the draft `Ideas` | glyph absent, Get Info Search "Not indexed — draft documents are indexed when published"; Publish from the menu → after the poll, "Searchable" | — |

### Transfers

F-XFER-01 … F-XFER-17 are enumerated in [transfer.md](transfer.md) §7 and
belong to this suite; they cover both directions, the widening refusal
(F-XFER-09/10), the ledger pair (F-XFER-04), a quota-aborted copy leaving
nothing behind (F-XFER-08), the copy-only path for a read-only source
(F-XFER-13), the queued job (F-XFER-14) and a partial failure with retry
(F-XFER-15).

Every case that changes data cleans up through the API at the end so the
suite is re-runnable on a shared DB (`docs/standards/testing.md`).

## 2. Unit and integration tests

| File | Pins |
|---|---|
| `api/test/knowledge-finder-root.test.ts` (DB) | the three groups; personal excluded from shared; `Q` absent; `sharedTruncated` at 201; agents get 403 |
| `api/test/knowledge-finder-latest.test.ts` (DB) | ordering, cursor, folder exclusion, `readableSpaceIdsSql` reach, version-basis filtering, `home.parentPath` |
| `api/test/knowledge-shares.test.ts` (DB) | every refusal code in [data-and-api.md](data-and-api.md) §2; both levels; the edit arm allows PATCH/file-version/attachments/create-under-folder and refuses publish/move/transfer/archive/re-share; `minimum` semantics with a view folder over an edit document; folder inheritance; archive hides; grantee revoke; level change audit; **no `Approval` row is created**; the `knowledge_shared` alert row |
| `api/test/knowledge-transfers.test.ts` (DB) | [transfer.md](transfer.md): every refusal; a move rewrites pages, chunks, annotations, ends shares, writes the ledger pair, leaves versions and attachments in place; a copy creates new pages, one version, new attachments with store events, no chunks, no shares/annotations/links/taskId/core role; quota abort leaves nothing; > 500 enqueues; the widening rule table |
| `worker/test/knowledge-transfer.test.ts` | batches, progress, partial failure semantics for move and copy, retry of the remainder |
| `packages/runtime/test/file-service-transfer.test.ts` | `reassignScope` writes a zero-sum pair per attachment incl. thumbnails; `copy` streams through `store` with quota; both refuse a cross-organisation attachment |
| `api/test/knowledge-page-info.test.ts` (DB) | sizes and counts on a seeded tree; `truncated` at 10 001; `storageBytes` counts retained versions and drawer attachments; space target uses the ledger |
| `packages/knowledge/test/indexing-status.test.ts` (DB) | every branch of the derivation table, including a failed job and an empty extract |
| `packages/knowledge/test/provisioning.test.ts` | `ensureTaskFolder` creates `kind: 'folder'`, no version; idempotent on the new lookup |
| `api/test/knowledge-folder-kind.test.ts` (DB, migration) | applies the chain to a throwaway DB, seeds pre-migration rows and asserts the backfill outcome per row |
| `admin/test/context-menu.test.ts` | [menus-and-dialogs.md](menus-and-dialogs.md) §1's list |
| `admin/test/finder-menu.test.ts` | `buildFinderMenu` for every table row in §2, including the virtual, read-only, view-grantee and edit-grantee variants |
| `admin/test/transfer-prompt.test.ts` | the item list per audience and share count; Alt skips the prompt; a refusal replaces the items; Escape sends nothing |
| `admin/test/finder-sort.test.ts` | folders first; each key; nulls last for size; numeric name collation |
| `admin/test/finder-selection.test.ts` | click/toggle/range/select-all/escape; open-folder resets |
| `admin/test/middle-truncate.test.ts` | keeps the extension and tail; full title on the label |
| `admin/test/finder-root-column.test.ts` | row order and separators from a `KnowledgeRoot` fixture; no-projects case |
| `admin/test/upload-queue.test.ts` | concurrency 2, folder-first ordering, quota cascade to `skipped`, retry re-queues, cancel aborts |
| `admin/test/indexing-copy.test.ts` | the `Record` is exhaustive (type-level) and every sentence matches the table |
| `admin/test/share-dialog.test.ts` | default level view; add with edit posts `access: 'edit'`; level menu patches; the search sentence is present at both levels |
| `admin/test/tab-param.test.ts` | the host table gains `view: columns · list` and `sort: …`; `tree`/`full` removed; the Share dialog's level radiogroup joins the form-field allowlist |
| `admin/test/knowledge-local-back.test.ts` | the folder stage id `knowledge:folder` no longer exists; the three remaining priorities unchanged |
| `admin/test/navigation-surfaces-total.test.ts` | the two virtual routes have rows; `/knowledge-base` has no `contextualList` |
| `admin/test/query-key-invariants.test.ts` | the new keys are under family roots |
| `admin/test/page-header-actions.test.ts` | exactly one primary in the Finder toolbar in every capability combination |

## 3. Waves

Rules every wave follows: one worktree and branch per agent; a wave's files
are exclusive — two agents never edit one file; an agent imports another
wave's exported names only as declared in this directory; every file stays
under 500 lines; the orchestrator integrates each branch into the integration
branch and runs the full Turbo test chain with `DATABASE_URL` and
`--no-daemon` before starting the next wave. Nothing is imported from, or
rebased against, any spreadsheet branch.

### Wave 0 — the contract (one agent, before anything else)

Owns:

- `api/prisma/schema.prisma` — `folder` in `KnowledgePageKind`;
  `KnowledgePageShare` + `KnowledgePageShareAccess { view edit }`;
  back-relations; the rewritten kind comment.
- `api/prisma/migrations/<ts>_knowledge_folder_kind/`, `<ts+1>_knowledge_folder_backfill/`,
  `<ts+2>_knowledge_page_shares/` ([data-and-api.md](data-and-api.md) §1–2).
- `packages/schemas/src/knowledge-finder.ts` (new: every schema in
  data-and-api.md **and** transfer.md — `TransferPagesBodySchema`,
  `TransferResultSchema`, the transfer status shape), `packages/schemas/src/knowledge.ts`
  (`KnowledgePageKindSchema = ['document','file','folder']`),
  `packages/schemas/src/index.ts`, `packages/schemas/src/jobs.ts`
  (`KNOWLEDGE_EXTRACT_MAX_ATTACHMENT_BYTES`, `KNOWLEDGE_TRANSFER_TOPIC`,
  `KnowledgeTransferJobPayloadSchema`), `packages/schemas/src/realtime.ts`
  (alert kind `knowledge_shared`, reader side only).
- `packages/knowledge/src/types.ts` (kind union; record fields `mime`,
  `sizeBytes`, `shareCount`, `indexing`, `transfer`), `packages/knowledge/src/extractable.ts`
  (the moved predicate; `api/src/routes/knowledge-base-file-extract.ts` and
  `worker/src/control/knowledge-extract.ts` switch to the import — two-line
  edits done here so no later wave touches them).
- `packages/knowledge/src/native-provider.ts` — `createPage` folder
  semantics, `movePage` parent-kind check, `publishPage`/`indexVersionChunks`
  folder guard; nothing else.
- `packages/runtime/src/files/index.ts` — the **signatures** of
  `FileService.copy` and `FileService.reassignScope` and the two
  `StorageStoreOperation` values, each throwing `NotImplemented` until 1E
  fills them; `packages/runtime/src/storage-usage-ledger.ts` gains the two
  operation strings. Declared here so 1E and every consumer compile against
  one shape.
- `api/src/contracts/knowledge-base.ts` — `kind`, `revision` and the new
  fields on `KnowledgePageRecordSchema`; `CreateKnowledgePageBodySchema.kind`;
  re-exports.
- Stubs `api/src/routes/knowledge-finder.ts`, `knowledge-shares.ts`,
  `knowledge-shared-with-me.ts`, `knowledge-transfers.ts` exporting
  `register…Routes` that register nothing, and `api/src/register-api-routes.ts`
  calling all four; `worker/src/control/knowledge-transfer.ts` as a stub
  and its `subscribe` line in `worker/src/worker-subscriptions-core.ts`.
- `admin/src/facades/knowledge/hooks.ts` — type additions only.
- `api/test/knowledge-folder-kind.test.ts`.

Done when: migrations apply to a throwaway pgvector container and the
backfill test passes; `pnpm typecheck` is green everywhere. The new record
fields are `.optional()` in Wave 0 and 1A removes the `.optional()` when it
fills them — the one deliberate two-step, noted in the schema file.

### Wave 1 — five agents in parallel, all from Wave 0's tip

**1A — listings, info, indexing (API + provider).**
`packages/knowledge/src/native-latest-pages.ts`, `native-page-info.ts`,
`native-indexing-status.ts`, `native-root.ts`, `native-list-enrichment.ts`
(listPages' size/mime/shareCount/indexing/transfer join, called from
`native-provider.ts`'s `listPages` — the one line 1A adds there);
`native-recent-pages.ts` (folder exclusion); `api/src/routes/knowledge-finder.ts`
(root, latest, page/space info, reindex, `projects/:id/documents`); tests
`api/test/knowledge-finder-*.test.ts`, `api/test/knowledge-page-info.test.ts`,
`packages/knowledge/test/indexing-status.test.ts`.

**1B — sharing (API + access).**
`packages/knowledge/src/page-shares.ts`; `packages/knowledge/src/access.ts`
(`pageSharedWithUser` with `minimum`, `sharedPageIdsSql`);
`api/src/routes/knowledge-shares.ts` (list/create/patch/delete, audit; not
the alert write — that is 2A); `api/src/routes/knowledge-base-access.ts`
(the view arm in `accessPageSpace('read')`, the edit arm in
`accessPageSpace('write')`, and `requirePageOwnerWrite`);
`api/src/routes/knowledge-base.ts` (three edits, the only ones to that
file: `sharedRootPageId` on the pages list via a function imported from
`knowledge-shares.ts`; create-under-shared-folder in `POST /spaces/:id/pages`;
`requirePageOwnerWrite` on publish, move and archive);
`api/src/routes/knowledge-base-files.ts` (`requirePageOwnerWrite` is *not*
needed there — file-version and attachment routes are content writes and
keep `accessPageSpace('write')`; listed so nobody adds it);
`api/src/routes/knowledge-shared-with-me.ts`; `api/test/knowledge-shares.test.ts`.

**1C — shared admin primitives.**
`admin/src/components/overlays/ContextMenu.tsx`, `useContextMenu.ts`;
`admin/src/components/shared/PersonPicker.tsx`; `admin/src/hooks/useFileDrop.ts`
(directory entries, caps, the `Files` guard); `admin/src/lib/upload-xhr.ts`
(`onAbort`, returns the xhr); `admin/src/lib/platform.ts`;
`admin/src/components/shared/DropZoneOverlay.tsx` (label with count);
`admin/test/context-menu.test.ts`, `admin/test/use-file-drop.test.ts`.
1C touches no `features/knowledge/*` file.

**1D — the Finder shell (admin).**
`admin/src/components/features/knowledge/finder/{DocumentsFinder,FinderRootColumn,FinderFolderColumn,FinderVirtualColumn,FinderListView,FinderRow,FinderStatusBar,NewFolderRow}.tsx`,
`finder/{finder-sort,finder-selection,finder-view,finder-toolbar-actions}.ts`,
`finder/{useFinderKeyboard,useFinderDrag}.ts` (in-space drag only; the
cross-root branch is 2D's); `admin/src/components/shared/MiddleTruncate.tsx`,
`components/shared/RowList.tsx` (`size`, `selectionStyle`, drag
passthrough), `components/shared/file-icons.ts`;
`admin/src/facades/knowledge/finder-hooks.ts`, `keys.ts`;
`features/knowledge/{KnowledgeProvider,KnowledgeWorkspace}.tsx`,
`{useKnowledgeNavigation,useKnowledgeMutations}.ts`;
`admin/src/pages/KnowledgeBasePage.tsx`, `pages/project/ProjectDocsTab.tsx`,
`features/agents/AgentDocumentsTab.tsx`; `admin/src/router.tsx`,
`navigation/surfaces.ts`, `layouts/AdminShellLayout.tsx`;
`admin/src/styles.css` (the `.finder-row*` pill rules); **deletions**:
`layouts/admin-shell/KnowledgeSidebarNav.tsx`,
`features/knowledge/{KnowledgeSpaceList,KnowledgeSidebarPageTree,KnowledgeColumns,KnowledgeFilesystemBrowser,KnowledgeFilesystemRows,KnowledgeViewToggle}.tsx`,
`knowledge-workspace-actions.ts`, `example-page.ts`, `useSeedKnowledgeBase`
from `hooks.ts`; tests `admin/test/{finder-sort,finder-selection,middle-truncate,finder-root-column}.test.ts`
and the updates to `tab-param`, `knowledge-local-back`,
`navigation-surfaces-total`, `query-key-invariants`, `page-header-actions`.
1D renders every `FinderRow` variant (incl. `upload` and the transferring
state) and the toolbar's menu *shells* but wires no context menu, no
dialogs, no upload queue and no cross-root drop: `FinderRow` takes
`onContextMenu?`, `FinderFolderColumn` takes `onBackgroundContextMenu?`,
`uploadEntries?`, `dropHandlers?` and `onForeignDrop?(rows, target, point, altKey)`,
all left unconnected until Wave 2. 1D does not import from 1C or 1E.

**1E — transfers (API + runtime + worker).**
`packages/runtime/src/files/index.ts` (the bodies of `copy` and
`reassignScope`), `packages/runtime/src/storage-usage-ledger.ts` (the pair
writer); `packages/knowledge/src/transfer/{collect,move,copy,basis-check}.ts`;
`api/src/routes/knowledge-transfers.ts` (route, refusals, sync path,
enqueue, status read); `worker/src/control/knowledge-transfer.ts` (batches,
progress, failure semantics); tests `api/test/knowledge-transfers.test.ts`,
`worker/test/knowledge-transfer.test.ts`, `packages/runtime/test/file-service-transfer.test.ts`.
1E imports `pageSharedWithUser`? No — a transfer requires owner write on the
source, so it needs nothing from 1B; it calls `isAgentCoreDocumentPage`
(exists) and the provisioning `taskId` facts (exist).

Dependency edges: 1A, 1B, 1C, 1D, 1E → Wave 0. None between them.

### Wave 2 — four agents in parallel, from the integrated Wave 1 tip

**2A — menus and dialogs.** `finder/{FinderContextMenus,GetInfoDialog,ShareDialog,AccessReadoutDialog,NewFilePicker,RenameRow}.tsx`,
`finder/new-file-types.ts`, `finder/{FinderRow,FinderRootColumn,FinderVirtualColumn,FinderListView}.tsx`
(menu trigger, rename, the grantee-level variants), `finder/finder-toolbar-actions.ts`,
`features/knowledge/SpaceSettingsDialog.tsx` (visibility control),
`features/knowledge/FileVersionUploadDialog.tsx` (onto `Dialog`),
`features/knowledge/CreateSpaceDialog.tsx` (title prop);
`api/src/routes/knowledge-shares.ts` (the `knowledge_shared` alert write —
1B is on `main` by now); `admin/test/finder-menu.test.ts`,
`admin/test/finder-dialogs.test.ts`, `admin/test/share-dialog.test.ts`.
2A exports `useFinderMenus(): { rowProps(row); backgroundProps(column); dialogs: ReactNode }`.

**2B — uploads and indexing.** `finder/{useUploadQueue,indexing-copy}.ts`,
`finder/{UploadQueue,FinderFolderColumn,DocumentsFinder,FinderStatusBar}.tsx`
(drop wiring, placeholders, tray, polling; mounting 2A's `useFinderMenus`
and 2D's `useFinderTransfers` by their declared names), `admin/src/facades/knowledge/file-hooks.ts`
(multi-upload, abort); `admin/test/upload-queue.test.ts`,
`admin/test/indexing-copy.test.ts`.

**2C — folder kind everywhere else.** `packages/knowledge/src/provisioning.ts`
(`ensureTaskFolder`), every `metadata.folder` writer and reader outside the
admin (`worker/src/run/pa-tools/*`, MCP document tools,
`api/src/routes/knowledge-tasks.ts`), `packages/knowledge/test/provisioning.test.ts`,
the worker tests that cover folder creation; `docs/standards/agent-documents.md`
(one sentence).

**2D — the transfer UI.** `finder/TransferPrompt.tsx`, `finder/MoveToDialog.tsx`
(all writable roots, the two-button footer, refusal rendering),
`finder/useFinderDrag.ts` (the cross-root branch, Alt, the `+` ghost badge;
1D is on `main`, so this is the file's second and last owner), the
`useTransferPages`/`useTransferStatus` hooks in
`admin/src/facades/knowledge/finder-hooks.ts` (1D's file, now 2D's),
the tray row for a queued transfer as a component 2B mounts
(`finder/TransferProgressRow.tsx`); `admin/test/transfer-prompt.test.ts`.
2D exports `useFinderTransfers(): { onForeignDrop(rows, target, point, altKey); prompt: ReactNode; progressRows: ReactNode }`.

Dependency edges: 2A, 2B, 2C, 2D → all of Wave 1. 2B imports 2A's and 2D's
hooks by name only; 2A and 2D share no file.

### Wave 3 — verification and docs (one agent, from the integrated Wave 2 tip)

`admin/e2e/documents-finder/run.mjs`, `admin/package.json`
(`test:e2e:documents-finder`), `.github/workflows/*` (Navigation Transitions
step), `docs/knowledge-base-requirements.md` (the browsing section rewritten
to this design), `docs/navigation/overlays.md` (a `ContextMenu` paragraph
under §7), `docs/standards/file-storage.md` (one bullet each for `copy` and
`reassignScope`: a copy re-stores bytes and a move re-homes accounted bytes
with a zero-sum pair; the `move.in`/`move.out` operations), `docs/standards/design-system.md`
(one bullet: the Finder row and pill), `CLAUDE.md` (a coverage bullet for
the new suite), `docs/testing/documents-finder-e2e.md` (the two-user seed
and the transfer fixtures), and this directory's status line → "as built"
with a deviations section. The screenshots for every F-* case are
committed under `admin/e2e/screenshots/documents-finder/`.

Done when: the suite is green locally against a throwaway pgvector DB with
`@nessie/mock-llm`, in CI, and every F-* screenshot has been looked at.

## 4. Documents that change with the code

| Document | Change | Wave |
|---|---|---|
| `docs/knowledge-base-requirements.md` §"Browsing" (L405–450 today) | rewritten: root model, two views, folder kind, sort, menus, sharing levels, transfers | 3 |
| `docs/navigation/overlays.md` §7 | `ContextMenu` added to the family with its Sheet-on-`single` rule | 3 |
| `docs/navigation/page-types-and-motion.md` §1 host table | `view: columns · list`, `sort`; the Share dialog's level radiogroup in the form-field list | 3 |
| `docs/standards/file-storage.md` | `FileService.copy` and `reassignScope`; the two ledger operations | 3 |
| `docs/standards/agent-documents.md` | folders are `kind: 'folder'` | 2C |
| `docs/standards/design-system.md` | the Finder row/pill bullet; the "navigational page" bullet gains the sentence that the Finder is a worked-in surface | 3 |
| `docs/standards/disclosure-boundaries.md` | one bullet: a transfer is judged against the destination audience by the rule in [transfer.md](transfer.md) §4.1, and a copy carries its versions' basis rows | 3 |
| `docs/plans/2026-08-31-agent-documents.md` | a dated note under its folder bullet pointing here | 2C |
| `CLAUDE.md` | the e2e coverage bullet | 3 |
| this directory | status → as built; deviations | 3 |
