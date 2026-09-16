# IronCalc — verified assessment

Verified against a clone of `ironcalc/IronCalc` at commit
`4a95d5d71c574c37b4cab37e5fa30e1cfe719e42` (main, 2026-09-07), the npm
registry, and a live probe of `@ironcalc/nodejs` 0.8.3 / `@ironcalc/wasm`
0.8.4 under Node on 2026-09-15. Every claim below was read in source or
measured; nothing is taken from the README.

## Identity and health

| Fact | Value |
|---|---|
| Crates | `ironcalc_base` (engine, `base/`), `ironcalc` (xlsx reader/writer, `xlsx/`), bindings for wasm, Node (napi-rs 3), Python |
| npm | `@ironcalc/wasm` 0.8.4 (2026-08-01), `@ironcalc/nodejs` 0.8.3 (2026-07-31), `@ironcalc/workbook` 0.8.3 (2026-07-31, React UI) |
| License | MIT / Apache-2.0 dual (`LICENSE-MIT`, `LICENSE-Apache-2.0`); the Node package manifest says MIT |
| Repo | 4 160 stars, 181 forks, 256 open issues, last push 2026-09-13; monthly-ish releases |
| Bus factor | Two people carry it: `nhatcher` 947 commits, `dg-ac` 635; then `elsaminsut` 186 and a tail of ≤ 33. Active, but a two-person core. |
| Engine limits | `LAST_ROW = 1_048_576`, `LAST_COLUMN = 16_384` (`base/src/constants.rs:22-25`) — Excel's grid |
| Functions | 496 variants in `enum Function` (`base/src/functions/mod.rs:29`); docs mark 57 function pages "not implemented" (e.g. `INFO`, `CELL`). Probe: `SUMIFS`, `XLOOKUP`, `TEXTJOIN`, `FILTER`, `LET`, `LAMBDA` evaluate. |
| Documented gaps (`docs/docs.ironcalc.com/src/features/unsupported-features.md`) | **Collaboration** ("work in progress… top priority after 1.0"), **charts** (not for 1.0), **pivot tables** (planned) |
| Not in engine or UI (grep of `base/src` and `webapp/IronCalc/src`) | sort, autofilter, find/replace, cell comments, images, data validation |
| In engine and UI | multiple sheets (new/duplicate/rename/move/hide/colour), insert/delete/move rows and columns, row height / column width / hidden, frozen panes (column/row header context menus), merges (`merge_cells*`, `unmerge_cells`), cell styles (font, fill, borders, alignment, wrap, number formats via `FormatMenu`), named styles, named ranges, conditional formatting (right drawer), themes, links, clipboard copy/paste incl. CSV paste, undo/redo, array formulas, regional settings, locale/timezone |

## The engine's collaboration surface (`base/src/user_model/`)

`UserModel` wraps `Model` and records every mutation as a `DiffList`
(`Vec<Diff>`), pushing it to **both** the undo history and a `send_queue`:

```rust
pub(crate) fn push_diff_list(&mut self, diff_list: DiffList) {       // common.rs:2336
    self.send_queue.push(QueueDiffs { r#type: DiffType::Redo, list: diff_list.clone() });
    self.history.push(diff_list);
}
pub fn flush_send_queue(&mut self) -> Vec<u8>           // bitcode::encode(&self.send_queue), then clears it   (common.rs:395)
pub fn apply_external_diffs(&mut self, bytes: &[u8]) -> Result<(), String>   // common.rs:408
    // decodes Vec<QueueDiffs>; Redo → apply_diff_list, Undo → apply_undo_diff_list
```

- `Diff` (`history.rs:24`) is a closed enum of ~45 variants, each carrying
  the **new and old** value: `SetCellValue{sheet,row,column,new_value,old_value}`,
  `SetArrayValue`, `RangeClearContents/All`, `SetCellStyle`, `ApplyNamedStyle`,
  `SetColumnWidth/Hidden`, `SetRowHeight/Hidden`, `Set/DeleteColumnStyle`,
  `Set/DeleteRowStyle`, `InsertRows/Columns`, `DeleteRows/Columns{old_data}`,
  `New/Delete/Duplicate/Rename/MoveSheet`, `SetSheetColor/State`,
  `SetFrozen*Count`, `SetShowGridLines`, `SetTheme`, defined names, named
  styles, merged cells, links, conditional formatting, locale/timezone/name.
- **Sheets are addressed by index (`u32`), not id**, in every diff.
- `apply_external_diffs` applies through the ordinary `Model` setters and
  does **not** push into the local undo history (verified: a replica's
  `undo()` after applying a remote batch undid only its own last action).
- **Encoding is `bitcode`** (binary, not self-describing, not decodable from
  JS). `Diff` and `QueueDiffs` are `pub(crate)`; the bindings expose only the
  two byte-oriented calls. Consequence: Nessie cannot inspect a batch's
  contents, only apply it.
- Both bindings expose the pair: `UserModel.flushSendQueue()/applyExternalDiffs()`
  in `@ironcalc/nodejs` (`bindings/nodejs/src/user_model.rs:111,120`) and
  `Model.flushSendQueue()/applyExternalDiffs()` in `@ironcalc/wasm`
  (`bindings/wasm/src/lib.rs:200,205`; the wasm `Model` **is** a
  `UserModel`).
- **Determinism (measured):** two Node `UserModel`s, one built by edits and
  one by `applyExternalDiffs` of the first's queue, produce byte-identical
  `toBytes()`. Two replicas applying the *same* diffs in *different* order
  diverge (verified with a cell edit crossing an `insertRows`). So: same
  engine version on every side + a total order = convergence; order is the
  host's job.
- **Evaluation cost trap (measured):** `apply_diff_list` calls
  `evaluate_if_not_paused()` once per `QueueDiffs` entry, i.e. once per
  original user action. Applying 20 000 single-cell diffs took **24 s**
  un-paused and **15 ms** with `pauseEvaluation()` first; 200 000 took
  **2 285 s (38 min) un-paused** and **164 ms paused** — quadratic, and the
  difference between a working product and a hung replica.
  `resumeEvaluation()` does **not** evaluate — call `evaluate()` after it
  (verified: a dependent stayed stale until `evaluate()`).
- Other measurements on the arm64 dev Mac: 200 000-cell workbook build 222
  ms; `toBytes()` 1.88 MB; `fromBytes` 14 ms; one edit + evaluate on that
  workbook 34 ms; 20 000 `getFormattedCellValue` calls over napi 12 ms;
  process RSS 203 MB with that model loaded.
- `to_bytes()` is `bitcode::encode(&self.workbook)` (`model.rs:3425`) — the
  `.icalc` file format is the same bytes. It is **version-coupled**: a
  workbook or diff encoded by one crate version is not guaranteed to decode
  under another (pre-1.0, no schema versioning in the bytes).

**Judgement:** this is exactly the primitive a server-authoritative design
needs — a deterministic engine that emits and applies its own diffs on both
sides — with two consequences Nessie must own: (1) total ordering and
conflict policy (the engine has none; its own docs say collaboration is not
shipped), (2) opacity of the bytes, so batch *metadata* (what was touched,
whether structure changed) must come from the caller, and rebase after a
structural conflict must replay **intent**, not bytes (`storage-and-concurrency.md`).

## Node binding (`@ironcalc/nodejs`)

- napi-rs 3, `napi4` feature; prebuilt optional packages for
  `linux-x64-gnu/musl`, `linux-arm64-gnu/musl`, `darwin-arm64/x64/universal`,
  `win32-x64-msvc/arm64-msvc`, plus arm/riscv/android. Covers Docker on
  Hetzner x86 (glibc or Alpine), Mac dev, Windows CI, and any arm64 host.
  Loader (`index.js`) detects musl. No build-from-source fallback needed.
- API: `UserModel` (the collaborative one) and `Model` (lower level, has
  `getAllCells`, `getSheetMarkup`, per-cell typed setters). Both have
  `fromXlsx`, `saveToXlsx`, `fromBytes`/`toBytes`, `from/saveToIcalc`.
  `UserModel` carries the full editing surface listed above plus
  `getSheetDimensions`, `getSelectedView`, clipboard helpers
  (`copyToClipboard`, `pasteFromClipboard`, `pasteCsvString`), auto-fill,
  conditional formatting, named styles/ranges.
- Reads are per-cell FFI calls (`getCellContent`, `getFormattedCellValue`,
  `getCellType`, `getCellStyle`); no bulk range read on `UserModel`
  (`Model.getAllCells` exists). 12 ms per 20 000 cells is fine for the tool
  caps in `agent-tools.md`.
- **Binding bug (verified):** `UserModel.pasteFromClipboard` cannot accept
  the object `copyToClipboard` returns — napi refuses the string keys of
  `Record<string, Record<string, ClipboardCell>>` (`invalid type: string
  "1", expected i32`) and a `Map` deserialises to nothing. The same call
  works in the wasm build. Upstream fix is a one-line key coercion; until
  then the server never uses paste.
- **Reference displacement exists in the engine but is not exposed:**
  `Model::extend_to` (copy semantics: `=B1*D4` moved from A1 to A30 becomes
  `=B30*D33`) and `Model::move_cell_value_to_area` (cut semantics) live in
  `base/src/model.rs:1854-1926`; neither binding exports them. `moveRows` /
  `moveColumns` do rewrite references (verified) but cost ≈ 70 ms per call
  on a 2 000-row sheet (paused): a permutation built from them sorted 2 000
  rows in 11.8 s and 10 000 rows in 564 s, and a `=SUM(A1:A2000)` outside
  the range came out as `=SUM(A1:A1920)` — a range-shrinking bug in the
  move rewrite. Not a sort primitive, and the bug is reported upstream. `getTokens(formula)` (wasm only, also runs in Node)
  returns every token with `start`/`end` offsets and structured
  `Reference`/`Range` tokens carrying `sheet`, `row`, `column`,
  `absolute_row`, `absolute_column` — enough to rewrite references from
  outside without a formula parser of our own.
- xlsx: `xlsx/src/import/*` reads workbook, worksheets, shared strings,
  styles, themes, conditional formatting, tables, metadata, hyperlinks;
  merged cells; comments read partially (`TODO: author`); pivot tables
  skipped (`styles.rs:356`); unknown CF rule types skipped silently; `.xls`
  (BIFF) unsupported. Export writes the same families. Fidelity is
  engine-complete: everything the engine models round-trips, everything
  it does not (charts, images, pivots, comments) is dropped.

## Wasm (`@ironcalc/wasm`)

- `wasm_bg.wasm` is **1.9 MB** raw (≈ 650 KB gzip expected; Phase 0 measures
  the served size). Same API as the Node `UserModel` (as class `Model`).
- The npm package is built **without** the `xlsx` feature (no `fromXlsx` in
  `wasm.d.ts`; CI uploads a separate `wasm-xlsx` artifact that is not the
  published package). Import/export therefore lives on the server.
- Loads in Node too (`initSync({ module: readFileSync(wasm_bg.wasm) })`),
  which is how Phase 0 proves wasm↔nodejs diff compatibility without a
  browser, and how the server borrows `getTokens` for formula rewriting.
- **Clipboard semantics (verified in wasm):** copy-paste displaces relative
  references by the move and keeps absolute ones (`=A1&"x"` → `=A3&"x"`,
  `=$A$1` unchanged, `=F1` → `=F3`); cut-paste makes references to the moved
  cells follow them (`=$A$1` → `=$A$5`). A 2 000-row × 2-column paste took
  56 ms.
- **Version pairing:** npm today has wasm 0.8.4 but nodejs 0.8.3, and
  `@ironcalc/workbook` 0.8.3 depends on `@ironcalc/wasm ^0.8.3`. Because the
  diff and workbook bytes are version-coupled, Nessie pins **one** engine
  version on both sides (0.8.3/0.8.3 unless Phase 0 proves 0.8.4↔0.8.3
  round-trips) and treats an engine bump as a data event
  (`storage-and-concurrency.md` §"Engine upgrades").

## React UI (`@ironcalc/workbook`, `webapp/IronCalc/`)

- Peer deps: `react ^18 || ^19`, `react-dom`, `i18next ^26`, `react-i18next
  ^16`, `lucide-react ^1`. Uses its own `i18n.createInstance()` (no clash
  with an app that does not use i18next; the admin does not). Locales: en,
  de, es, fr, it. Built with Vite 8 / React 19.2 in-repo; `dist/ironcalc.js`
  + `dist/ironcalc.css`, 885 KB unpacked.
- Public surface (`src/index.ts`, `IronCalc.tsx`): `init(wasmUrl?)`,
  `Model`, `<IronCalc model themeVariables rootContainer canEdit>`, ref
  `IronCalcHandle = { setLanguage }`, `darkThemeVariables`, a handful of
  primitive components. `canEdit=false` hides the toolbar and blocks edits
  (present in the published 0.8.3 `IronCalc.d.ts`).
- **Theming:** `themeVariables` sets CSS custom properties (`--palette-*`,
  `--typography-*`; `theme/themeVariables.ts`) on the root container; the
  grid canvas reads its colours from the same variables through the model's
  theme. `darkThemeVariables` is shipped. This is a real theme bridge, unlike
  FortuneSheet's hard-coded CSS.
- **No hooks for the host.** There is no `onChange`, no `onSelectionChange`,
  no presence prop, no way to force a redraw from outside: `Workbook.tsx`
  keeps a private `setRedrawId` (line 64) it bumps after its own actions;
  the window `resize` listener only re-measures. Selection and viewport live
  in the wasm model (`getSelectedView() → {sheet,row,column,range,top_row,left_column}`,
  `getScrollX/Y`, `setSelectedRange`, `setTopLeftVisibleCell`).
- The in-cell editor is a `<textarea>` inside `.ic-worksheet-editor-wrapper`
  (`Editor.tsx:353`); the draft text is `workbookState.getEditingCell().text`
  but `WorkbookState` is constructed inside `IronCalc.tsx` and not exposed.
- DOM: `.ic-widget > … .ic-worksheet-wrapper.scroll > .ic-worksheet-sheet-container > canvas.ic-worksheet-sheet-canvas` with sibling outline divs;
  header sizes are constants (`headerRowHeight = 28`, `headerColumnWidth = 30`,
  `WorksheetCanvas/constants.ts`).
- **Touch (verified in source and on the live app at 375×812):**
  `usePointer.ts:50-54` returns early from `onPointerMove` for any
  `pointerType !== "mouse"` — "Range selections are disabled on non-mouse
  devices. Use touch move only to scroll for now" — so on a phone a tap
  selects a cell, a drag scrolls the sheet natively, and a range cannot be
  selected by dragging; there are no selection handles, no `touch-action`
  rules, no pinch handling (the viewport meta allows browser pinch zoom) and
  no `@media` rules. The editor is a `<textarea>`, so the on-screen keyboard
  appears on edit; double-tap opens it (`onDoubleClick` on the sheet
  container fires for a double tap). On `app.ironcalc.com` in a 375×812
  viewport the toolbar collapses into a horizontal strip with a "more"
  chevron, the formula bar and sheet tabs fit, and double-tap → type →
  Enter committed a value. Verdict: **editable on phones today; range
  selection by touch is the one missing piece**, and it is addable from
  outside (`admin-ui.md` §"Phone").
- The reference deployments do not collaborate: `webapp/app.ironcalc.com/server`
  is a Rocket + SQLite upload/download/share-by-hash service;
  `embed.ironcalc.com` is an iframe that receives workbook bytes by
  `postMessage`. Neither calls `flushSendQueue`.

## Gaps against "a Google Sheets alternative", and what closes them

| Gap | Closed by |
|---|---|
| No live collaboration | Nessie's ordered journal + per-document lane (`storage-and-concurrency.md`, `realtime-and-presence.md`) |
| No change / selection / redraw hooks | **Wrap, do not fork:** the sync layer shadows the wasm `Model` instance's mutating methods with own-property wrappers (records intent, flushes the send queue, emits selection frames); the draft observer listens to `input` on the editor textarea; **one `pnpm patch` (≈ 20 lines) adds `redraw()` to `IronCalcHandle`** by lifting `setRedrawId` to the root — the only thing the host cannot do from outside. Upstream PR for `redraw` + `onModelChange`. |
| No presence rendering | Own `PresenceOverlay` over the sheet container, rectangles computed from the model (widths, heights, frozen counts, `top_row/left_column`, scroll element offsets) |
| No sort / filter | Nessie's own layer with full fidelity: sort rewrites relative references (Sheets/Excel copy semantics) through `getTokens`; a persisted per-sheet filter model applied as engine row hiding; both in the pane and the tools (`storage-and-concurrency.md` §"Sort, filter, find and replace"). Upstream: expose `extend_to`, fix the Node paste bug, and eventually an engine autofilter (the engine already imports xlsx `<autoFilter>` into `Table` but does not filter). |
| No find / replace | Across-sheets find and replace in our layer over `getSheetDimensions` + `getCellContent`; upstream candidate: a Rust `search` for very large sheets |
| Touch range selection | Our overlay handles touch pointers (long-press + drag, corner handles) and writes `setSelectedRange`; upstream PR for `usePointer` |
| No comments, images, charts, pivots, validation | Out of scope v1 (page-level annotations still work) |
| Bitcode opacity | Batch metadata from the caller; intent-replay rebase; upstream PR proposal `summarize_diffs(bytes)` (Phase 5 candidate) |
| Two-person core team | Pin exact versions; keep the integration surface to the six calls above; Phase 0 diff round-trip test guards every bump |

## When to fork

Fork (`UnlikeOtherAI/IronCalc`, publishing `@nessie/ironcalc-*`) only if:

1. The `redraw` patch cannot be expressed as a ≤ 50-line `pnpm patch` on
   the published `dist`, or upstream rejects the hook and the patch keeps
   breaking on releases.
2. Method-shadowing on the wasm `Model` instance breaks under a wasm-bindgen
   upgrade (Phase 0 render spike proves it on the pinned version).
3. A diff-format or `to_bytes` incompatibility across versions needs a
   compatibility shim in Rust.

A Rust build is not otherwise part of Nessie's spreadsheet pipeline; the
repo already carries Rust for Tauri and the executor, so a fork is feasible,
just not free.
