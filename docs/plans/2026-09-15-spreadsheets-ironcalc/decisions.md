# Phase 0 spike record

Measured facts from the orchestrator's Phase 0 work, against
`@ironcalc/nodejs` 0.8.3 and `@ironcalc/wasm` 0.8.4 on Node 24.18.

## Spike A — engine pair (run 2026-09-16)

Verdict: **the pair converges**, and the pair
`wasm 0.8.4` + `nodejs 0.8.3` is the candidate pin.

- `flushSendQueue()` on either binding, applied with `applyExternalDiffs()`
  on the other (wrapped in `pauseEvaluation()` … `resumeEvaluation();
  evaluate()`), produces the same workbook in both directions: contents,
  computed values, cell types and styles all equal over a fixture with
  text, numbers, a `SUM`, a bold range and an inserted row.
- Bytes produced by `nodejs` 0.8.3 load in `wasm` 0.8.4 and back with no
  loss, so the two published versions are not format-incompatible.

**`toBytes()` is not byte-deterministic.** Two models built by the same
binding with the same calls in the same order serialise to different bytes
(same length, permuted regions — a hash-map iteration order reaches the
wire), and `fromBytes(toBytes(m))` does not reproduce `toBytes(m)`. Only
re-serialising the *same* model instance is stable. Consequences, which
correct the plan:

1. **Convergence must never be asserted on bytes.** The oracle is the
   canonical projection (`canonical.ts`): sheets, then every non-empty cell
   as content, formatted value, type and normalised style. Phase 2's
   concurrency tests and every "equal workbook" assertion use it.
2. **`sourceContentHash` must not hash `.icalc` bytes** — an unchanged
   workbook would hash differently on every save. Hash the canonical
   projection (or the xlsx rendition), as `storage-and-concurrency.md` now
   says.
3. Bytes remain fine as a *transport and storage* format (they load back
   faithfully); they are only useless as an identity.

## The two bindings are not structurally interchangeable

The plan assumed one narrow interface satisfied by both because "they
already share method names". They do not, so `engine.ts` carries a thin
adapter per binding:

| | `@ironcalc/wasm` `Model` | `@ironcalc/nodejs` `UserModel` |
|---|---|---|
| `updateRangeStyle` | `(Area, path, value)` | `(sheet, r1, c1, r2, c2, path, value)` |
| `getCellStyle` | `ExtendedCellStyle` (`{ style }`) | bare `CellStyle` (`getExtendedCellStyle` for the other) |
| `getSheetDimensions` | absent — use `getRowsWithData`/`getColumnsWithData` | `[minRow, maxRow, minColumn, maxColumn]` (note the order) |
| `getAllCells` | absent | declared in `index.d.ts` but **not on `UserModel`** at runtime |
| xlsx | absent (published wasm has no xlsx feature) | `fromXlsx`/`saveToXlsx`, file paths only |

## Engine feature coverage against the goal (0.8.x)

Searched both bindings' type surfaces and the wasm binary.

| Capability | IronCalc 0.8 |
|---|---|
| Formulas, styles, number formats, frozen panes, defined names, named styles | yes |
| Conditional formatting, hyperlinks | yes |
| **Merged cells** | **absent — the string `merge` does not appear in either binding or in `wasm_bg.wasm`** |
| **Data validation** | **absent** |
| **Cell comments / notes** | **absent** |
| Charts, images, drawings, pivot tables | absent |
| Sort, autofilter, find/replace | absent (this plan builds them in our layer) |

The first three are the ones this plan assumed present: `phases.md` lists
`mergeCells*`/`unmergeCells`/`getMergedCells` in the Phase 0 interface and
`storage-and-concurrency.md` has sort refuse a range with merges. No such
API exists. Merges cannot be added in our layer: the grid is IronCalc's own
canvas renderer and the workbook model has no place to store them, so this
is upstream Rust work (model, renderer, xlsx round-trip) or a gap we accept.
**Owner decision, 2026-09-16: stay on IronCalc and accept the gap.** Ship
without merged cells, data validation or cell comments; an imported xlsx that
has merges loses them (the import warning list says so). Every reference to
merges elsewhere in this plan is therefore struck: `phases.md`'s Phase 0
interface drops `mergeCells*`/`unmergeCells`/`getMergedCells`, and sort has no
merged-range case to refuse. Revisit if upstream adds them.

## Phase 0 outcomes (orchestrator, 2026-09-16)

| Item | Outcome |
|---|---|
| Rebase onto `origin/main` | done, base `4992a38ca` (carries PR #501's stream CORS fix) |
| Engine pin | `SPREADSHEET_ENGINE_VERSION = '0.8.3'`; `@ironcalc/nodejs` 0.8.3 + `@ironcalc/wasm` 0.8.4, exact |
| Shared contract | `packages/schemas/src/spreadsheet.ts` + 11 tests; `spreadsheets` tool category added |
| Engine interface | `packages/spreadsheet/src/engine.ts`: `SpreadsheetEngineModel` with `wrapNodeModel`, `wrapWasmModel`, `createUnimplementedModel` |
| Convergence oracle | `canonicalWorkbook` / `canonicalHash` / `assertSameWorkbook` in `src/canonical.ts` — replaces every byte comparison |
| Spike A test in CI | `packages/spreadsheet/test/engine-pair.test.ts`, 5 tests, green |
| Migration | `20260916090000_spreadsheets`, whole chain applied on a throwaway pgvector container, no drift on the new objects |

A1 addressing note: `A1Schema` deliberately refuses a sheet-qualified
reference (`Sheet1!B2`). Every tool and route takes the sheet separately, so a
range can never disagree with the sheet it was addressed to.

## Spike B — xlsx and CSV (agent branch `agent/spike-xlsx`, 2026-09-16)

Full measurements in [spike-b-xlsx.md](spike-b-xlsx.md). The corrections it
forces on this plan, all measured:

- **`saveToXlsx` into a missing parent directory panics in Rust and aborts the
  process** — uncatchable by `try`/`catch`. Every engine file call goes
  through a temp-directory helper (`mkdtemp` 0700, `randomUUID()` name,
  `finally` cleanup). It also refuses to overwrite, appends no extension, and
  blocks the event loop (~4 s for 1 M cells), so large exports belong on the
  worker.
- **`fromXlsx` does not evaluate**: formulas read `#ERROR!` until `evaluate()`,
  and an un-evaluated model exports those errors as cached values.
- **`pasteCsvString` is TSV**, not CSV — Phase 1 parses CSV itself; the call
  also needs `setSelectedCell` placed first, and treats the area as an anchor.
- **Import caps are by uncompressed size and cell count, not file size**:
  1 M cells is a 3.27 MB file but 864 MB RSS (~11:1 XML expansion).
- **Format sniffing before the engine**: an `.xls` and a corrupt zip produce
  the same engine error, so `detectWorkbookFormat` decides.
- **Warnings need a marker scan**, not just the part list: autofilter,
  validation, hyperlinks, protection and outlines live inside sheet XML.
- **Hidden is not queryable as a boolean** — a hidden row or column reports
  size 0; there is no `getRowsHidden`.
- **Merged cells survive an xlsx round trip** even though no binding exposes
  them: they are preserved in the file and invisible to the API. So an
  imported workbook does not lose its merges on save — it simply cannot show
  or edit them.
- An imported autofilter is read into `Table` and never written back, so that
  one is genuinely lost on round trip.

## Spike C/D — render and touch (agent branch `agent/spike-render`, 2026-09-16)

Full record in [spike-cd-render-touch.md](spike-cd-render-touch.md).

- **Render passes** under React 19.2 in `StrictMode`: editing, undo/redo,
  insert-row with the formula following, a peer's diffs applied paused and
  landing correctly, and the method-shadowing bridge (52 own-property
  wrappers, no fork) recording intents and draining diffs.
- **The repaint needs no patch** (corrected 2026-09-16; the spike shipped one
  and it has been deleted). A peer's batch really is invisible without a
  repaint — the canvas was byte-identical after it landed — but the repaint is
  reachable from outside: the widget bumps its private redraw counter for every
  key it handles, and `Escape` is the one whose handler changes nothing else
  worth keeping, so one synthetic `keydown` aimed at `.ic-workbook-container`
  does it. Measured identical to the patched `redraw()` on the canvas bytes, the
  address box, the formula bar, the sheet tab bar, frozen panes, a batch landing
  mid-scroll and an editor left open mid-edit. Its one cost is that Escape also
  clears the cut outline and disarms the format painter, both drawing state.
- **Phone editing ships**, verified in real Mobile Safari on iOS 26.5, not
  only Chromium: long-press-drag selected a range with handles and did not
  scroll the page, and a plain drag still scrolled. The overlay is 182 lines.
  The upstream `usePointer` change is optional, not a prerequisite.
- **Bundle**: lazy chunk 667 kB (173 kB gzipped) + 72 kB CSS + 1.97 MB wasm
  (675 kB gzipped), proven lazy on a production build.
- `darkThemeVariables` **does not exist** in the published package (the plan
  promised it); one token mapping covers all eleven admin themes. A four-rule
  CSS override *is* needed, against `admin-ui.md`'s claim, because iOS answers
  a long press with its own text selection.
- `--palette-common-black` is a foreground token; mapping it to a surface
  erased the toolbar, and only a screenshot caught it.
- **An empty send queue flushes as one `0x00` byte**, so a naive flush loop
  would burn a `seq` per microtask.
- `workbookState` is built in the render body, so a root re-render discards
  in-cell editing state; the repaint is safe because it re-renders the subtree.
- **A `window` resize and a synthetic `scroll` on the worksheet wrapper repaint
  the canvas but not the widget's own chrome** — they re-render `Worksheet`
  only, so the address box, formula bar and sheet tab bar stay stale, which
  would break find/replace stepping. Only the `Workbook` subtree counts as a
  repaint.
- **A synthetic Escape is visible to capture-phase listeners**, and
  `SpreadsheetPane`'s fullscreen handler was one: without an `event.isTrusted`
  check every peer batch threw the person out of fullscreen. React's synthetic
  `stopPropagation()` calls the native one, so nothing on `document`, `body` or
  `window` sees it in the bubble phase.

## Test isolation: the engine's panic can abort the runner

`@nessie/spreadsheet`'s files must run one at a time
(`--test-concurrency=1`). Run concurrently, the memory-heavy xlsx fixtures and
the engine-pair suite together produced `fatal runtime error: failed to
initiate panic, error 5, aborting` — a Rust panic while panicking, which kills
the test process and fails the package for a reason no assertion explains.
Serialised, the same 25 tests pass repeatedly with exit code 0.

## The engine writes to stdout, and that write can abort the process

Importing a foreign `.xlsx` and evaluating it prints one `Unexpected type
(empty) in <Sheet>!<Cell>` line per affected cell — tens of thousands for a
modest fixture — straight to fd 1 from a Rust thread we do not control. Twice
during Phase 1 integration that ended as

```text
thread '<unnamed>' panicked at library/std/src/io/stdio.rs:1165:9
fatal runtime error: failed to initiate panic, error 5, aborting
```

which kills the process with no failing assertion to explain it. It is the
same hazard class as the missing-directory panic from Spike B: a Rust panic
inside a napi call takes the whole replica, not just the request.

Consequences:

- `@nessie/spreadsheet` runs its files with `--test-concurrency=1`, and the
  noisy fixture was cut from 500 to 50 formula rows. If the abort ever
  reappears in CI, isolate the import tests in a child process with `stdio:
  'ignore'` rather than chasing the volume.
- **Imports belong on the worker**, never on an API request path: the chatter
  is unbounded in the size of the imported file, and a failing stdout write
  aborts the process that is doing it. Whatever collects worker logs must
  drain fd 1 and never close it under a running import.

## Phase 3b corrections (agent branch `agent/sheets-live`, 2026-09-16)

Measured while building the live layer and its two-browser suite. Each one
corrects something this plan asserted.

- **`applyExternalDiffs` does not enter the undo stack** (`@ironcalc/wasm`
  0.8.4). Two models from one base, a local edit on A2 and a peer's on A3, the
  peer's diffs applied, one `undo()`: A2 cleared, A3 kept. Rule 4's rollback
  depends on this; without it a foreign batch arriving during a round trip
  would have to be held back until the verdict.
- **A structural batch reaches a client twice** — once on the live lane, once
  inside the 409's `since` list, because the same commit publishes it and then
  refuses the racing batch. Rule 4 now **applies** only the batches above
  `appliedSeq` and **shifts through all of them**. Re-applying one the lane
  already delivered pushes the grid down twice (`insertRows` is not
  idempotent); skipping its shift lands the replayed edit on the wrong row.
- **`structuralIntents` had to be added to `SpreadsheetAppliedBatch`.** Rule 4
  shifts by "the foreign structural batches' summaries", but a summary is the
  writer's private record and is not on the wire. Only structural intents
  travel; a batch that arrives without them cannot be rebased across, and the
  client drops its pending intents with a notice rather than replaying blind.
  **Every server-built structural batch carries none by construction**
  (`advisorySummaryForAction` in `writes.ts` sets no `intents`), so restore,
  import, engine-migrate and every agent `sheet_structure` write are currently
  unrebasable by an open pane.
- **`'restore'` had to be added to `SPREADSHEET_STRUCTURAL_KINDS`.** The
  restore path publishes it, and the event schema threw *after* the restore had
  landed.
- **The write door answers `{batch, replayed, noop, headSeq, sheetNames,
  safetyNetVersionId}`** and the catch-up route answers a page. Neither is the
  shape the facade assumed. `safetyNetVersionId` is what gives the writer the
  same "Saved a version before …" line their colleagues get from
  `sheet.snapshot`.
- **The lane and the write door are two connections.** Rule 5 reads as if they
  were one; a proxy that refuses a POST while an SSE stream it opened minutes
  ago keeps flowing is ordinary. The send path has its own jittered retry
  ladder, reset by a successful write and by a lane that comes back. A lane
  whose *first* connect was refused must also report it — `onClose` fired only
  after an established stream dropped.
- **`WorkbookState` is rebuilt by a parent's render**, referentially stable
  props notwithstanding, so typing into a cell did nothing: the editor read
  `getEditingCell() === null` on a fresh state. Memoising the element is what
  makes React skip the subtree.
- **The e2e suites must never adopt a listening server.** One run drove another
  worktree's API: the port answered, the seed found no users, and nothing in
  the failure said whose database it was talking to. Both `run.mjs` and
  `ci.mjs` start and stop their own. The suite also raises its own API's login
  rate limit, or a local re-run fails at 10 sign-ins per IP per 10 minutes.
