# Spike B — xlsx fidelity

Run 2026-09-16 on `@ironcalc/nodejs` 0.8.3 (the pinned server engine), macOS
arm64, Node 24.18. Everything below was measured, not read off the crate.

Code: `packages/spreadsheet/test/xlsx-fidelity.test.ts` (24 cases, green),
`packages/spreadsheet/test/fixtures/**` (the generator and the round-trip
expectations), `packages/spreadsheet/src/xlsx-warnings.ts` (the warnings the
import route stores).

## The fixture

Generated in the test by **exceljs** — a writer that is not IronCalc, so the
import path is exercised against foreign markup — and mirrored by an
IronCalc-written variant:

| Sheet | Cells | What it carries |
|---|---|---|
| `Data` | 14 011 | 2 000 rows, dates, currency, `#,##0.00` and `"$"#,##0.00` number formats, `=E2*0.21` / `=E2+F2`, bold white-on-blue header, a `thin`/`double red` border box, frozen 1 row × 2 columns, autofilter `A1:G1`, hidden row 5 and column F, merge `I1:K1` |
| `Lookup` | 10 | the VLOOKUP table |
| `Calc` | 3 003 | 500 rows of `Data!E…`, `VLOOKUP`, `IF`, `TEXT`, `UPPER(LEFT(…))`, running `SUM($E$2:$E$n)`, plus `SUM` over 2 000 cells, `COUNTA`, `SUM(GrandTotal)` through a defined name |
| `Bulk` | 34 000 | 1 700 × 20 plain numbers |
| `Notes` | ~60 | hyperlink, cell comment, data validation list, conditional format, an image, an Excel table, an outlined row, sheet protection |

≈ **51 100 cells**, 228 317 bytes.

## Timings and sizes

| Step | Time |
|---|---|
| `UserModel.fromXlsx` (51 k cells, foreign) | **90–107 ms** |
| `model.evaluate()` after import | included above, ~15 ms of it |
| `saveToXlsx` (51 k cells) | **67–78 ms** |
| `fromXlsx` of our own export | 82–93 ms |
| `saveToXlsx` / `fromXlsx`, IronCalc-written 4.5 k cells | 5 ms / 4 ms |
| 24 concurrent `saveToXlsx` to distinct paths | 13–21 ms total |
| CSV export of 2 001 × 11 formatted values | 17–21 ms, 144 KB |
| `pasteCsvString` of 50 000 cells | 71–83 ms (443 069 diff bytes) |
| rejecting a 2 000-entry zip that is not a workbook | **1 ms** |

Sizes: source 228 317 B → our export **256 534 B** (+12 %; IronCalc writes
`xl/metadata.xml` and does not re-use the source's shared-string packing).

Scale, single sheet, 20 columns, one `SUM` per row:

| Cells | `saveToXlsx` | file | `fromXlsx` | `evaluate` | `toBytes` | RSS |
|---|---|---|---|---|---|---|
| 100 000 | 1.2 s | 0.33 MB | 0.37 s | 16 ms | 5 ms / 0.93 MB | 186 MB |
| 500 000 | 2.6 s | 1.64 MB | 1.2 s | 560 ms | 80 ms / 4.65 MB | 475 MB |
| 1 000 000 | 4.2 s | 3.27 MB | 1.9 s | 595 ms | 83 ms / 9.30 MB | **864 MB** |

Engine bytes are ~2.8× the xlsx. RSS is ~**264× the xlsx file size**, and the
zip's own uncompressed:compressed ratio for ordinary sheet XML is ~**11:1**.

## The loss table

Source feature present → is it in the model, and is it in the file we write
back? "Round trip" is `fromXlsx` → `saveToXlsx` → `fromXlsx`.

| Feature | Imported | Survives export | Notes |
|---|---|---|---|
| Cell values, text, numbers, booleans | ✅ | ✅ | |
| Formulas (as formulas, not cached values) | ✅ | ✅ | cross-sheet, absolute, `VLOOKUP`/`IF`/`TEXT`/`UPPER`/`LEFT`/`SUM`/`COUNTA` all correct |
| Cell types (`getCellType`) | ✅ | ✅ | dates import as numbers with a date `num_fmt` |
| Number formats | ✅ | ✅ | `yyyy-mm-dd`, `#,##0.00`, `"$"#,##0.00` byte-identical |
| Font bold / size / colour / name | ✅ | ✅ | |
| Fill colour | ✅ | ✅ | |
| Borders incl. style and colour | ✅ | ✅ | `thin`, `double` + `#FF0000` |
| Frozen panes | ✅ | ✅ | rows and columns |
| Hidden rows / columns | ✅ | ✅ | surfaced as height/width **0**, see below |
| Explicit column widths / row heights | ✅ | ✅ | |
| Defined names (global) | ✅ | ✅ | name and formula unchanged |
| Conditional formatting | ✅ | ✅ | rule, range, operator, priority |
| Sheet names, order, visibility | ✅ | ✅ | |
| **Merged cells** | ✅ | ✅ | survives, but **no binding exposes it** — see contradiction 1 |
| **Autofilter** | partial | ❌ | read into the engine's `Table`, never written back |
| **Excel tables** (`xl/tables/`) | ❌ | ❌ | become plain ranges |
| **Hyperlinks** | ❌ | ❌ | only the display text remains |
| **Data validation** | ❌ | ❌ | |
| **Cell comments / notes** | ❌ | ❌ | `xl/comments*.xml`, `vmlDrawing*.vml` dropped |
| **Images, drawings, shapes** | ❌ | ❌ | `xl/media/`, `xl/drawings/` dropped |
| **Charts** | ❌ | ❌ | documented upstream gap |
| **Pivot tables** | ❌ | ❌ | documented upstream gap |
| **Sheet / workbook protection** | ❌ | ❌ | |
| **Row and column grouping (outlines)** | ❌ | ❌ | flattened |
| **Print setup, headers/footers** | ❌ | ❌ | not warned about (cosmetic; see `xlsx-warnings.ts`) |
| Macros, slicers, external links, OLE, queries, custom XML | ❌ | ❌ | not in the fixture; covered by part-name rules and unit-tested |

Our own export is a **fixed point**: a third pass produces the same part list
and the warnings scan of it is empty. An IronCalc-written workbook round-trips
with nothing lost.

## `src/xlsx-warnings.ts`

`deriveXlsxWarnings({ parts, sheets })` is pure and deterministic: twelve
part-name rules (`XLSX_PART_LOSSES`) and six worksheet-markup rules
(`XLSX_MARKER_LOSSES`), evidence capped at 8 entries per code, output ordered
by the catalogue. `scanXlsxWarnings(bytes)` is the end-to-end call: a
dependency-free zip central-directory reader plus `node:zlib` inflation of the
worksheet parts only, under a byte budget.

On the fixture it returns exactly:

```text
images · comments · tables · autofilter · data_validation · hyperlinks
sheet_protection · outlines
```

`detectWorkbookFormat(head)` sniffs the container: `xls` (OLE2 magic
`D0 CF 11 E0 A1 B1 1A E1`), `xlsx` (`PK`), `csv-or-text`, `unknown`.

The marker rules are deliberately narrow. exceljs and Excel both write
`<pageSetup/>`, `<headerFooter/>`, empty `<hyperlinks/>` and
`outlineLevel="0"` on sheets that use none of them; a loose marker would warn
about every upload. A case asserts that inert markup produces no warnings.

## `.xls`, corrupt and hostile files

| Input | Result |
|---|---|
| Legacy `.xls` (OLE2) | throws `Zip Error: … Could not find central directory end` |
| The same bytes renamed `.xlsx` | identical error |
| Empty file | throws `Zip Error: … Invalid zip header` |
| Random bytes | throws `Zip Error: … Could not find central directory end` |
| Truncated real `.xlsx` | same error |
| A CSV renamed `.xlsx` | `Zip Error: … Invalid zip header` |
| Valid zip without `xl/workbook.xml` | throws `Zip Error: specified file not found in archive` |
| 2 000-entry zip, no workbook | rejected in **1 ms** — rejection does not scale with entry count |
| Missing file | throws `I/O Error: No such file or directory (os error 2)` |

Every one of these is a catchable JS `Error`. **The engine's message never
distinguishes them**, so an `.xls` and a corrupt upload read the same to a
user. `detectWorkbookFormat` is what lets the import route say "this is the
old .xls format, save it as .xlsx" instead of "corrupt file"; the route should
sniff first and only then hand the path to the engine.

There is no size or cell cap inside the binding. See contradiction 5.

## `fromXlsx` / `saveToXlsx` take file paths — the streaming verdict

Confirmed against `index.d.ts` and at runtime: 0.8.3 has
`static fromXlsx(filePath: string, …)` and `saveToXlsx(file: string): void`
and **no buffer or stream variant** on either `Model` or `UserModel`
(`fromIcalc`/`saveToIcalc` are paths too; only `fromBytes`/`toBytes` take
bytes, and those are the version-coupled internal format). We take uploads as
streams or buffers through `FileService`, so every import and export has to
land on disk first.

Four rules the dance must follow, each with a test:

1. **`saveToXlsx` into a directory that does not exist panics in Rust and
   aborts the process.** `xlsx/src/export/mod.rs:69` unwraps the file handle;
   the panic crosses the napi boundary as `fatal runtime error: failed to
   initiate panic` and `try`/`catch` never sees it. A single export to a bad
   path kills the API or worker replica. The test proves it in a child
   process. **Always `mkdir -p` the parent (or `mkdtemp` it) before calling.**
2. **`saveToXlsx` refuses an existing path** (`I/O Error: file … already
   exists`). Every export picks a fresh name; never reuse one, never "write
   over the previous rendition".
3. **`saveToXlsx` writes exactly the path given** — it appends no extension.
4. **Concurrency is safe as long as paths are distinct.** 24 simultaneous
   exports from 24 models completed in 13–21 ms with no interference. The
   calls are synchronous and block the event loop; a 1 M-cell export blocks it
   for ~4 s, so large exports belong on the worker, not in an API request.

The shape Phase 2 should lift (tested end to end as
"buffer → temp file → model → temp file → buffer"):

```ts
function withTempDirectory<T>(run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nessie-xlsx-'))
  try {
    return run(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
```

`mkdtemp` gives a `0700` directory with a unique name, so the rules above are
satisfied by construction: the parent exists, the names inside are ours, and
two concurrent calls cannot collide. Write the upload with `mode: 0o600`,
`randomUUID()` the file names, and let `finally` remove the whole directory —
the binding never cleans up anything it wrote. A crash between the two calls
leaks one directory under the system temp dir, which the OS reaps; a sweep is
not worth building.

Do **not** try to stream around this. Reading the upload into a temp file is
one pass over bytes we have already paid to receive; the expensive part is the
parse, which is in Rust either way.

## CSV

- **`pasteCsvString` is tab-separated, despite the name.** `"a,b,c\n1,2,3"`
  becomes two cells (`a,b,c` and `1,2,3`), not a 2 × 3 block; `"a\tb\tc"`
  splits correctly. It does handle RFC 4180 quoting *within* a field
  (`"a\tb"` stays one cell, `""` unescapes), so it is Excel clipboard TSV.
- **The area argument is an anchor, not a clamp.** Pasting a 2 × 3 text into
  a 1 × 1 area writes all six cells. A caller cannot bound a paste by passing
  a small area.
- **The model's selected cell must be a corner of the area**, or it throws
  `The selected cell is not in one of the corners`. `setSelectedCell(startRow,
  startColumn)` first. (This is the upstream "Node paste key fix" the plan
  mentions; it is a hard precondition today, not a nicety.)
- Values are coerced: `1` → number, `true` → boolean (`getCellType` 4),
  `" 007"` → number 7, `2024-01-02` → date, `=1+1` → a live formula.
- 50 000 cells paste in ~80 ms under one `pauseEvaluation()` /
  `resumeEvaluation(); evaluate()`, producing 443 069 diff bytes in the send
  queue. A drained `flushSendQueue()` returns **one byte** (`[0]`, the empty
  list), never zero — do not test for length 0.
- **CSV export** is ours: `getSheetDimensions` for the used range,
  `getFormattedCellValue` per cell, RFC 4180 quoting. 2 001 rows × 11 columns
  in 17–21 ms. Hidden columns still export (the engine carries them as
  width 0), which matches the plan.

## Contract changes this forces

1. **`mergeCells*` / `unmergeCells` / `getMergedCells` do not exist.** Neither
   `@ironcalc/nodejs` 0.8.3 nor `@ironcalc/wasm` 0.8.4 exposes any merge,
   autofilter, table, comment, image or data-validation method — verified by
   grep over both `.d.ts` files. `phases.md` §"Phase 0" item 3 lists them in
   `SpreadsheetEngineModel` and `agent-tools.md` / `storage-and-concurrency.md`
   assume them (sort "merges refused" has nothing to query). Merges in a
   *source* file do survive the round trip, so they are carried in the Rust
   model and re-emitted — they are simply unreachable from JS. Phase 0 must
   drop them from the interface, and merging becomes an upstream ask, not a
   Phase 1 feature. `library-assessment.md` line 22 ("merges … in engine and
   UI") is true of the Rust crate and the webapp, not of our two bindings.
2. **CSV import cannot "delegate to `pasteCsvString`"**
   (`storage-and-concurrency.md` §"Import and convert"). That call is TSV.
   Phase 1's `csv.ts` must parse the CSV itself — delimiter sniffing, quotes,
   embedded newlines — and hand IronCalc a tab-joined block sized to the
   parsed shape, after `setSelectedCell` on the anchor.
3. **`fromXlsx` does not evaluate.** Every formula reads `#ERROR!` until
   `evaluate()` is called, and an un-evaluated model *exports those errors as
   cached values* — an import that forgets it writes a broken version of
   record. `importSpreadsheet` and `engine-migrate` must both evaluate before
   the first snapshot. A test pins this.
4. **Export needs a directory guard.** Rule 1 above is an availability bug,
   not a style point: `exportSpreadsheet`, `createSpreadsheetSnapshot` and the
   migration driver all call `saveToXlsx`, and any of them pointed at a
   missing parent takes the replica down. `withTempDirectory` is the only
   sanctioned caller.
5. **The 64 MiB parse cap is far too generous.** A 3.27 MB xlsx already needs
   ~864 MB RSS; at the same density 64 MiB admits a workbook needing ~15 GB,
   and sheet XML decompresses ~11:1 before the model is even built. Cap on
   *declared uncompressed size* from the zip central directory (which
   `xlsx-warnings.ts` already parses — add `uncompressedSize`, it reads the
   field's neighbour today) plus a cell cap from
   `SPREADSHEET_LIMITS`. A 16 MiB compressed / 256 MiB uncompressed pair is
   roughly 2 M cells and ~1.7 GB RSS; that is the order of magnitude to pick
   from, and the number belongs in `SPREADSHEET_LIMITS`, not in a route.
6. **Warnings cannot come from the part list alone.**
   `storage-and-concurrency.md` says warnings are "derived by comparing the
   source package's part list". Autofilter, data validation, hyperlinks,
   protection and outlines have no part of their own — they are attributes
   inside `xl/worksheets/sheetN.xml`, and they are exactly the losses a person
   notices. The marker scan is not optional. Wording in
   `storage-and-concurrency.md` §"Import and convert" should say "part list
   and a marker scan of the worksheet parts".
7. **An imported autofilter does not survive our export.** The plan is right
   that the engine reads `<autoFilter>` into `Table`
   (`xlsx/src/import/tables.rs:107`); it does not write it back, so the
   round trip loses it entirely. Nessie's own filter model is the only thing
   that persists a filter, and the import must say so — the warning does.
8. **`packages/spreadsheet` needs dev dependencies.** The fixture generator
   imports `exceljs` (already in the lockfile via `packages/dashboard`, and
   resolvable because the workspace uses `nodeLinker: hoisted`). Declare
   `exceljs` as a `devDependency` of `@nessie/spreadsheet` so the resolution
   is not an accident of hoisting. The test needs no zip library —
   `test/fixtures/stored-zip.ts` writes stored zips in 50 lines and
   `src/xlsx-warnings.ts` reads them with `node:zlib`.
9. **Hidden is not queryable as a boolean.** There is no `getRowsHidden` /
   `getColumnsHidden`; a hidden row or column reports height/width **0**.
   `filter.ts`'s hidden-row delta and the structural remap must read 0, and
   Phase 0's interface should say so where it lists `setRows/ColumnsHidden`.
10. **The two bindings disagree on one return type.** `UserModel.getCellStyle`
    (Node) returns `CellStyle`; `Model.getCellStyle` (wasm) returns
    `ExtendedCellStyle` — Node puts the conditional-format decorations on a
    separate `getExtendedCellStyle`. `SpreadsheetEngineModel` must type the
    method as the narrower shape both satisfy, or Phase 1's shared read helpers
    will not compile against both.

## What did not need changing

The plan's headline claims hold: xlsx is a viable format of record, values,
formulas, types, styles, frozen panes, hidden rows and columns, defined names
and conditional formatting all survive a foreign import and our own export, a
51 000-cell workbook imports in under 110 ms, and the export is stable under
repetition. Version history built on xlsx renditions is safe for everything in
the ✅ half of the loss table, which is everything Nessie's own editor can
produce.
