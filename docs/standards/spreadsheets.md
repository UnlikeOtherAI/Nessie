# Spreadsheets

A spreadsheet is a knowledge page (`KnowledgePage.kind = 'spreadsheet'`) whose
state is an IronCalc workbook. People edit it in the admin with the real
IronCalc grid; agents edit the same workbook through the `sheet_*` tools and
the `nessie_sheet_*` MCP mirror; everybody sees everybody live.

Every rule here was paid for by a measurement. The measurements are in
[`docs/plans/2026-09-15-spreadsheets-ironcalc/decisions.md`](../plans/2026-09-15-spreadsheets-ironcalc/decisions.md)
and its sibling spike records; this file states what follows from them. When a
rule changes, change it here in the same turn.

## One write door, one lock, one order

`applySpreadsheetBatch` (`packages/knowledge/src/spreadsheet/apply.ts`) is the
only way a spreadsheet changes — browser, worker builtin, MCP tool, import,
restore, engine migration, compaction. Both the API and the worker load
`@ironcalc/nodejs` and call the same function.

Inside it, per batch:

1. `pg_advisory_xact_lock(hashtextextended('spreadsheet:<pageId>'))` — a
   transaction-scoped lock, so COMMIT or ROLLBACK releases it and no path can
   leak it.
2. The process model cache is consulted **and fast-forwarded from the journal**
   to the head read in this transaction (`modelAtHead`). A cache hit is never
   trusted on its own; a hit at a higher seq than the head is treated as
   corruption and rebuilt.
3. `pauseEvaluation()` → apply → `resumeEvaluation()` → `evaluate()`.
4. `seq = headSeq + 1`, the journal row, the head update, the audit row.
5. Publish **after** commit.

The model cache is closure state of `createSpreadsheetService`, never module
scope. It is a cache and never an authority: `packages/knowledge/test/spreadsheet-cache.test.ts`
and `api/test/spreadsheet-multi-instance.test.ts` both exist to keep it that
way, the second across two real replicas.

### Concurrency

- **`seq` is the order.** IronCalc diffs are absolute and sheet-index
  addressed; applying the same diffs in a different order diverges. The
  journal's order is the truth, and it is assigned under the lock.
- **Cells are last-writer-wins, and there are no cell locks** — Google Sheets
  behaviour, now or ever. Live presence is what makes a collision visible.
- **A structural batch that crossed another on the same sheet is refused**
  (`409`), because the bytes cannot be transformed.
- **A refused client rebases by replaying intent.** The pane undoes its pending
  actions, applies the foreign batches, and re-issues the **method calls it
  recorded** with shifted indexes. It applies only the batches above the seq it
  has already seen and **shifts through all of them**: a structural batch
  normally arrives twice — once on the live lane, once inside the 409's `since`
  list — and re-applying it double-shifts the grid, while skipping its shift
  lands the replayed edit on the wrong row. No CRDT, no operational transform.
- Rebasing rests on a measured engine fact: on `@ironcalc/wasm` 0.8.4
  **`applyExternalDiffs` does not enter the undo stack**. Without that, a
  foreign batch arriving mid-round-trip would have to be held until the
  verdict, because the rollback would undo the wrong person's work.

### A structural batch must carry its intents, or it cannot be rebased across

`SpreadsheetAppliedBatch.structuralIntents` carries the row/column intents a
structural batch performed. Only structural intents travel — the rest of a
summary is the writer's private record and would put one person's keystrokes on
everybody else's wire. A structural batch that arrives **without** them cannot
be rebased across: the client drops its pending intents and shows a notice
rather than replaying blind.

**Current limit, and it is a real one:** every server-built structural batch
carries none by construction. `advisorySummaryForAction`
(`packages/knowledge/src/spreadsheet/writes.ts`) builds its summary without
`intents`, so a `restore`, an import, an engine migration *and every agent
`sheet_structure` insert or delete* reach a person's open pane as an
unrebasable batch. A person typing while an agent inserts a row therefore loses
their pending edit to a notice instead of having it replayed one row down.
Anything that adds a server-built structural path must populate `intents`.

## Evaluation is paused around every apply

`pauseEvaluation()` … `applyExternalDiffs` … `resumeEvaluation(); evaluate()`
is not an optimisation, it is the difference between working and not. The cost
is quadratic in the number of diffs, so it is invisible in a small test and
fatal in production: **200 000 diffs took 2 285 s (38 minutes) un-paused and
164 ms paused**; 20 000 took 24 s un-paused and 15 ms paused. One
pause/resume/evaluate wraps the *whole* catch-up, never one per batch.

## `toBytes()` is not byte-stable; identity is `canonicalHash`

Two models built by the same binding with the same calls in the same order
serialise to different bytes — same length, permuted regions, a hash map's
iteration order reaching the wire — and `fromBytes(toBytes(m))` does not
reproduce `toBytes(m)`. Only re-serialising the same model instance is stable.

So:

- **Never assert that two workbooks are equal by comparing bytes.** The oracle
  is `canonicalWorkbook` / `canonicalHash` / `assertSameWorkbook`
  (`packages/spreadsheet/src/canonical.ts`): sheets, then every non-empty cell
  as content, formatted value, type and normalised style.
- **Never hash `.icalc` bytes into `sourceContentHash`** — an unchanged
  workbook would hash differently on every save. Hash the canonical projection
  or the xlsx rendition.
- Bytes remain fine as transport and storage. They load back faithfully; they
  are useless as an identity.

## Two uncatchable Rust aborts, and the rules that follow

A Rust panic inside a napi call takes the **whole replica**, not just the
request. `try`/`catch` cannot see it. Two are known:

1. **`saveToXlsx` into a missing parent directory panics and aborts the
   process.** Therefore **every engine file call goes through the
   temp-directory helper** (`withTempDirectory` in
   `packages/knowledge/src/spreadsheet/engine.ts`: `mkdtemp` 0700, a
   `randomUUID()` name, cleanup in `finally`). The call also refuses to
   overwrite, appends no extension, and blocks the event loop — about 4 s for a
   million cells.
2. **A failing stdout write during import chatter aborts the process.**
   `fromXlsx` plus `evaluate()` on a foreign file prints one
   `Unexpected type (empty) in <Sheet>!<Cell>` line per affected cell — tens of
   thousands — straight to fd 1 from a Rust thread nobody controls. Twice
   during Phase 1 that ended in `fatal runtime error: failed to initiate panic,
   error 5, aborting`.

Therefore:

- **Imports belong on the worker, never on an API request path.** The API
  stages the upload and enqueues `spreadsheet.import`; it never parses a
  workbook. Whatever collects worker logs must drain fd 1 and never close it
  under a running import.
- **Large exports belong on the worker** for the same blocking reason. At
  Nessie's caps a live export is tens of milliseconds and the request path is
  the right place for it; see "Known gaps" for where the threshold is not yet
  enforced.
- **`@nessie/spreadsheet` runs its test files one at a time**
  (`--test-concurrency=1`). Run concurrently, the memory-heavy xlsx fixtures
  and the engine-pair suite produced a panic-while-panicking that killed the
  runner with no failing assertion to explain it.
- `fromXlsx` **does not evaluate**: formulas read `#ERROR!` until `evaluate()`,
  and an un-evaluated model exports those errors as cached values.
- Import caps are by **uncompressed size and cell count**, never file size:
  sheet XML expands about 11:1, so 1 M cells is a 3.27 MB file and 864 MB RSS.

## The live lane

A per-document SSE lane, `GET /pages/:pageId/live`, fanned out by
`api/src/realtime/document-lane.ts` from an ephemeral NOTIFY. Never the ws
lane: `filterAuthorizedScopes` treats an unknown kind as `agent`, and an old
replica rejects a whole subscribe frame.

- **The `document` envelope carries `scopes: []`, and that field is deploy
  compatibility, not payload data.** It is what keeps a replica running the
  previous build from crashing on this payload during a blue-green swap. It may
  be flattened — the field removed — once no replica older than **2026-09-16**
  can still be running, which in practice means after the first production
  deploy that carries this feature has fully replaced its predecessor. Until
  then, every new realtime kind must be inert to the previous build.
- Everything on the lane is ephemeral: no `Last-Event-ID`, no hydration, no
  pending buffer. A saturated socket **drops** rather than queues, because
  events carry a `seq` and a client that sees a gap re-reads from the catch-up
  route anyway.
- `sheet.ops` over the NOTIFY cap arrives with `diffs: null` rather than being
  dropped in silence, so the client fetches that `seq`.
- Entitlement is asked per event and memoised per connection for
  `REALTIME_ENTITLEMENT_TTL_MS`. **Absent means deny** — a `pageId` is an
  opaque id, never a grant. Delivery-time rechecks have no request session, so
  they authorize through the stored-identity arm; `loadUserViewer` will not
  infer a viewer from persisted membership and returns the denied one.
- The lane and the write door are **two connections, not one**. A proxy that
  refuses a POST while an SSE stream it opened minutes ago keeps flowing is
  ordinary, so the send path has its own jittered retry ladder, reset by a
  successful write and by a lane that comes back. A lane whose *first* connect
  was refused must say so — not only one that dropped after connecting.

### Presence is stateless

The server validates, stamps and forwards; nothing is persisted. A replica that
never saw a frame is not missing state. A joining pane publishes
`sheet.presence.request` and its peers re-announce; agents publish the same
frames from the worker with their own identity and colour. The per-replica
frame budget is a cache, not an authority — a person on another replica simply
gets their own bucket.

## Versions, compaction and the sweeps

**There is no version-retention policy, and nothing may add one.** Versions are
the entire safety net for agent writes, which have no approval gate. What the
housekeeping bounds is replay cost and index staleness, never history.

- A durable version is an **`.xlsx` rendition** on `KnowledgePageVersion` (the
  format of record: `bitcode` bytes are version-coupled and undecodable outside
  the exact crate version), with the `.icalc` bytes kept beside it as the fast
  load path and the text projection in `body` for search.
- Automatic versions fire every `compactEveryBatches` (200) batches, after
  `compactAfterIdleMs` (5 min) of quiet with unsaved batches, before every
  destructive operation by anyone, at an agent run's first write to a page,
  after an import and after a restore.
- **Search is stale between versions**, bounded by those two triggers. The
  pane's find and `sheet_find` read the live model, so a person never sees the
  stale projection; retrieval can.
- `worker/src/control/spreadsheet-sweeps.ts` runs three bounded passes under one
  `withSweepLock` tick every 60 s, each isolating its errors per page:
  **idle compaction** (enqueues `spreadsheet.compact`, keyed by head seq, not by
  the cadence step), **journal pruning** (deletes batches at or below
  `LEAST(snapshot_seq, hot_snapshot_seq)` older than `opsRetentionDays`; a
  client below the remaining journal is answered `SPREADSHEET_CATCH_UP_EXPIRED`
  and re-bootstraps), and **engine migration**.
- The write door answers `{batch, replayed, noop, headSeq, sheetNames,
  safetyNetVersionId}`; the catch-up route answers a page. `safetyNetVersionId`
  is what gives the writer the same "Saved a version before …" line their
  colleagues get from `sheet.snapshot`.
- `'restore'` is one of `SPREADSHEET_STRUCTURAL_KINDS`. It has to be: the
  restore path publishes it, and the event schema throws after the restore has
  already landed otherwise.

## Engine pinning, and an upgrade is a data migration

`SPREADSHEET_ENGINE_VERSION` pins one exact version across the API, the worker
and the browser (`@ironcalc/nodejs` 0.8.3 + `@ironcalc/wasm` 0.8.4, exact).
`packages/spreadsheet/test/engine-pair.test.ts` proves the pair converges in
both directions in CI. Production is greenfield, so there is **no** dual-engine
alias, no format shim and no compatibility layer.

Bumping the pin, in order:

1. **From the previous release, as the last step of its own deploy:** snapshot
   every page with `batches_since_snapshot > 0`. Producing an xlsx from the old
   bytes needs the old engine, so this cannot wait for the swap.
2. The new release rebuilds each page from that xlsx:
   `UserModel.fromXlsx` → new `hotSnapshot`, new `engineVersion`, `headSeq + 1`
   with a `restore` batch, older batches pruned, caches evicted. This is the
   `spreadsheet.engine-migrate` job, enqueued by the sweep.
3. Until a page is migrated the write door answers `409
   SPREADSHEET_ENGINE_MISMATCH` and the pane says "being upgraded, read only",
   so a blue-green swap is safe.
4. Anything the xlsx cannot carry is lost at that point. That is by design. The
   filter model is ours and lives on the head, so it survives untouched.

## The UI: wrap, do not fork

- **Nothing in the repo modifies the library.** All three IronCalc packages are
  plain version references (`@ironcalc/workbook` 0.8.3, `@ironcalc/wasm` 0.8.4,
  `@ironcalc/nodejs` 0.8.3), there is no `patches/` directory and no
  `pnpm.patchedDependencies`. Everything Nessie needs that the package does not
  publish is done from outside it.
- **The repaint: one synthetic `Escape`** (`WorkbookHost.tsx` → `repaintGrid`).
  `IronCalcHandle` has `setLanguage` and nothing else, and the only thing that
  paints the canvas from the current model is a re-render of the widget's
  **`Workbook` subtree** — `Worksheet` rebuilds `WorksheetCanvas` and calls
  `renderSheet()` in a dependency-free effect. `Workbook` drives that from a
  private `useState` counter, every keyboard action it handles bumps that
  counter, and Escape is the one whose handler changes nothing else worth
  keeping. So `redraw()` is
  `container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', … }))`
  aimed at `.ic-workbook-container`.
- **Aiming it at that element is the whole safety argument.** The widget's key
  handler starts with `event.target !== root` → return, so targeting the
  container is both what makes it run and what keeps the event away from the
  cell editor's `<textarea>` handlers below it: a peer's batch landing while
  somebody is typing leaves their editor open with its text. React's synthetic
  `stopPropagation()` calls the native one, so the event dies at React's root
  container — measured: 0 listeners reached on `document`, `body` or `window` in
  the bubble phase. Capture-phase listeners still see it, which is why
  **`SpreadsheetPane`'s fullscreen Escape requires `event.isTrusted`**; without
  that line every peer batch threw the person out of fullscreen.
- **What it costs, exactly.** Escape also clears the cut outline and disarms the
  format painter (`WorkbookState.clearCutRange()` / `setCopyStyles(null)`). Both
  are drawing state: a paste reads `type: "cut"` off the clipboard payload, so
  paste semantics do not ride on `cutRange`. That is the only measured
  difference from the patch this replaces.
- **Two cheaper nudges do not work** and the measurement is in
  [the spike record](../plans/2026-09-15-spreadsheets-ironcalc/spike-cd-render-touch.md):
  a `window` `resize` and a synthetic `scroll` on `.ic-worksheet-wrapper` both
  repaint the canvas, but they only re-render `Worksheet`, so the address box,
  the formula bar and the sheet tab bar stay stale — which breaks find/replace
  stepping, whose whole job is to move the selection and show where it went.
- **An upgrade must fail loudly**, which is what a patch file did for free and a
  DOM reach-in does not: `admin/test/spreadsheet-repaint-contract.test.ts` pins
  the version, the container class, the `target !== root` guard, Escape's route
  to `onEscape`, that `onEscape` still bumps the counter and gained no side
  effect worth keeping, and `Worksheet`'s dependency-free repaint effect. If it
  goes red, do not loosen it — re-read the new `dist/ironcalc.js`, and check
  first whether upstream has published a repaint on `IronCalcHandle`, because a
  published method beats a synthetic key press.
- The rest is own-property wrappers on the wasm `Model` instance (52 of them,
  no fork) for intent recording, flush and selection frames; a delegated
  `input` listener on the editor textarea for drafts; our own presence overlay;
  our own action bar.
- **`IronCalc` builds `WorkbookState` in its root render body**, so a parent's
  re-render discards in-cell editing state even with referentially stable
  props. Memoising the element is what makes React skip the subtree. The
  synthetic Escape is safe because it re-renders the subtree rather than the
  root.
- **An empty send queue flushes as one `0x00` byte**, so a naive flush loop
  burns a `seq` per microtask. `isEmptyDiffPayload` is the guard.
- `darkThemeVariables` does not exist in the published package; one token
  mapping covers all eleven admin themes, plus four CSS rules iOS needs because
  it answers a long press with its own text selection.
  `--palette-common-black` is a **foreground** token — mapping it to a surface
  erased the toolbar, and only a screenshot caught it.
- The grid chunk is lazy: 667 kB JS (173 kB gzipped) + 72 kB CSS + 1.97 MB wasm
  (675 kB gzipped), proven lazy on a production build. `LiveSpreadsheetPane` is
  the lazy entry point.

## Honest feature gaps

IronCalc 0.8 has formulas, styles, number formats, frozen panes, defined names,
named styles, conditional formatting and hyperlinks. It does **not** have:

- **Merged cells.** The string `merge` does not appear in either binding or in
  `wasm_bg.wasm`. Merges cannot be added in our layer — the grid is IronCalc's
  own canvas renderer and the model has nowhere to store them. Owner decision,
  2026-09-16: stay on IronCalc and accept the gap. A merged range **survives an
  xlsx round trip** (it is preserved in the file and invisible to the API), so
  an imported workbook does not lose its merges on save; it simply cannot show
  or edit them. The import warning list says so.
- **Data validation.** Absent. Imported, warned about, not editable.
- **Cell comments / notes.** Absent.
- Charts, images, drawings and pivot tables. Absent.
- An imported **autofilter** is read into `Table` and never written back, so
  that one is genuinely lost on a round trip.

**Sort, filter and find/replace are ours, not the engine's.** Reference-preserving
sort (formula meaning kept under Excel/Sheets copy semantics via `getTokens`), a
persisted per-sheet filter model applied as engine row hiding and visible to
agents, and find/replace across sheets all live in `@nessie/spreadsheet` and
`@nessie/knowledge`. Do not look for them in IronCalc, and do not assume the
engine will enforce anything about them.

Two more measured surprises worth knowing before writing code against the
bindings: **hidden is not queryable as a boolean** (a hidden row or column
reports size 0; there is no `getRowsHidden`), and **`pasteCsvString` is TSV**,
not CSV — it also needs `setSelectedCell` placed first and treats the area as
an anchor, so we parse CSV ourselves.

The standing rule for every behavioural question this file does not answer:
**do what Google Sheets does.** Check it in Sheets before choosing, and record
the answer in the plan's `decisions.md`.

## Verification

- `pnpm --filter @nessie/admin test:e2e:spreadsheets` — two real browsers, two
  real accounts, one API and one database, nothing stubbed: a live batch, the
  presence overlay and draft ghost, the structural rebase, the offline queue and
  phone touch selection. CI runs `node admin/e2e/spreadsheets/ci.mjs` in
  Navigation Transitions, which **starts and stops its own servers** rather than
  adopting a listening one — a run that adopted another worktree's API seeded
  into the wrong database and said nothing about it. The suite raises its own
  API's login rate limit, or a local re-run fails at 10 sign-ins per IP per
  10 minutes.
- `api/test/spreadsheet-multi-instance.test.ts` — two replicas over one
  database: ops cross, presence re-announces, the cache is fast-forwarded.
- `worker/test/db/spreadsheet-sweeps.test.ts` — the three sweeps against real
  rows.

## Known gaps

- **Server-built structural batches carry no intents** (see above). Every agent
  structural write is unrebasable by an open pane.
- **`sheet_export` renders synchronously on the API, with no threshold, and
  that is a measured decision rather than an oversight.** `exportXlsxBytes`
  costs about 1.2 µs a cell on this hardware — 22 ms at 20 000 cells, 97 ms at
  100 000, 465 ms at 400 000 — so the largest importable workbook (~2 M cells)
  blocks one replica's event loop for roughly two to three seconds, not the
  four seconds a million cells that the plan feared. Refusing above a cap would
  stop a person downloading their own spreadsheet; an asynchronous export would
  change the tool's contract and the download flow for a two-second stall
  nobody has hit. Both were judged worse than the stall. What is genuinely open
  is the adversarial case: nothing rate-limits an agent calling
  `nessie_sheet_export` in a loop against a large sheet. Revisit with the
  numbers above when there is a workbook big enough to make it matter.
