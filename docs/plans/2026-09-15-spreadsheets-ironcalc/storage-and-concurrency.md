# Storage, sequencing, versions, import/export, indexing

This file is the **shared contract**. Phase 0 builds and type-checks the
schemas and the Prisma migration exactly as written here before any wave
starts; waves implement against them and change them only through the
orchestrator.

## The shape: one engine, one order

IronCalc is deterministic and emits its own diffs, so the design is simpler
than a hand-written applier over cell rows:

1. **The canonical state of a spreadsheet is an IronCalc workbook**, held as
   engine bytes (`UserModel.toBytes()`), reconstructible on any replica by
   `fromBytes(snapshot)` + `applyExternalDiffs` of every journal batch since.
2. **The journal (`spreadsheet_op_batches`) is the total order.** A batch is
   one `flushSendQueue()` payload from a browser, a worker tool call, or the
   MCP server, given a page-monotonic `seq` by the one write door under a
   per-page advisory lock.
3. **Every replica derives the same model** from the same snapshot and the
   same ordered batches (verified byte-identical). A per-process model cache
   is a cache, never an authority: it is fast-forwarded from the journal
   under the lock before every use.
4. **Versions are snapshots**: a `KnowledgePageVersion` whose attachment is
   an `.xlsx` rendition (durable, engine-independent, downloadable) with the
   engine bytes kept beside it for fast loads, and a plain-text projection in
   `body` for search.

Cell-level rows are gone: the engine already holds cells, evaluates them and
answers range reads at 20 000 cells / 12 ms over napi; a second copy in SQL
would be a second authority to keep consistent for no reader that needs it.

### Why not the alternatives

| Option | Rejected because |
|---|---|
| Cell rows in Postgres as canonical | Two authorities (rows vs engine) for one fact; every write would apply diffs to the engine *and* mirror rows; agent reads already come from the engine. |
| Op log only, no snapshots | Replay grows unbounded; a 30-day-old page would load in seconds, not milliseconds. |
| Snapshot-only (rewrite bytes per edit) | 1.9 MB per edit on a 200 000-cell sheet; no incremental broadcast. |
| Yjs / CRDT | The engine already has a diff protocol; a CRDT would need its own model of cells and formulas beside the engine's and cannot evaluate. |
| Engine bytes as the *only* durable form | `bitcode` bytes are version-coupled and undecodable outside the exact crate version; a person's spreadsheet must outlive an engine bump. Hence xlsx per version. |

## Prisma (Phase 0 adds exactly this; migration `2026091600_spreadsheets`)

```prisma
enum KnowledgePageKind {
  document
  file
  spreadsheet
}

/// Per spreadsheet page: the live head and the hot snapshot.
model SpreadsheetHead {
  pageId               String   @id @map("page_id") @db.Uuid
  organizationId       String   @map("organization_id") @db.Uuid
  headSeq              BigInt   @default(0) @map("head_seq")
  /// Engine version (exact `@ironcalc/nodejs` version) every batch and the
  /// hot snapshot are encoded with. A mismatch at load time refuses the fast
  /// path and rebuilds from the xlsx version (see "Engine upgrades").
  engineVersion        String   @map("engine_version")
  /// `UserModel.toBytes()` at `hotSnapshotSeq`; the fast load path.
  hotSnapshot          Bytes    @map("hot_snapshot")
  hotSnapshotSeq       BigInt   @default(0) @map("hot_snapshot_seq")
  /// Latest durable version (xlsx attachment + text projection).
  snapshotVersionId    String?  @map("snapshot_version_id") @db.Uuid
  snapshotSeq          BigInt   @default(0) @map("snapshot_seq")
  batchesSinceSnapshot Int      @default(0) @map("batches_since_snapshot")
  /// Sheet names by index at head, for tool ergonomics and audit text.
  sheetNames           String[] @map("sheet_names")
  /// Per-sheet filter models (SpreadsheetFilterModelSchema, keyed by sheet
  /// index), maintained by the write door — see "Sort, filter, find and replace".
  filters              Json     @default("{}")
  lastOpAt             DateTime? @map("last_op_at")
  createdAt            DateTime @default(now()) @map("created_at")
  updatedAt            DateTime @updatedAt @map("updated_at")

  page KnowledgePage @relation(fields: [pageId], references: [id], onDelete: Cascade)

  @@index([organizationId, lastOpAt], map: "spreadsheet_heads_org_last_op_idx")
  @@map("spreadsheet_heads")
}

/// The journal. `diffs` is the exact `flushSendQueue()` payload; `summary`
/// is caller-supplied metadata (see SpreadsheetBatchSummarySchema) because
/// the bytes cannot be decoded outside the engine.
model SpreadsheetOpBatch {
  id                String   @id @default(uuid()) @db.Uuid
  pageId            String   @map("page_id") @db.Uuid
  organizationId    String   @map("organization_id") @db.Uuid
  seq               BigInt
  clientOpId        String   @map("client_op_id")
  actorType         KnowledgeAuthorType @map("actor_type")
  actorId           String   @map("actor_id")
  agentId           String?  @map("agent_id") @db.Uuid
  runId             String?  @map("run_id") @db.Uuid
  agentCredentialId String?  @map("agent_credential_id") @db.Uuid
  engineVersion     String   @map("engine_version")
  diffs             Bytes
  /// insertRows | insertColumns | deleteRows | deleteColumns | moveRows |
  /// moveColumns | newSheet | deleteSheet | moveSheet | duplicateSheet |
  /// restore | undo-structural, else null.
  structuralKind    String?  @map("structural_kind")
  /// Sheet indexes touched (at the batch's baseSeq numbering).
  sheetIndexes      Int[]    @map("sheet_indexes")
  cellCount         Int      @map("cell_count")
  summary           Json
  createdAt         DateTime @default(now()) @map("created_at")

  page KnowledgePage @relation(fields: [pageId], references: [id], onDelete: Cascade)

  @@unique([pageId, seq], map: "spreadsheet_op_batches_page_seq_key")
  @@unique([pageId, actorId, clientOpId], map: "spreadsheet_op_batches_page_actor_client_key")
  @@index([pageId, createdAt], map: "spreadsheet_op_batches_page_created_idx")
  @@map("spreadsheet_op_batches")
}
```

**Phase 2 correction — the write door names its transaction bounds.** Prisma's
defaults (2 s to acquire a transaction, 5 s to finish one) are sized for a
transaction that contends with nothing. Every write to one page queues behind
that page's advisory lock, so a burst is *expected* to wait, and the default
turned ordinary contention into a 500 whose only client recovery is to
resubmit — which makes the queue longer. `maxWait` is 30 s and `timeout` is
15 s: waiting for the lock is normal, holding it for fifteen seconds is not.

`KnowledgePage` gains the two back-relations. `KnowledgePageVersion` is
reused unchanged: `attachmentId` → the `.xlsx` rendition
(`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
`<title>.xlsx`), `body` → text projection, `sourceContentHash` → `canonicalHash`
of the workbook (**not** a hash of any bytes: `toBytes()` is not
byte-deterministic, so an unchanged workbook would hash differently on every
save — decisions.md §"Spike A"). The engine bytes of a *durable* version are
stored as a second attachment on the version's page
(`Attachment.knowledgePageId`, filename `<title>@<versionId>.icalc`, hidden
from the drawer by MIME `application/vnd.ironcalc`) so a restore of an old version is a fast load
when the engine version still matches and an xlsx re-import when it does not.

## Shared contract — `packages/schemas/src/spreadsheet.ts`

```ts
export const SPREADSHEET_LIMITS = {
  maxSheets: 50, maxCellsPerRead: 10_000, maxCellsPerWrite: 10_000,
  maxBatchBytes: 4_000_000, maxCellTextChars: 32_000, maxDraftChars: 256,
  maxPresenceFramesPerSecond: 10, opsCatchUpPageSize: 200,
  compactEveryBatches: 200, compactAfterIdleMs: 300_000, opsRetentionDays: 30,
  hotSnapshotEveryBatches: 25, modelCacheMaxBytes: 256 * 1024 * 1024,
  modelCacheIdleMs: 600_000, destructiveRowsThreshold: 100,
  destructiveCellsThreshold: 1_000,
} as const

export const SpreadsheetBatchSummarySchema   // { structuralKind: ... | null, sheetIndexes: number[],
                                             //   cellCount: number, touched: { sheet, r0, c0, r1, c1 }[] (≤ 64),
                                             //   intents: SpreadsheetIntent[] (≤ 200, browser only; see below) }
export const SpreadsheetIntentSchema         // discriminated union mirroring the UserModel mutators the UI calls:
                                             //   setUserInput{sheet,row,column,value} | updateRangeStyle{...} |
                                             //   rangeClearContents/All/Formatting{...} | insertRows{...} | ...
                                             //   undo | redo | paste{sheet,row,column,kind} ...
export const SpreadsheetOpBatchInputSchema   // { clientOpId: uuid, baseSeq: string, diffs: base64, summary }
export const SpreadsheetAppliedBatchSchema   // { batchId, seq, baseSeq, clientOpId, actor: SpreadsheetActor,
                                             //   engineVersion, diffs: base64 | null (null when > cap: fetch by seq),
                                             //   structuralKind, sheetIndexes, cellCount, createdAt }
export const SpreadsheetActorSchema          // { type: 'user'|'agent', id, displayName, color, agentId?, runId? }
export const SpreadsheetSelectionSchema      // { r0, c0, r1, c1 } 1-based inclusive (IronCalc addressing)
export const SpreadsheetPresenceFrameSchema  // { clientId, sheet: number, selection, cursor: {r,c}|null,
                                             //   draft: {r,c,text}|null, ts }
export const SpreadsheetPresenceEventSchema  // frame + actor + pageId + sheetName
export const SpreadsheetBootstrapSchema      // { pageId, revision, engineVersion, headSeq,
                                             //   snapshot: { seq, bytes: base64 }, batches: AppliedBatch[] (since snapshot),
                                             //   sheetNames, viewer: { canWrite } }
export const A1Schema, parseA1Range(), formatA1Range(), columnLabelToIndex(), columnIndexToLabel()
export const presenceColorFor(actorId), PRESENCE_PALETTE
export const SPREADSHEET_ENGINE_VERSION = '0.8.3'   // the one pinned pair; Phase 0 sets it
```

IronCalc addresses cells 1-based (`row 1`, `column 1 = A`) and sheets by
index; the contract keeps that and the A1 helpers translate for tools.

## The write door — `applySpreadsheetBatch` (`packages/knowledge/src/spreadsheet/apply.ts`)

One function for browsers (route), worker builtins and the MCP server. One
transaction on one pooled client, plus the process-local model cache:

```text
BEGIN
  pg_advisory_xact_lock(hashtextextended('spreadsheet:' || pageId, 0))
  head := SELECT … FROM spreadsheet_heads WHERE page_id FOR UPDATE
  IF head.engineVersion != SPREADSHEET_ENGINE_VERSION → 409 SPREADSHEET_ENGINE_MISMATCH (see "Engine upgrades")
  IF batch (pageId, actorId, clientOpId) exists → return it (replayed: true), no publish
  -- structural conflict (client batches only; server batches are built at head)
  IF baseSeq < head.headSeq AND EXISTS batch WHERE seq > baseSeq AND structuralKind IS NOT NULL
       AND sheetIndexes && input.summary.sheetIndexes
     → 409 SPREADSHEET_STRUCTURAL_CONFLICT { headSeq, since: batches(seq > baseSeq) }
  model := cache.get(pageId) fast-forwarded to head.headSeq
           (miss: fromBytes(head.hotSnapshot) then apply journal batches > hotSnapshotSeq, paused, evaluate once)
  model.pauseEvaluation(); model.applyExternalDiffs(diffs); model.resumeEvaluation(); model.evaluate()
     → any engine error: ROLLBACK, cache.evict(pageId), 400 SPREADSHEET_BATCH_REJECTED { reason }
  seq := head.headSeq + 1
  INSERT spreadsheet_op_batches (…, engineVersion, diffs, summary…)
  IF seq - head.hotSnapshotSeq >= hotSnapshotEveryBatches → head.hotSnapshot = model.toBytes(), hotSnapshotSeq = seq
  UPDATE spreadsheet_heads SET head_seq = seq, sheet_names, batches_since_snapshot + 1, last_op_at
  UPDATE knowledge_pages SET revision = revision + 1, updated_at
  writeAuditEntryInTransaction('kb.spreadsheet.batch_applied', pageId, metadata{seq, clientOpId, structuralKind,
     sheetIndexes, cellCount, touched, agentId?, runId?, agentCredentialId?})
COMMIT
cache.commit(pageId, seq)                      -- the cached model now stands at seq
publishDocumentEphemeral(pageId, 'sheet.ops', AppliedBatch)   -- after commit, no lock
IF batches_since_snapshot >= compactEveryBatches → enqueue spreadsheet.compact (key page:seq)
```

Rules that follow:

- **Cell-level last-writer-wins by server order** when two people edit
  concurrently and nothing structural intervened — no cell locks (owner decision 1).
- **Structural refusal** is the only conflict a client must handle. The
  client cannot transform bytes, so it **replays intent**
  (`realtime-and-presence.md` §"Ordering rules"): undo its pending actions
  locally, apply the foreign batches, re-issue its recorded intents with
  row/column indexes shifted by the foreign structural batches' summaries,
  flush, resubmit. Server batches never conflict: they are built at head
  under the lock.
- **Summary is caller-supplied and ADVISORY ONLY** (owner decision 2). The
  server cannot decode the bytes, so the browser derives the summary from
  the method calls it intercepted; the worker and MCP derive it from the
  tool call. The summary feeds exactly three things: the structural-conflict
  check, the filter-model remap, and audit/presence text. **It is never an
  input to authorization, tenancy or permission decisions** — those are
  decided before the summary is read, from the actor context and the
  page's space, and `applySpreadsheetBatch` takes the summary as a separate
  argument the access layer never sees. The worst a wrong or hostile
  summary can do is misorder that organisation's own document until a
  rebase or restore, under the sender's audited identity; the durable xlsx
  versions bound the damage. `api/test/spreadsheet-summary-advisory.test.ts`
  proves it: a batch with a lying summary from a reader is still refused
  (403 from access, summary unread), from a writer it lands with no more
  reach than an honest one, and a false `structuralKind: null` costs the next
  crossing client exactly one rebase. Revisit when upstream
  `summarize_diffs` lands.
- **Idempotency** on `(pageId, actorId, clientOpId)`; browsers mint a uuid
  per batch, tools use `toolCallId`.
- **Evaluation is paused around every apply** and run once (the 24 s vs
  15 ms measurement in `library-assessment.md`).
- **The cache** (`packages/knowledge/src/spreadsheet/model-cache.ts`) is
  created once per process by the service factory (closure state, not
  module scope), LRU by bytes (`modelCacheMaxBytes`), idle-evicted
  (`modelCacheIdleMs`), keyed by `pageId` with `{ model, seq,
  engineVersion }`. It is consulted only under the page lock and always
  fast-forwarded from the journal first, so two replicas cannot disagree;
  a replica that never saw the page pays one `fromBytes` (14 ms per 200 000
  cells) plus the batches since the hot snapshot (≤ 25 by construction).

## Reads

- **Bootstrap** `GET /pages/:pageId/spreadsheet` → `{ snapshot: hot bytes at
  hotSnapshotSeq, batches since }`; the browser does `Model.fromBytes` then
  applies the batches paused, then `evaluate()`. One round trip, no
  server-side model needed.
- **Catch-up** `GET …/spreadsheet/ops?afterSeq=&limit=` → applied batches
  (`diffs` inline ≤ `NOTIFY` cap else always inline here — this is HTTP),
  `410 SPREADSHEET_CATCHUP_EXPIRED` past retention → re-bootstrap.
- **Range / describe / find** (tools and REST) read from the cached model
  (fast-forwarded under a shared read of the head — no lock needed for a
  read: the reader loads `head_seq`, fast-forwards the cache to at least
  that seq, and reads; a concurrent writer only makes it read a slightly
  older consistent state).
- **Export** `GET …/spreadsheet/export?format=xlsx|csv&sheet=&versionId=`:
  xlsx from `model.saveToXlsx` (live) or the version's attachment; csv
  rendered from formatted values. Past `signedDownloadMinBytes` the file is
  materialised through `FileService` and served by the existing 302 path.

## Snapshots, versions, compaction, restore

- `createSpreadsheetSnapshot(pageId, {reason, authorType, authorId,
  changeComment})`: under the page lock, `bytes = model.toBytes()`,
  `xlsx = model.saveToXlsx()`, text projection from the model, then
  `FileService.store` (xlsx, scope `{projectId, teamId, spaceId}`,
  `storeFileWithRollback`) → `provider.addFileVersion({attachmentId,
  authorType, authorId, changeComment, expectedLatestVersionId})` which writes
  `body`, `sourceContentHash`, disclosure rows and runs `indexVersionChunks`
  (chunks + embed job — **no new indexing code**); the `.icalc` bytes go to
  a page attachment; `spreadsheet_heads.snapshotVersionId/snapshotSeq`
  update and `batchesSinceSnapshot = 0`.
- **Text projection** (`packages/spreadsheet/src/projection.ts`, pure over
  a read interface): per sheet `## <name>` then rows of formatted values
  tab-separated within `getSheetDimensions`, trailing blanks trimmed, capped
  at 200 000 chars with a marker.
- Triggers: `compactEveryBatches`; the idle sweep (`withSweepLock`, every
  minute, ≤ 50 heads with `last_op_at < now() - compactAfterIdleMs AND
  batches_since_snapshot > 0`, per-row error isolation); explicit "Save
  version"; before a destructive agent op; after import; after restore.
  `changeComment` says why (`compaction`, `named: …`, `before: delete sheet
  "Q3"`, `import: file.xlsx`, `restore: v12`).
**Phase 2 correction — the engine blob is keyed by version id, not by seq.**
This file said `<title>@<seq>.icalc`. A `KnowledgePageVersion` row carries no
seq, so a restore could only guess one from the head — and by then the head's
`snapshotSeq` has already moved, because a restore snapshots the *current*
state first. The guess found the blob for the state being replaced and restored
it over itself: the restore silently did nothing. The version id is the only
name both the writer and the reader hold. Caught by
`packages/knowledge/test/spreadsheet-versions.test.ts`.

- **Restore** (existing `POST …/versions/:versionId/restore`, kind-aware):
  load the version's `.icalc` attachment if `engineVersion` matches, else
  `UserModel.fromXlsx` of the xlsx attachment; replace `hotSnapshot`, append
  a `restore` batch (`diffs` empty, `structuralKind: 'restore'`), evict the
  cache, snapshot. Clients re-bootstrap on `structuralKind === 'restore'`.
- **Retention**: prune batches `seq <= snapshotSeq AND created_at < now() -
  opsRetentionDays`.
- Version history UI is the existing `VersionHistory.tsx`; "Download"
  serves the xlsx.

### Version history is the safety net (owner decision 3)

There is no approval gate on agent writes; versions are what make any edit
reversible, so they have to be good enough to rely on:

- **What a version captures:** the whole workbook — every sheet, cell
  value and formula, style, merge, frozen pane, hidden row/column, defined
  name, named style, conditional format, link, theme and the sheet order —
  as the xlsx rendition plus the engine bytes, the text projection for
  search, and who made it (`authorType/authorId`, the agent or credential
  when applicable) with a comment that names why.
- **When a version is taken automatically:** every `compactEveryBatches`
  (200) batches; after `compactAfterIdleMs` (5 min) of quiet with unsaved
  batches; **before every destructive operation by anyone** — delete sheet,
  delete rows/columns over the threshold, clear over the threshold, a sort
  or filter over more than the threshold, replace-all, restore, import;
  and at the start of every agent run's first write to a page (`before:
  <agent> started editing`) so a run's whole contribution is one diff away
  from undone. Named versions come from **Save version** and
  `sheet_versions save`.
- **How a person finds one:** the pane's **History** action (the existing
  `VersionHistory.tsx`) lists versions newest first with author, time,
  comment and an `agent` badge; every agent tool card in chat for a
  destructive op links "Restore the version from before this"; the pane
  shows a transient "Saved a version before <action> — Restore" notice
  after any automatic pre-destructive snapshot.
- **How a person restores:** one click on a version (`Restore this
  version`), confirmed with the shared `ConfirmDialog`, which itself
  snapshots the current state first (`before: restore to v12`) so a restore
  is reversible; `Download` gives the xlsx. Agents restore with
  `sheet_versions restore` and see the same list with
  `sheet_versions list`.
- **What it costs:** a version is an xlsx + bytes write through
  `FileService` (≈ 2 MB per 200 000 cells, accounted against the
  organisation's storage like any file) — the destructive triggers above
  are the only ones that fire per action, and the compaction cadence bounds
  the rest.

## Engine upgrades (a data event, kept simple)

`SPREADSHEET_ENGINE_VERSION` pins one exact `@ironcalc/nodejs` and
`@ironcalc/wasm` version, verified in Phase 0 by a wasm↔nodejs diff and
bytes round-trip test that runs in CI (`packages/spreadsheet/test/engine-pair.test.ts`).
Production is greenfield and holds no spreadsheets yet (owner decision 4),
so there is **no** dual-engine alias, no format shim and no compatibility
layer. Bumping the version is one job, `spreadsheet.engine-migrate`,
run once per deploy that changes the pin:

1. Per page, under its lock: if a durable version exists at `headSeq`, use
   its xlsx; otherwise snapshot first (which needs the *old* engine — so the
   job runs **before** the image swap, from the previous release, as the
   last step of its own deploy: "snapshot every page whose
   `batches_since_snapshot > 0`"). The new release then does, per page:
   `UserModel.fromXlsx(version xlsx)` → new `hotSnapshot`, `engineVersion`,
   `headSeq + 1` with a `restore` batch, prune older batches, evict caches.
2. Until a page is migrated the write door answers `409
   SPREADSHEET_ENGINE_MISMATCH` and the pane shows "being upgraded, read
   only"; a blue-green swap is therefore safe.
3. Anything the xlsx cannot carry is lost at that point; the xlsx is the
   format of record by design, and the filter model (ours) survives on the
   head untouched.

## Import and convert

- `POST /spaces/:spaceId/spreadsheets` `{title, parentPageId?, taskId?}` →
  new page (`kind: 'spreadsheet'`), head with an empty `UserModel` (one
  sheet), first snapshot deferred to first compaction.
- `POST /spaces/:spaceId/spreadsheets/import` (multipart `.xlsx` or `.csv`).
  **The API never parses the workbook.** `fromXlsx` plus `evaluate()` on a
  foreign file writes one diagnostic line per affected cell to fd 1 from a Rust
  thread, and when that write fails the engine panics inside the napi call and
  the process aborts — uncatchably. On an API replica that is every open stream
  in the building. So the route does everything that is safe without the engine
  — sniff the container (`detectWorkbookFormat`, so a 1997 `.xls` is refused by
  name rather than as "a corrupt file"), apply the caps, derive the loss list
  (`scanXlsxWarnings`: the part list **and** a marker scan of the worksheet
  parts, because autofilter, validation, hyperlinks, protection and outlines
  have no part of their own), create the page and store the upload — then
  enqueues `spreadsheet.import` and answers **202**. The page is reachable
  immediately (Rule zero) and shows as importing; the worker parses, replaces
  the hot snapshot, appends a `restore` batch so any open pane re-bootstraps,
  and takes the import version. `packages/knowledge/src/spreadsheet/engine.ts`
  makes parsing a capability the API is never granted, so a later route cannot
  reintroduce the hazard by calling the wrong function.
- **The caps are on the uncompressed size, not the file.** Sheet XML
  decompresses about 11:1 and a 3.27 MB workbook already needs ~864 MB
  resident, so this file's original 64 MiB parse cap would have admitted a
  workbook needing roughly 15 GB. `SPREADSHEET_IMPORT_LIMITS` (16 MiB
  compressed / 256 MiB declared uncompressed / 32 MiB for a CSV) lives in
  `packages/knowledge/src/spreadsheet/import.ts` pending a move into
  `SPREADSHEET_LIMITS`, which Phase 0 owns.
- **CSV import cannot delegate to `pasteCsvString`** — that call is TSV despite
  its name. `@nessie/spreadsheet`'s `importCsv` parses the CSV itself.
- **A downloaded CSV carries CRLF and a UTF-8 BOM.** Without them Excel reads
  the file in the local code page and mangles every non-ASCII name in it.
- `POST /pages/:pageId/convert-to-spreadsheet` for a `.xlsx`/`.csv` file
  node: new spreadsheet page beside it, original kept; `.xls` refused.

## Sort, filter, find and replace (our layer, full fidelity)

IronCalc has none of the three; the owner wants the real thing, not
approximations. All three live in `packages/spreadsheet` as pure functions
over the engine interface and the `getTokens` lexer, are driven by the same
service functions from the pane and the tools, and land as ordinary journal
batches (undo/redo and presence for free).

**Sort** (`sort.ts` + `formula-shift.ts`):

- Reads the range as `(content, style)` per cell, orders rows by the key
  columns (numbers before text, blanks last, locale-aware text, optional
  header row kept in place), and writes rows back with `setUserInput` and
  `updateRangeStyle` inside one paused batch. 200 000 cells write in ≈ 220
  ms, so 10 000 rows are sub-second.
- **Formulas keep their meaning the way Excel and Google Sheets keep it
  (copy semantics):** a formula moved from row *r* to row *t* has every
  **relative** row reference shifted by *t − r* and every absolute one kept
  — `=B5*2` in C5 sorted to C2 becomes `=B2*2`; `=$F$1` stays; cross-sheet
  references shift the same way; references to whole columns (`A:A`) are
  untouched. The rewrite is done from `getTokens` output: only `Reference`
  and `Range` tokens are touched, spliced back by their `start`/`end`
  offsets, so strings, names and function calls cannot be corrupted. A
  formula that would shift off the grid becomes `#REF!` in that reference,
  exactly as a paste would. Column sort is the transposed rule.
- Merged cells inside the range refuse the sort with the merge named (the
  Sheets rule); a range that intersects a filter's range re-applies that
  filter afterwards.
- Verified against the engine's own paste semantics in tests: for every
  fixture, our rewrite of a formula moved by *(Δr, Δc)* equals what
  `copyToClipboard` + `pasteFromClipboard(…, false)` produces in the wasm
  build. When upstream exposes `extend_to` (PR opened in Phase 0), the
  rewrite delegates to it and the fixture set becomes the regression guard.

**Filter** (`filter.ts`, model in `spreadsheet_heads.filters`):

```ts
SpreadsheetFilterModel = {
  range: { r0, c0, r1, c1 }                     // header row is r0
  columns: Record<number /* absolute column */, {
    kind: 'values';   values: string[]; blanks: boolean      // formatted-value whitelist
  } | {
    kind: 'condition'; op: 'eq'|'ne'|'gt'|'gte'|'lt'|'lte'|'contains'|'notContains'|'startsWith'|'endsWith'|'empty'|'notEmpty'|'between'
                     ; value: string | number; value2?: string | number; caseSensitive?: boolean
  }>
  sort?: { column: number; direction: 'asc' | 'desc' }      // the last sort applied through the filter
  appliedAtSeq: string
}
```

- One model per sheet, persisted on the head, delivered to every client in
  the bootstrap and, on change, as `summary.filter` on the `sheet.ops`
  batch that applied it; agents read it through `sheet_describe` and
  `sheet_filter get`.
- Applying: the service evaluates the criteria against the live formatted
  values, computes the hidden set within `range`, and emits engine
  `setRowsHidden` diffs for the delta — rows the model no longer hides are
  unhidden, rows a person hid manually outside the range are untouched
  (the model records which rows *it* hid so it never unhides somebody's
  manual hide). Clearing the filter unhides exactly those rows.
- **Re-application** is explicit (`Re-apply` in the pane, `sheet_filter
  reapply`) and automatic after a sort through the filter, after an import
  and after a restore — the Excel/Sheets rule, where editing a value does
  not re-filter until asked, so a person is not surprised by a row
  vanishing under their cursor.
- Structural batches remap the model: the write door shifts `range` and
  the column keys by the batch summary's `insertRows/Columns`,
  `deleteRows/Columns`, `moveRows/Columns` and drops the model when its
  range is deleted; sheet insert/delete/move re-key the map. **A
  server-built batch carries no `intents`** — those are the browser's record
  of its own calls, for replay after a structural refusal — so the write
  door's per-batch remap is a no-op for the pane's own insert or delete, and
  `restructureSpreadsheet` rebuilds the edit from the action it issued and
  remaps there. Missing that cost the filter model its rows;
  `packages/knowledge/test/spreadsheet-filters.test.ts` pins it. A stale model
  (range outside the sheet) is dropped with an audit note, never applied.
- xlsx export writes the hidden rows (the engine carries them) but not the
  filter object, because the engine has no autofilter; the pane says so on
  export. The engine already imports xlsx `<autoFilter>` into its `Table`
  type without filtering (`xlsx/src/import/tables.rs:107`), so an import
  seeds our model from that table's `has_filters` range with no criteria.
  **Upstream contribution proposed after v1:** an engine `AutoFilter`
  object with xlsx round-trip; our model is shaped to migrate onto it.

**Find and replace** (`find.ts`):

- Find walks each sheet's `getSheetDimensions` and reads
  `getFormattedCellValue` (default) or `getCellContent` (`inFormulas`),
  with `matchCase`, `wholeCell`, `regex` (RE2-style, via the existing safe
  regex helper if the repo has one, else a linear-time subset), scope
  `sheet | workbook | range`, and returns up to 200 matches with the sheet
  name and A1 address. 20 000 cells read in 12 ms, so a 200 000-cell
  workbook answers in about 150 ms; the pane debounces at 200 ms.
- Replace is a batch: for each match, `setUserInput` with the replaced
  text (`inFormulas` replaces inside formula text and is refused when the
  result fails to tokenise — reported per cell, nothing partially applied);
  `replaceAll` and single-match `replace` share the code. Replacing in a
  cell a filter hides is allowed and reported.
- The pane's find box searches the client model directly (no round trip);
  replace goes through the batch so it lands in the journal.
- Upstream candidate: a Rust `search(pattern, scope)` on `UserModel` for
  million-cell sheets; not needed for v1 caps.

**Cost:** roughly 1 200 lines in `packages/spreadsheet` (sort + shift 350,
filter 400, find/replace 250, tests apart), the `filters` head column and
the remap in the write door (Phase 2, ≈ 150 lines), three pane surfaces
(filter buttons on column headers with a value/condition popover, a
filter-chips bar, a find/replace popover — Phase 3a, ≈ 600 lines), and two
tools (`sheet_filter`, `sheet_replace`). Nothing needs a fork; three
upstream PRs make it cheaper later (`extend_to` exposure, the Node paste
key fix, engine autofilter).

## Permissions and tenancy

Unchanged from the kind's siblings: create = `canWriteSpace` + `page:create`;
bootstrap / catch-up / read / export / live lane = `accessPageSpace(read)` +
every version readable; batch / draft presence / save version / restore /
import / convert = `accessPageSpace(write)` + `page:edit`; agent principal
rules from `pa-tools/knowledge.ts`. Every table carries `organizationId`.
`purgeKnowledgePageFiles` already walks version attachments and page
attachments, so xlsx renditions and `.icalc` blobs are removed with the page
(Phase 2 asserts it). Disclosure: agent reads record the space and the latest
snapshot version; a successor version unions its predecessor's basis.

## Indexing

Nothing new: each durable version's `body` is the text projection, chunked
and embedded by `indexVersionChunks`. Staleness between snapshots is bounded
by `compactEveryBatches` / `compactAfterIdleMs` and stated in the standards
file; the pane's find and `sheet_find` read the live model.
