# Phases, ownership, acceptance

Waves follow the global rules: one worktree and branch per agent, exclusive
paths, commit and push every turn, no PRs from sub-agents, the orchestrator
integrates. Every phase ends with its own focused tests green through Turbo
with `DATABASE_URL` exported, `pnpm lint` (root) green, and its
documentation written in the same turn. Whole-repo `pnpm test` runs at each
wave's integration, not per agent.

Common obligations for every phase:

- Code files ≤ 500 lines; no `-helpers`/`-extras` dumping.
- New realtime kinds inert (`scopes: []`); new NOTIFY doors measure the cap.
- No module-scope mutable state in `api/src` / `worker/src`; the model
  cache is closure state of a once-per-process factory.
- Every `applyExternalDiffs` is wrapped in `pauseEvaluation()` …
  `resumeEvaluation(); evaluate()` — a lint-style test greps for a bare call.
- Every new test file sits inside its package's `test` glob
  (`pnpm lint:test-globs`).
- Cast Prisma fakes extended in the same change that extends a query.
- A tracked markdown file stays under 1000 lines.

## Phase 0 — Contract and spikes (orchestrator, before any wave)

Owns: `packages/schemas/src/spreadsheet.ts` (+ `__tests__/spreadsheet.test.ts`),
`packages/schemas/src/tool-categories.ts` (add `spreadsheets`),
`packages/schemas/src/realtime-document.ts` (event names and data shapes),
`api/prisma/schema.prisma` + `api/prisma/migrations/2026091600_spreadsheets/`,
`packages/spreadsheet/{package.json,tsconfig.json,src/index.ts,src/engine.ts}`
(skeleton + the `SpreadsheetEngineModel` interface below), `patches/@ironcalc__workbook@<ver>.patch`
(`redraw`), dependency pins (`@ironcalc/workbook`, `@ironcalc/wasm`,
`i18next`, `react-i18next`, `lucide-react` in `admin`; `@ironcalc/nodejs` in
`packages/spreadsheet`), `turbo.json` / `pnpm-workspace.yaml`, `decisions.md`
(spike record).

Deliverables:

0. Rebase the integration branch onto `origin/main` (≥ `2c9963eff`, which
   carries PR #501's stream CORS fix) before anything else; every wave
   branches from that base.
1. Schemas as `storage-and-concurrency.md` §"Shared contract", built.
2. Migration applied on a throwaway pgvector container
   (`nessie-throwaway-pg-migration-check` recipe), then `prisma:generate`.
3. `SpreadsheetEngineModel` — the narrow interface every other phase codes
   against, satisfied by both `@ironcalc/nodejs` `UserModel` and
   `@ironcalc/wasm` `Model` (they already share method names):
   `fromBytes/toBytes`, `applyExternalDiffs/flushSendQueue`,
   `pauseEvaluation/resumeEvaluation/evaluate`, `getSheetDimensions`,
   `getWorksheetsProperties`, `getCellContent/getFormattedCellValue/getCellType/getCellStyle`,
   `setUserInput`, `updateRangeStyle`, `rangeClear*`, `insertRows/Columns`,
   `deleteRows/Columns`, `moveRows/Columns`, `setRows/ColumnsHidden`,
   `setRows/ColumnsWidth|Height`, `mergeCells*`/`unmergeCells`/`getMergedCells`,
   `setFrozen*Count/getFrozen*Count`, sheet ops, `getSelectedView`,
   `setSelected*`, `saveToXlsx`/`fromXlsx` (Node only, typed as optional),
   `pasteCsvString`. A `createUnimplementedModel()` throws
   `SPREADSHEET_ENGINE_UNAVAILABLE`.
4. **Spike A — engine pair.** Under Node: build a workbook with the wasm
   `Model`, `flushSendQueue`, apply on a `@ironcalc/nodejs` `UserModel`,
   compare `toBytes()`; and the reverse. Do it for the candidate pairs
   (0.8.4/0.8.3, 0.8.3/0.8.3); pin the first that passes as
   `SPREADSHEET_ENGINE_VERSION`. This test stays in CI as
   `packages/spreadsheet/test/engine-pair.test.ts`.
5. **Spike B — xlsx.** A 5-sheet, 50 000-cell workbook with formulas, merges,
   number formats, conditional formats, frozen panes, named ranges:
   `fromXlsx` → `saveToXlsx` → `fromXlsx`, cell values and styles equal;
   timings; which source parts (charts, images, pivots, comments) vanish —
   the basis of the import `warnings` list.
6. **Spike C — render.** `<IronCalc>` mounts in the admin under React 19.2
   inside a throwaway page (not committed): edit, undo, insert row,
   `applyExternalDiffs` from a second model + `redraw()` via the patch, the
   method-shadowing bridge, `themeVariables` from admin tokens,
   `darkThemeVariables`. Measure the served wasm and chunk sizes with
   `pnpm --filter @nessie/admin build`. Any failure → `library-assessment.md`
   §"When to fork".
7. **Spike D — touch.** Playwright `hasTouch: true` phone context against
   the Spike C page: tap selects, double-tap edits with the keyboard, drag
   scrolls, and a prototype of the overlay's long-press range selection
   writes `setSelectedRange`. Outcome decides whether Phase 3b's touch work
   is the planned ≈ 200 lines or needs the upstream `usePointer` change
   first.
8. `decisions.md` records the outcomes and any contract change they forced;
   the upstream PRs (`redraw`, `onModelChange`, `summarize_diffs`,
   `extend_to` exposure, the Node paste key fix, touch range selection in
   `usePointer`) are opened and linked.

Acceptance: typecheck and lint green repo-wide; migration check passes;
Spike A pins a pair; Spikes B and C have written outcomes.

## Wave A (three agents in parallel, from the Phase 0 base)

### Phase 1 — Engine adapter (`packages/spreadsheet`)

Owns: `packages/spreadsheet/src/**`, `packages/spreadsheet/test/**`,
`packages/spreadsheet/package.json` scripts and `exports`.

A small package now — the engine does the heavy work. Modules:

- `a1.ts` — re-exports of the schema helpers plus `rangeToCells`,
  `resolveSheetIndex(names, name)`.
- `read.ts` — `readRange(model, sheet, range, values)`, `describe(model)`,
  `find(model, query, opts)`, `usedRange(model, sheet)` over
  `getSheetDimensions`; all respect `maxCellsPerRead`.
- `write.ts` — `writeRange(model, sheet, anchor, rows, opts)`,
  `formatRange(...)`, `restructure(model, action)`, `manageTabs(...)`: each
  builds its calls inside `pauseEvaluation()`, returns the exact
  `SpreadsheetBatchSummary` (structural kind, sheet indexes, cell count,
  touched rectangles) and leaves the diffs in the model's send queue for the
  caller to flush.
- `formula-shift.ts` — `shiftFormula(formula, {dr, dc, sheetNames})` over
  `getTokens` (wasm, `initSync` in Node); `sort.ts` (copy-semantics sort,
  merges refused, styles carried); `filter.ts` (the model, criteria
  evaluation, hidden-row delta, structural remap); `find.ts` (find,
  replace, workbook scope) — `storage-and-concurrency.md` §"Sort, filter,
  find and replace".
- `projection.ts` — text projection for `KnowledgePageVersion.body`.
- `rebase.ts` — `shiftIntent(intent, foreignSummaries)` for the browser's
  intent replay (`realtime-and-presence.md` rule 4).
- `csv.ts` — CSV export from formatted values; import delegates to
  `pasteCsvString`.
- `node.ts` (separate `exports` entry) — `loadNodeModel(bytes)`,
  `importXlsx(stream)`, `exportXlsx(model)`, warnings derivation from the
  source package's part list (`[Content_Types].xml` names charts, drawings,
  pivot caches).

Tests (`node --test`, no DB, real `@ironcalc/nodejs` and `@ironcalc/wasm`):
every module; `formula-shift` fixtures (300 formulas × 12 displacements)
asserted equal to wasm `copyToClipboard` + `pasteFromClipboard(…, false)`;
sort fixtures with formulas, absolutes, cross-sheet refs, merges refused,
header kept; filter criteria matrix and remap under every structural
kind; find/replace scope and formula-tokenise refusal; a
1 000-case seeded loop for `rebase.ts` (apply foreign structural batch then
shifted intent ≡ apply intent then foreign, for cell intents); read caps;
sort with styles and a formula (documented text-move behaviour asserted);
projection byte-stability; `engine-pair.test.ts` from Phase 0 kept here.

Acceptance: `pnpm exec turbo run test --filter=@nessie/spreadsheet` green;
`readRange` of 10 000 cells under 50 ms on the dev machine (logged, soft).

### Phase 2 — Persistence, API, live lane

Owns: `packages/knowledge/src/spreadsheet/**` (`create.ts`, `bootstrap.ts`,
`apply.ts`, `model-cache.ts`, `snapshot.ts`, `restore.ts`, `reads.ts`,
`writes.ts`, `filters.ts` (head model + remap), `import.ts`, `export.ts`,
`presence.ts`, `engine-migrate.ts`, `errors.ts`), `packages/knowledge/src/types.ts` (`'spreadsheet'`),
`packages/knowledge/src/native-version-writer.ts` (refuse `body` for the
kind; kind-aware restore), `packages/knowledge/test/spreadsheet-*.test.ts`,
`api/src/routes/knowledge-spreadsheets.ts`, `knowledge-spreadsheets-io.ts`,
`knowledge-spreadsheet-live.ts`, `api/src/routes/types.ts`
(`teamHostBaseDomain` on `RouteDeps`), `api/src/register-api-routes.ts`,
`api/src/realtime/document-lane.ts`, the two seams in
`notification-delivery.ts` and `hub.ts`, `delivery-entitlements.ts`,
`packages/runtime/src/realtime-publish.ts` and `realtime.ts`,
`packages/schemas/src/governance.ts` (`kb.spreadsheet.batch_applied`,
`.snapshot`, `.imported`, `.restored`, `.engine_migrated`),
`api/src/routes/knowledge-base.ts` restore branch,
`api/test/spreadsheet-*.test.ts`, `worker/src/control/spreadsheet-compact.ts`
(the queued compaction job; sweeps are Phase 5).

Phase 2 codes writes against the Phase 0 interface with
`createUnimplementedModel()` only where Phase 1's helpers are needed
(sort/filter/projection/xlsx warnings); everything on the write door itself
uses the real `@ironcalc/nodejs` directly, so its DB tests are real from day
one.

Routes (all under `/api/knowledge-base`):

| Method | Path | Service |
|---|---|---|
| POST | `/spaces/:spaceId/spreadsheets` | `createSpreadsheetPage` |
| POST | `/spaces/:spaceId/spreadsheets/import` | `stageSpreadsheetImport` → `spreadsheet.import` (**202**; the API never parses a workbook) |
| POST | `/pages/:pageId/convert-to-spreadsheet` | `stageFileConversion` → `spreadsheet.import` (**202**) |
| GET | `/pages/:pageId/spreadsheet` | `bootstrapSpreadsheet` |
| GET | `/pages/:pageId/spreadsheet/ops?afterSeq&limit` | `listSpreadsheetBatches` |
| POST | `/pages/:pageId/spreadsheet/ops` | `applySpreadsheetBatch` (browser) |
| POST | `/pages/:pageId/spreadsheet/structure` | `restructureSpreadsheet` (rows/cols/merges/freeze/sort for the pane) |
| GET / PUT / DELETE | `/pages/:pageId/spreadsheet/filters/:sheet` | filter model get / set+apply / clear; POST `…/reapply` |
| POST | `/pages/:pageId/spreadsheet/replace` | `replaceInSpreadsheet` |
| GET | `/pages/:pageId/versions` | the existing versions route, unchanged — a spreadsheet's history is the same list, and a second path for it would be a second thing to keep in step |
| GET | `/pages/:pageId/spreadsheet/range?sheet&a1&values` | `readSpreadsheetRange` |
| GET | `/pages/:pageId/spreadsheet/find?q&sheet&limit` | `findInSpreadsheet` |
| POST | `/pages/:pageId/spreadsheet/versions` | `createSpreadsheetSnapshot` (named) |
| GET | `/pages/:pageId/spreadsheet/export?format&sheet&versionId` | `exportSpreadsheet` |
| POST / DELETE | `/pages/:pageId/presence` | `publishPresence` / leave |
| GET | `/pages/:pageId/live?clientId=` | the SSE lane |

Tests (DB-backed, `DATABASE_URL` gated, seed-scoped cleanup, no global
counts):

- `spreadsheet-apply.test.ts`: create → bootstrap → apply browser batch
  (bytes produced by a second `UserModel` in the test) → seq contiguous;
  idempotent replay; structural conflict 409 with `since`; non-structural
  staleness accepted; `revision` bumps; audit row metadata; engine error →
  400 and cache evicted; hot snapshot refreshed every 25 batches.
- `spreadsheet-concurrency.test.ts`: two simulated clients (two
  `UserModel`s) submit 200 batches each via `Promise.all`; assert `seq` is
  1..400 with no gaps or duplicates, and that a fresh `UserModel` built from
  the hot snapshot + journal has `toBytes()` equal to a model that applied
  the journal from zero — and equal to each client after both catch up.
  Repeat with a structural batch injected; assert the crossing client's
  batch was refused and the intent-replay path (using `rebase.ts` when Phase
  1 lands; a hand-shifted intent until then) converges.
- `spreadsheet-cache.test.ts`: two service instances (two "replicas") over
  one database: a batch applied through A is visible to a read through B
  after fast-forward; eviction on idle and by bytes.
- `spreadsheet-snapshot.test.ts`: compaction cadence; version rows carry the
  xlsx attachment, `body` projection, `sourceContentHash`; `.icalc` page
  attachment; chunks + embed job; restore appends a `restore` batch and
  refreshes the hot snapshot; `purgeKnowledgePageFiles` removes both blobs.
- `spreadsheet-summary-advisory.test.ts`: a lying summary from a reader is
  refused by access before the summary is read; from a writer it changes
  nothing about reach; a false `structuralKind: null` costs the next
  crossing client one rebase and nothing else (owner decision 2).
- `spreadsheet-filters.test.ts`: set/apply hides the right rows and only
  those; manual hides survive clear; remap under insert/delete/move rows,
  columns and sheets; stale model dropped with audit; import seeds from a
  table's autofilter range.
- `spreadsheet-versions.test.ts`: automatic snapshots fire before every
  destructive kind and at an agent run's first write; restore snapshots
  first; the list carries author/agent/comment.
- `spreadsheet-engine-migrate.test.ts`: a head stamped with a foreign
  `engineVersion` refuses writes with 409, migrates from xlsx, then accepts.
- `spreadsheet-live.test.ts`: real `createRealtimeHub` + recorder sink;
  document connection receives `sheet.ops` for its page only; revoked reader
  stops within the window; an oversized batch arrives with `diffs: null`; a
  previous-build fan-out double does not throw on the `document` envelope.
- `spreadsheet-routes.test.ts`: permissions matrix; CORS header present for
  a tenant-host origin on the live route.
- `spreadsheet-io.test.ts`: import creates page + snapshot + attachment with
  warnings; export round-trips; convert keeps the file node; `.xls` refused.

Acceptance: all green through Turbo; `api/src/realtime/*` ≤ 500 lines each;
`docs/knowledge-base-requirements.md` gains a §9e stub line.

### Phase 3a — UI shell

Owns: `admin/src/components/features/knowledge/spreadsheet/**` except
`live/**`, `admin/src/facades/knowledge/spreadsheet-hooks.ts`,
`admin/src/lib/query-keys.ts` (keys), `knowledge-workspace-actions.ts`, the
kind-switch sites in `admin-ui.md`, `TaskDocuments.tsx`,
`FileNodeViewer.tsx` ("Open as spreadsheet"), `admin/test/spreadsheet-*.test.ts`.

Until Phase 2 lands, 3a codes against `SpreadsheetBootstrapSchema` with the
no-DB Vite harness and a stubbed api client (a fixture bootstrap built from
a `UserModel.toBytes()` checked in as a small `.icalc`).

Deliverables: create/import/convert doorways; pane with action bar;
`WorkbookHost` + model bridge (intent recording, flush callback, selection
frames — consumed by 3b); theme mapping; presence strip (fed by a `peers`
prop); history with first-class Restore and the pre-destructive "Saved a
version — Restore" notice; export; sort dialog, column-header filter
buttons + popover + chips bar, find/replace popover; phone layout.

Tests: `admin/test/spreadsheet-pane.test.tsx` renders the pane under jsdom
with the wasm initialised from the package (jsdom lacks canvas — mock
`HTMLCanvasElement.getContext` as IronCalc's own Storybook/vitest setup
does) and asserts actions and the bridge's intent log; navigation surface
tests unchanged; a Playwright run against the stub harness captures
`create.png`, `theme-*.png`, `phone.png`.

Acceptance: chunk and wasm proven lazy; `react-hooks` lint clean;
screenshots 1, 2, 7.

## Wave B (two agents, from the integrated wave A)

### Phase 3b — Live UI

Owns: `admin/src/components/features/knowledge/spreadsheet/live/**`
(`PresenceOverlay.tsx`, `useDraftObserver.ts`, `SpreadsheetConflictNotice.tsx`),
`admin/src/facades/knowledge/spreadsheet-live.ts`, `admin/e2e/spreadsheets/**`
(`run.mjs`, `cases/*.mjs`, screenshots), `admin/package.json`
(`test:e2e:spreadsheets`).

Deliverables: the ordering rules in `realtime-and-presence.md` including
intent replay; presence sender/receiver; overlay; draft observer; offline
queue; `peers` into the strip; **touch range selection and corner handles**
in the overlay (`admin-ui.md` §"Phone"), gated by Spike D's outcome.

Tests: `admin/test/spreadsheet-live.test.ts` (pure: gap buffering, echo
skip, rebase path with recorded intents, expiry); the e2e suite boots API and
admin on the fixed ports through `admin/e2e/navigation/lib/servers.mjs`
(scratch ports via `NAV_E2E_*` when 5454/5455 are taken), bootstraps an
owner, creates two users, captures screenshots 3, 5, 6, 8 (phone touch: `hasTouch` context, long-press
drag selects B2:C4, handles visible); `two-browsers`
asserts the draft text is visible in B before A presses Enter and the
committed value after; `structural-rebase` asserts B's edit moved down one
row and no notice appeared.

Acceptance: e2e green locally headless on `http://localhost:5455`; the
`ci.mjs` entry prepared for Phase 5.

### Phase 4 — Agent tools

Owns: `packages/runtime/src/builtin-sheet-tools.ts`,
`packages/runtime/src/builtin-tools.ts` (one spread line),
`packages/runtime/test/builtin-sheet-tools.test.ts`,
`worker/src/run/sheet-tool-dispatch.ts`, `worker/src/run/tools.ts` (one
hook), `worker/src/run/pa-tools/spreadsheet-*.ts`,
`worker/src/run/execute/agent-documents.ts`, `api/src/mcp/tools/spreadsheets.ts`,
`api/src/mcp/server.ts` (one spread), `api/src/mcp/tool-context.ts`
(`spreadsheet` handle), `packages/schemas/src/team-records.ts`
(`fallbackAgentBackgroundColor`) and `admin/src/components/shared/AgentAvatar.tsx`
(import it), `worker/test/db/spreadsheet-*.test.ts`,
`api/test/mcp-spreadsheet-tools.test.ts`, `packages/mock-llm` scenario
`spreadsheet-agent-edit`, `docs/standards/tool-categories.md` (one row),
`admin/e2e/spreadsheets/cases/agent-presence.mjs` (the one shared path in
wave B, coordinated by the orchestrator).

Deliverables and tests: `agent-tools.md`. Worker DB suite runs with
`--test-concurrency=1` under `test/db`.

Acceptance: worker and MCP suites green; the mock-LLM scenario runs end to
end; screenshot 4 captured.

## Wave C — Phase 5 — Hardening, sweeps, docs, CI (one agent)

Owns: `worker/src/control/spreadsheet-sweeps.ts` (idle compaction,
batch prune, engine-migrate driver; `withSweepLock`, bounded batches,
per-row error isolation), `worker/src/worker-subscriptions-core.ts`,
`worker/test/db/spreadsheet-sweeps.test.ts`, the multi-instance smoke case
(a batch applied on instance A delivered on a document stream held by B;
presence request/re-announce across instances; a cache fast-forward across
instances), `docs/standards/spreadsheets.md` (one write door and the lock;
seq/LWW/structural refusal/intent replay; pause-around-apply; inert envelope
and the date it may be flattened; engine pinning and the upgrade procedure;
compaction cadence and index staleness; presence is stateless; the one patch
and the DOM reach-in; sort/filter honesty), `AGENTS.md` (one routing
sentence), `CLAUDE.md` (the e2e line), `docs/knowledge-base-requirements.md`
§9e, `.github/workflows/ci.yml` (step "Run spreadsheets browser suite" +
artifact upload), `docs/plans/…/overview.md` status line.

Optional items if wave B landed clean: `summarize_diffs` adoption once
upstream ships it (removes the client-reported summary); delegating
`formula-shift` to `extend_to` once exposed; conditional-format and
named-range tools; the one-sentence `paired-agents.md` note on the MCP
endpoint's CORS.

Acceptance: all ten CI jobs green on the integration branch; multi-instance
case green; `pnpm lint` green; the standards file exists and `AGENTS.md`
routes to it; the final PR lists every requirement in this plan with where
it landed and names anything deferred with the owner's decision beside it.

## Integration checklist (orchestrator, per wave)

1. Merge each branch into the integration branch; resolve only in the shared
   seams; re-run the affected package tests.
2. Replace any `createUnimplementedModel()` use with Phase 1's helpers at the
   end of wave A; re-run Phase 2's suites.
3. Whole-repo `pnpm lint && pnpm typecheck && DATABASE_URL=… pnpm test`
   (Turbo, `--no-daemon` while agents run elsewhere).
4. Run the spreadsheets e2e headless on :5455 and look at the screenshots.
5. Audit the brief: each numbered goal in `overview.md` §Goal maps to a
   landed change or a written deferral.
