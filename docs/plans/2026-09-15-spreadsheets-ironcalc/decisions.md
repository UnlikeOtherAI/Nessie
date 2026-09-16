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
