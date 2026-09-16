# Delivery audit — spreadsheets

Every requirement this plan states, where it landed, and what did not. Written
at the end of Phase 5 (2026-09-16) by walking [overview.md](overview.md)
§Goal, its ten numbered decisions, its eight settled decisions, and each
phase's deliverables in [phases.md](phases.md).

Commit hashes are on the integration branch
(`claude/spreadsheet-library-integration-a8e5af`); `agent/sheets-harden`
carries Phase 5's.

**Read the gaps before the table.** Four things in this plan are not what a
reader of the prose would assume, and one of them a person can feel.

## What is missing, stubbed or untested

| Gap | Why it matters | Where |
|---|---|---|
| **Every server-built structural batch carries no `structuralIntents`.** `advisorySummaryForAction` sets no `intents`, so a restore, an import, an engine migration and **every agent `sheet_structure` insert or delete** reach an open pane as a batch nobody can rebase across. The pane drops its pending edit with a notice instead of replaying it one row down. | The one gap a person feels. An agent inserting a row while somebody types costs that person their keystrokes. | `packages/knowledge/src/spreadsheet/writes.ts`; rule in [`docs/standards/spreadsheets.md`](../../standards/spreadsheets.md) |
| **`agent-presence` e2e does not run.** Marked PENDING with its reason printed on every run: `runAgentScenario` is still the placeholder the harness declares for Phase 4 to wire, and the case reads cells as `[data-cell="B2"]`, which nothing renders — IronCalc's grid is a canvas. | The case the no-approval-gate decision rests on is the one case with no browser coverage. The `spreadsheet-agent-edit` mock-LLM scenario exists; nothing drives it from a browser. | `admin/e2e/spreadsheets/run.mjs` `PENDING`, `cases/agent-presence.mjs` |
| **`sheet_export` renders synchronously on the API with no threshold.** Measured, not overlooked: ~1.2 µs a cell (22 ms at 20 000, 97 ms at 100 000, 465 ms at 400 000), so the largest importable workbook stalls one replica two to three seconds. A cap would stop a person downloading their own sheet; an async export would change the tool contract. Open: nothing rate-limits an agent looping `nessie_sheet_export`. | An availability risk with a number on it, deliberately not paid for yet. | `packages/knowledge/src/spreadsheet/export.ts`; §"Known gaps" in the standard |
| **The pre-swap snapshot step of an engine upgrade has no automation.** The new release's half is a sweep and a job; the previous release's "snapshot every page with unsaved batches before the image swap" is a documented manual step. | An engine bump run without it leaves pages with no durable version, which `migrateSpreadsheetEngine` refuses. | §"Engine pinning" in the standard; `worker/src/control/spreadsheet-sweeps.ts` |

Three more, smaller, all stated in the standard: merged cells, data validation
and cell comments do not exist in IronCalc 0.8 and are not emulated (owner
decision, accept the gap); an imported autofilter is genuinely lost on a round
trip; and search of a spreadsheet trails the live workbook by up to 200 batches
or five idle minutes, because the text projection is written with a version.

## §Goal, clause by clause

| Clause of the goal | Landed | Where |
|---|---|---|
| "a first-class document in the knowledge base" | yes | `KnowledgePageKind.spreadsheet`, migration `20260916090000_spreadsheets` — `b69d20e57` |
| "a person creates one where they create any document" | yes | `POST /spaces/:spaceId/spreadsheets`, `SpreadsheetCreateDialog`, the knowledge create menu — `042bdc1bf`, `46ca073a8` |
| "edits it in the admin with a real grid (formulas, formatting, sheets…)" | yes | `SpreadsheetPane` + `WorkbookHost` over `@ironcalc/workbook` — `46ca073a8` |
| "…sorting, filters" | yes, **ours not the engine's** | `packages/spreadsheet/src/sort.ts`, `filter.ts`, `find.ts`; `agent-filters.ts` — `551d4ad22`, `8750ed66b` |
| "…merges" | **no — struck** | Absent from IronCalc 0.8; owner decision 2026-09-16 to accept. Imported merges survive the file and stay invisible. `decisions.md` §"Engine feature coverage" |
| "sees everybody else in it live — selection, cursor, what they are typing before they commit" | yes | `live/PresenceOverlay.tsx`, `useDraftObserver.ts`, presence lane — `53667a462`; proved in the browser by `two-browsers` — `92cd52898` |
| "agents work in the same document through a full tool set" | yes | twelve `sheet_*` builtins + `nessie_sheet_*` mirror — `d79d042e8`, `919046653`, `637ae6eb7` |
| "visibly, as if they were another person at the table" | **partly** | Agents publish presence frames from the worker (`worker/src/run/pa-tools/spreadsheet-tools.ts`) and have a colour; the browser case that proves a person sees it is PENDING (above) |

## The ten decisions

| # | Decision | Landed | Where |
|---|---|---|---|
| 1 | IronCalc, one exact pin on all three packages, not forked | yes | `SPREADSHEET_ENGINE_VERSION`; `@ironcalc/nodejs` 0.8.3 + `@ironcalc/wasm` 0.8.4 + `@ironcalc/workbook` 0.8.3 exact, and **nothing in the repo modifies the library**: the 6-line `pnpm patch` that published `redraw()` was replaced by `WorkbookHost`'s `repaintGrid` (a synthetic `Escape` at `.ic-workbook-container`), measured identical, and `patches/` is gone — `40322c34e`, `aafa48e52`, `agent/sheets-unpatch` |
| 2 | Canonical state is the workbook: engine bytes + an ordered diff journal | yes | `spreadsheet_heads.hot_snapshot`, `spreadsheet_op_batches` — `b69d20e57` |
| 3 | Durable versions are `.xlsx` renditions, `.icalc` beside them | yes | `snapshot.ts`, `restore.ts`; blob keyed by version id, not seq (Phase 2 correction) — `8750ed66b`, `ba67a4aa4` |
| 4 | Server canonical, browser optimistic; one `applySpreadsheetBatch` | yes | `apply.ts`, `commit.ts`, `head.ts` — `8750ed66b` |
| 5 | Server order, cell-level LWW, structural refusal, rebase by intent replay | yes | `rebase.ts` + `live/sync-engine.ts`; `structural-rebase` e2e — `886d6c66d`, `92cd52898` |
| 6 | A per-document SSE lane, `document` kind, `scopes: []` | yes | `api/src/realtime/document-lane.ts`, `packages/runtime/src/realtime-publish.ts` — `8750ed66b`, `042bdc1bf` |
| 7 | Presence stateless, agents publish the same frames | yes | `presence.ts` (no persistence, per-replica budget); agent frames from the worker — `8750ed66b`, `919046653` |
| 8 | One write door, `@ironcalc/nodejs` in API and worker, one cache per process | yes | `createSpreadsheetService` closure state; proved across replicas by `api/test/spreadsheet-multi-instance.test.ts` — `8a9bc6ed8` |
| 9 | Twelve tools, `spreadsheets` category, mirrored 1:1, no approval gate | yes | `SHEET_TOOL_IDS`, `builtin-sheet-tools.ts`, `api/src/mcp/tools/spreadsheets.ts` — `d79d042e8`, `637ae6eb7`, `8449e5868` |
| 10 | Wrap, do not fork: one patch, wrappers, own overlay and action bar | yes | 52 own-property wrappers, the delegated editor listener, `SpreadsheetActionBar` — `46ca073a8`, `53667a462` |

## The eight settled decisions (owner, 2026-09-16)

| # | Settled decision | Honoured |
|---|---|---|
| 1 | No cell locks, now or as an option | yes — nothing in the write door locks a cell |
| 2 | Batch summary advisory only, never an authorization input | yes — `api/test/spreadsheet-summary-advisory.test.ts` |
| 3 | Versioning, not an approval gate, for destructive agent writes | yes — automatic pre-destructive version, `safetyNetVersionId` on the write door's answer, History → Restore, `sheet_versions` |
| 4 | Engine upgrades are data migrations, one simple job | yes — `migrateSpreadsheetEngine` plus the sweep and `spreadsheet.engine-migrate` that Phase 5 added; the pre-swap half is manual (gap above) |
| 5 | Stream CORS already fixed on `main` by #501; MCP endpoint's silence is correct | yes — branch rebased; the `paired-agents.md` sentence is **not written** (deferred, below) |
| 6 | Phones get full editing, view-only never device-driven | yes — `useTouchSelection.ts`, `phone-touch` e2e at 390×844 with `hasTouch` |
| 7 | Sort/filter/find are Nessie's layer, full fidelity | yes — reference-preserving sort via `getTokens`, persisted per-sheet filter model, cross-sheet find/replace |
| 8 | Bundle ~0.9 MB JS + 1.9 MB wasm, lazily loaded | yes — 667 kB JS (173 kB gz) + 72 kB CSS + 1.97 MB wasm, lazy on a production build; `LiveSpreadsheetPane` is the entry point |

## Phase 5's own deliverables

| Deliverable | Landed | Where |
|---|---|---|
| Idle compaction sweep | yes | `sweepIdleSpreadsheets`, keyed by head seq — `d2687d755` |
| Journal-batch pruning per `opsRetentionDays` | yes | `pruneSpreadsheetOpBatches`, floor `LEAST(snapshot_seq, hot_snapshot_seq)` |
| **No version-retention policy** | honoured | the sweep module says so; a test asserts versions a year past any window survive a prune |
| Engine-migrate driver | yes | `sweepStaleSpreadsheetEngines` + `spreadsheet.engine-migrate`; closes `migrateSpreadsheetEngine` having had no caller |
| Multi-instance case | yes | `api/test/spreadsheet-multi-instance.test.ts` — ops cross, presence re-announces, the cache fast-forwards; verified to fail when B listens elsewhere — `8a9bc6ed8` |
| `docs/standards/spreadsheets.md` | yes | written from `decisions.md`, not from the plan's prose |
| `AGENTS.md` routing sentence, `CLAUDE.md` e2e line, §9e | yes | `72a0b3551` |
| CI step + artifact upload | yes | `Run spreadsheets browser suite` in Navigation Transitions, `spreadsheets-screenshots` upload; `ci.mjs` rewritten because it double-started the servers and could never have run — `f0b67232e` |
| The two cosmetic fixes + screenshot | yes | one History; the action bar inside the header block — `f0b67232e`, `phase-5/pane-chrome.png` |
| `zip-size.ts` TODO(Phase 1) | closed | `declaredUncompressedBytes` moved onto the parser that already read the neighbouring field — `a262a761f` |
| `sheet_export` size threshold | measured, not built | see the gap table |

## Deferred, with the reason

| Item | Reason |
|---|---|
| The one-sentence note in `docs/standards/paired-agents.md` that the MCP endpoint's lack of CORS headers is correct | Phase 5's optional list. `paired-agents.md` is not a spreadsheets file and the sentence is about the MCP endpoint, not about this feature; left to whoever next edits that standard rather than reached into from here. |
| `summarize_diffs` adoption (dropping the client-reported summary) | Upstream has not shipped it. Decision 2 keeps the client summary advisory until it does. |
| Delegating `formula-shift` to IronCalc's `extend_to` | Not exposed by the published bindings. |
| Conditional-format and named-range tools | Phase 5's optional list; the twelve-tool surface is what decision 9 committed to. |

## Gates, at the end of Phase 5

Run on `agent/sheets-harden`, each judged by its own exit code:

- `pnpm lint` (all five repo-wide scripts, `lint:test-globs`, `lint:migrations`,
  `turbo run lint`) — green. Two failures the integration branch was carrying
  are fixed in `72a0b3551` rather than allowlisted.
- `pnpm typecheck` — green.
- `@nessie/admin` (1 634), `@nessie/spreadsheet` (148), `@nessie/knowledge`
  (177) suites — green. The identity-palette test, which had started passing
  vacuously, is repaired in `f0b67232e`.
- `worker/test/db/spreadsheet-sweeps.test.ts` — 4 green; the prune assertion
  verified to fail when the floor is neutralised.
- `api/test/spreadsheet-multi-instance.test.ts` — green.
- `admin/e2e/spreadsheets/ci.mjs` — 4 cases pass, `agent-presence` PENDING,
  run headless against this checkout's own API and admin.

Every tracked markdown file is under 1 000 lines.
