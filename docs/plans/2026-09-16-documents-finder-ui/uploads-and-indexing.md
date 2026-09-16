# Documents as a Finder — uploads and indexing

Part of [the Finder plan](overview.md). What happens between "I dropped
five files on this column" and "they are searchable", and what the screen
says at every step. The pipeline it reports on is the existing one:
`POST /spaces/:spaceId/files` → `enqueueKnowledgeExtract` →
`worker/src/control/knowledge-extract.ts` → `knowledge.embed` →
`knowledge-embed.ts` ([data-and-api.md](data-and-api.md) §6 derives the
state from what those write).

## 1. The drop

`useFileDrop` already forwards every dropped `File`; the Finder stops
wrapping it in `firstFileOnly`. It gains one capability and one guard:

- **Folders.** `onDrop` reads `event.dataTransfer.items[i].webkitGetAsEntry()`
  when available; a `DirectoryEntry` is walked with `createReader().readEntries`
  (repeatedly until empty, as the API requires) into
  `{ relativePath: string[]; file: File }` entries. Browsers without the API
  see folders as zero-byte files and drop them silently with one toast:
  "Folders can't be dropped in this browser — drop the files inside them."
- **Caps.** 500 entries per drop and 5 GiB total (`NESSIE_MAX_UPLOAD_BYTES`
  is per file; the total is a client courtesy so a mistaken drop of a home
  directory is refused before the first byte): over either cap nothing
  starts and the overlay says "That's more than 500 files — drop a folder
  or a smaller set." / "That's more than 5 GB at once — drop fewer files."
- **Guard.** The overlay activates only when `dataTransfer.types` includes
  `'Files'`; an in-app row drag ([browser-ui.md](browser-ui.md) §8) never
  shows it.

The drop target is the column under the pointer: dropping on the *My
Documents › Contracts* column uploads into Contracts; dropping on a folder
row inside a column uploads into that folder (the row highlights as a drop
target the same way it does for a row move); dropping on the root column or
a virtual column is refused (`dropEffect = 'none'`, the overlay does not
show, and the status bar says "Drop files into a folder to upload them" for
3 s). `DropZoneOverlay`'s label becomes "Drop to upload into {folder}" with
the count once known: "Drop 5 files into Contracts".

Read-only columns (`!canWrite`) refuse the same way with "You can't add
files here".

## 2. The queue

`useUploadQueue.ts` (Finder-scoped state; one queue per `DocumentsFinder`
instance, so the project tab and a Knowledge tab in another window do not
share one):

```ts
type UploadEntry = {
  id: string                 // client id
  file: File
  targetSpaceId: string
  // The folder to file under. For a folder drop, the id of the folder the
  // queue created for this entry's relativePath (created before its files).
  targetParentPageId: string | null
  relativePath: string[]
  state:
    | { kind: 'queued' }
    | { kind: 'uploading'; pct: number }
    | { kind: 'done'; pageId: string }
    | { kind: 'failed'; code: 'STORAGE_QUOTA_EXCEEDED' | 'FILE_TOO_LARGE' | 'NETWORK' | 'REFUSED'; message: string }
    | { kind: 'skipped'; reason: 'quota' | 'cancelled' }
}
```

- **Order and concurrency.** Folders first (each `relativePath` prefix
  becomes one `POST /pages { kind: 'folder' }` in path order, memoised per
  path), then files, two uploads in flight at a time
  (`uploadFileWithProgress`, the XHR path that reports progress), in drop
  order. *Rejected:* all at once — 40 XHRs contend for the same connection
  pool and every progress bar crawls; one at a time — a 2 GB video blocks
  forty small PDFs.
- **Per-file progress** from `xhr.upload.onprogress`, rounded to whole
  percent; `total` unknown (`!lengthComputable`) shows an indeterminate bar.
- **Partial failure.** A failed entry stays in the queue with its reason and
  a "Retry" per entry; the others continue. A `STORAGE_QUOTA_EXCEEDED`
  (507) failure marks every still-`queued` entry `skipped/quota` at once
  (they would fail the same way) and turns the status-bar meter
  `--danger`; "Retry" on any of them re-queues all skipped ones. A
  `FILE_TOO_LARGE` (413) fails only its own entry.
- **Cancel.** "Cancel" on a queued entry marks it `skipped/cancelled`; on an
  uploading entry aborts the XHR (`xhr.abort()`, a new `onAbort` in
  `upload-xhr.ts`) and marks it failed with "Cancelled". A cancelled upload
  whose bytes had already been stored is a page the server created; the
  queue calls `DELETE /pages/:id` on it so nothing half-arrived lingers.
- **Navigation.** The queue lives in `DocumentsFinder`; leaving `/knowledge-base`
  unmounts it and aborts in-flight uploads after a `beforeunload`-style
  `ConfirmDialog`: "Uploads are still running. Leave and cancel them?" /
  "Stay" · "Leave". The `knowledge:editor` stage's `swipeable={false}`
  precedent is the same idea for the same reason.
- **Done.** Each completed entry invalidates `knowledgeKeys.pages(spaceId)`
  once its `POST` returns (the row it created replaces the placeholder,
  §3); when the last entry settles the queue collapses to a summary for 5 s
  ("5 files uploaded", or "4 of 5 uploaded — 1 failed") and then, if nothing
  failed, disappears. Failures keep the tray open until dismissed.

### Where it shows: the status bar tray

`UploadQueue.tsx` docks into `FinderStatusBar` (never an overlay card: a
card is `role="status"` with no controls, and the queue has Retry and
Cancel). Collapsed: one line, left of the storage meter —
"Uploading {k} of {n} · {name} {pct}%" with a 96 px progress bar, a chevron
to expand, and "Cancel all". Expanded: the strip grows to at most 5 rows
(`max-h-[180px] overflow-y-auto`) of `[icon] [name] [bar or reason] [Retry|Cancel]`,
`text-xs`. `aria-live="polite"` on the summary line only; the per-file
percentages are not announced.

On `single` there is no status bar; the tray is a bottom `Sheet size="sm"`
opened from a header action "Uploads ({k})" that appears while the queue is
non-empty, and the same summary toast (`OverlayCard`) fires on completion.

## 3. The row while it happens

Every entry gets a **placeholder row** in its target column the moment it
is queued (`FinderRow variant="upload"`), in sort position by name, so the
column shows the files arriving where they will live:

| Entry state | Icon | Name | Trailing | Row paint |
|---|---|---|---|---|
| queued | family icon at `opacity-50` | the filename | "Waiting" `text-xs --tx3` | default |
| uploading | family icon | filename; under it a 2 px `--accent` progress bar spanning the name cell | "{pct}%" | default, not selectable |
| done → page row | the real row replaces it on the next `pages` fetch (keyed by `pageId` so React swaps without a flash) | | its `indexing` glyph takes over (§4) | |
| failed | family icon at `opacity-50` | filename | reason `text-xs --danger-text`: "Not uploaded — storage is full" · "Too large — the limit is {formatBytes(limit)}" · "Not uploaded — {server message}" · "Cancelled"; a "Retry" text button | default |
| skipped | family icon at `opacity-50` | filename | "Skipped — storage is full" | default |

Placeholder rows are `aria-disabled` (not openable), carry
`role="option"` so keyboard walking passes over them, and are removed when
the queue collapses (failed ones stay until the tray is dismissed). Folder
placeholders exist too: a folder created for a dropped directory shows as an
ordinary folder row the moment its `POST` returns.

## 4. Indexing — what "searchable" means and what the row says

The server derives `indexing` per row ([data-and-api.md](data-and-api.md)
§6). The screen renders it in three places with one vocabulary
(`indexing-copy.ts`, exhaustive `Record` over the union so a new state fails
to compile rather than rendering nothing):

| `indexing` | Row glyph (14 px, trailing) | Tooltip / Get Info "Search" line | Notes |
|---|---|---|---|
| `not_applicable` | none | — | folders |
| `indexed` | none | "Searchable" | quiet on purpose: most rows |
| `pending/extract` | `faSpinner spin` `--tx3` | "Indexing…" | text is being pulled out of the file |
| `pending/embed` | `faSpinner spin` `--tx3` | "Preparing search…" | chunks exist, embeddings coming |
| `not_indexed/draft` | none | "Not indexed — draft documents are indexed when published" | documents are chunked on publish (`publishPage`), so a draft is honestly unsearchable; the status pill already says "draft" |
| `not_indexed/unsupported` | `faMagnifyingGlassMinus` `--tx3` | "Not indexed — {familyLabel}s aren't searchable" (e.g. "Images aren't searchable") | never "Indexing…" forever |
| `not_indexed/too_large` | `faMagnifyingGlassMinus` `--tx3` | "Not indexed — larger than 20 MB" | the worker's `MAX_ATTACHMENT_BYTES`, exported as one constant |
| `not_indexed/empty` | `faMagnifyingGlassMinus` `--tx3` | "Not indexed — no text found" | a scanned PDF, an empty document |
| `failed/extract`, `failed/embed` | `faTriangleExclamation` `--warning` | "Indexing failed" + Retry (menu "Retry indexing", Get Info button) | `POST /reindex` |

The glyph's `title` carries the sentence; `aria-label` on the glyph reads
the same. A row is never blocked by its indexing state — a pending file
opens, downloads and shares like any other.

### Freshness without a new realtime kind

The `pages(spaceId)` query sets `refetchInterval: 5_000` **while any row in
the loaded list is `pending`**, and stops the moment none is, with a ceiling
of 10 minutes per pending row after which the interval stops and the row
keeps saying "Indexing…" (a stuck job is a worker problem the row should not
paper over; Get Info's line still says "Indexing…" and the `queue_jobs` row
for `kb-extract:{pageId}:{versionId}` — its `status`, `attempt` and
`error_message` — is where an operator looks). Latest and Shared with me
refetch on window focus only.

*Rejected:* a `knowledge.page.indexed` WS event. The event bus's payload
must stay inert for the replica still running the previous build during a
blue-green swap (`scopes: []`, a kind the old zod does not know), the
subscription would need channel-independent user scoping the WS layer does
not have, and the value — a spinner stopping a few seconds sooner — does not
pay for that. Polling is bounded to the exact time something is pending.

### What is honest about it

"Indexed, and embeddings are done" in the owner's words maps to `indexed`:
the current version's chunks all carry an embedding. The two pending stages
are the two jobs. Everything under `not_indexed` is a file or document that
the pipeline will never index as it is, and the sentence says why and, where
there is one, what would change it (publish the draft; upload text instead
of an image). A `failed` state is reachable only after the queue job
exhausted `max_attempts`; "Retry indexing" enqueues a fresh job under a new
idempotency suffix so the exhausted one does not swallow it.

## 5. Markdown on the way in

- A dropped `.md`/`.markdown` file takes the Markdown import path
  (`isMarkdownAttachment` in `knowledge-base-files.ts`): it becomes a file
  document whose body is the rendered projection, opened by the existing
  Markdown editor, and indexed on publish like a document. Its row shows the
  document icon ([browser-ui.md](browser-ui.md) §5).
- A dropped `.xlsx`/`.csv`/`.tsv` is a **file**, with the Excel family icon,
  extracted as text where `isExtractableUpload` allows (`csv`/`tsv` yes,
  `xlsx` no → "Not indexed — Excel documents aren't searchable"). Nothing
  here converts or imports it; that is the spreadsheet work the owner has
  set aside.

## 6. Storage meter and quota, before the refusal

`StorageUsageMeter` in the status bar shows "{used} of {limit} used" with
the 64 px bar; at ≥ 90 % the text and bar take `--danger` and the tooltip
says "Storage is nearly full — uploads will be refused at {limit}". When a
drop's total would exceed the remaining quota the overlay still accepts it
(the server is the authority) but the tray's summary line warns first:
"This may exceed your storage — {remaining} left". The refusal itself is
§2's `STORAGE_QUOTA_EXCEEDED` handling.
