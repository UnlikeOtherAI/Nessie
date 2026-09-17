# Agent tool surface

Two stacks exist and both get the same twelve tools, implemented once:

- **Builtin tools** (Nessie's own agents, worker): definitions in
  `packages/runtime/src/builtin-sheet-tools.ts` (JSON-schema `parameters`,
  `category: 'spreadsheets'`), handlers in
  `worker/src/run/pa-tools/spreadsheet-*.ts`, dispatched from
  `worker/src/run/sheet-tool-dispatch.ts` mirroring `kb-tool-dispatch.ts`,
  registered by one spread in `BUILTIN_TOOL_DEFINITIONS`.
- **Nessie MCP server** (paired agents, `POST /mcp`): `api/src/mcp/tools/spreadsheets.ts`
  exporting `spreadsheetTools()` added to `nessieMcpTools()`; raw zod
  `inputSchema`; scopes `documents_read` / `documents_write` (no new
  `AgentAccessScope` — a spreadsheet is a document).

Both call the same service functions in `packages/knowledge/src/spreadsheet/`
(`describeSpreadsheet`, `readSpreadsheetRange`, `findInSpreadsheet`,
`replaceInSpreadsheet`, `writeSpreadsheetRange`, `formatSpreadsheetRange`,
`restructureSpreadsheet`, `setSpreadsheetFilter`, `manageSpreadsheetTabs`,
`createSpreadsheetPage`, `exportSpreadsheet`, `listSpreadsheetVersions`,
`createSpreadsheetSnapshot`, `restoreSpreadsheetVersion`). Every write builds
its batch **on the server's cached model at head, under the page lock**: the
service calls the `@ironcalc/nodejs` `UserModel` mutators inside
`pauseEvaluation()`, runs `evaluate()`, `flushSendQueue()`s, and hands the
bytes plus an exact summary to `applySpreadsheetBatch`. Server batches
therefore never hit a structural conflict and never carry a client-reported
summary.

## Why a new category

`TOOL_CATEGORIES` is a closed vocabulary and `builtin-tool-categories.test.ts`
fails any category holding more than a quarter of the catalogue. `knowledge`
already has 13 builtin ids; adding twelve would break the cap and, more to
the point, a person choosing tools thinks "can it work in spreadsheets?" as
one question. Phase 0 adds `{ id: 'spreadsheets', label: 'Spreadsheets',
description: 'Read and edit spreadsheet documents in the knowledge base.' }`,
**not** in `EFFECTFUL_TOOL_CATEGORY_IDS` (the journal is the ledger).

## Design rules

- **Ranges are A1, sheets are names.** `sheet: 'Q3 Forecast'`, `range:
  'B2:D40'` (or `'B2'`, `'B:B'`, `'3:3'`). The service resolves the name to
  IronCalc's sheet index case-insensitively and translates A1 to 1-based
  row/column; results echo canonical names.
- **Batch-first.** One call writes a 2-D block; one call restructures.
- **Idempotent.** `clientOpId = context.toolCallId` (builtin) or a
  caller-supplied `requestId` (MCP; defaulted to a uuid — a paired agent that
  retries without one double-applies, and the description says so).
- **Capped.** Reads refuse more than `maxCellsPerRead` (10 000) with the
  count and a suggested split; writes refuse more than `maxCellsPerWrite`.
  Worker results pass `truncateToolResult` (32 000 chars); the MCP server
  applies the same read cap at the service.
- **Values, not JSON soup.** `values: 'display'` (default,
  `getFormattedCellValue`), `'raw'` (`getCellContent` — the formula text
  for formula cells, the literal otherwise), `'formula'` (formula text or
  null). Reads return `{ sheet, range, rows: (string|number|boolean|null)[][],
  truncated }`; CSV on `format: 'csv'`.
- **Every write is `safe: false`. No approval gate; versioning is the
  safety net** (owner decision 3): every destructive write snapshots a named
  version first and returns its id, and `sheet_versions` makes restore a
  first-class move.
- **Attribution** rides the batch row (`actorType: 'agent'`, `agentId`,
  `runId`; MCP: `actorType: 'user'`, `agentCredentialId`) and the audit row
  the write door emits; `emitAuditEvent`'s `via: 'mcp_agent_credential'`
  stamp applies for MCP. Snapshot versions carry `authorType/authorId`
  (`resolveAuthor`).
- **Disclosure.** Every read handler calls `recordKnowledgeSpaceRead` and
  `recordKnowledgeVersionRead(latest snapshot)` on
  `context.consumedSources` before returning. Writes run through
  `createWorkerKnowledgeProvider` so snapshot versions carry the run's basis.
- **Space rules** are the kb rules: `resolveKnowledgeAccessViewers`,
  `canReadSpace`/`canWriteSpace`, agents refused on `restricted` tier and on
  another agent's `privateToAgentId`.
- **One engine.** Formulas an agent writes are evaluated by the same engine
  the browser runs, so a value the agent reads back is the value the person
  sees.

## The twelve tools

Builtin id → MCP name. Parameters are JSON-schema fields (`*` required).

### 1. `sheet_describe` → `nessie_sheet_describe` (safe)

`pageId*`. `{ title, sheets: [{ name, usedRange: 'A1:F120', rows, columns,
frozenRows, frozenColumns, hidden, merges: n, filter: FilterModel | null }],
headSeq, lastEditedAt, lastEditedBy, versions: n, latestVersion: { id,
comment, at }, definedNames: [{ name, scope, formula }] }`. No cells. The
first call an agent makes.

### 2. `sheet_read_range` → `nessie_sheet_read_range` (safe)

`pageId*`, `sheet` (default first visible), `range` (default used range),
`values: display|raw|formula`, `format: rows|csv`, `includeStyles` (adds a
parallel `styles` matrix `{bold, italic, fontColor, background, numberFormat}`),
`includeHidden` (default false: rows a filter hides are omitted and the
result says how many). Refuses > 10 000 cells with `{ error, cells,
suggestion }`.

### 3. `sheet_find` → `nessie_sheet_find` (safe)

`pageId*`, `query*`, `scope: sheet|workbook|range` (default workbook),
`sheet`, `range`, `matchCase`, `wholeCell`, `regex`, `inFormulas`, `limit`
(≤ 200). Returns `[{ sheet, cell: 'C14', value, formula? }]` plus `total`.

### 4. `sheet_replace` → `nessie_sheet_replace`

The find parameters plus `replacement*`, `all: bool` (default false: only
the first match; the result lists the rest so the agent can confirm before
`all`). Replace-all over the threshold snapshots first. Formula replacements
that fail to tokenise are refused per cell and reported; nothing lands
partially.

### 5. `sheet_write_range` → `nessie_sheet_write_range`

`pageId*`, `sheet*`, `range*` (anchor `'B2'` or a full range matching the
block), `rows*`, `mode: overwrite|insertRowsBelow`, `parseValues` (default
true: strings starting with `=` are formulas, numbers and ISO dates parse;
false forces text). `setUserInput` per cell inside one paused batch; `null`
clears. Result `{ seq, written, warnings }` plus, when the block is
≤ 400 cells, the formatted values read back.

### 6. `sheet_format_range` → `nessie_sheet_format_range`

`pageId*`, `sheet*`, `range*`, `style*: { bold?, italic?, underline?,
strike?, fontColor?, background?, fontSize?, hAlign?, vAlign?, wrap?,
numberFormat?, borders?: none|all|outer, namedStyle? }`, `clear`.

### 7. `sheet_structure` → `nessie_sheet_structure`

`pageId*`, `sheet*`, `action*: insertRows|insertColumns|deleteRows|deleteColumns|moveRows|moveColumns|hide|show|resize|merge|unmerge|freeze|unfreeze|sort|clear`,
`range`, `count`, `delta`, `size`, `sort: { by: ['C', '-D'], hasHeader }`.
**Sort has full fidelity:** rows move with their styles and formulas keep
their meaning under Excel/Sheets copy semantics (relative references shift
with the row, absolute ones stay — `storage-and-concurrency.md` §"Sort").
Merged cells in the range refuse the sort and are named. Destructive
threshold: `deleteRows`/`deleteColumns` over 100 rows/columns, `clear` or
`sort` over 1 000 cells → snapshot `before: <action>` first; the result
names the version.

### 8. `sheet_filter` → `nessie_sheet_filter`

`pageId*`, `sheet*`, `action*: get|set|clear|reapply`, `range` (set: the
table incl. header row; default the used range), `columns` (set:
`{ 'C': { values: ['open', 'blocked'] } , 'D': { op: 'gt', value: 10 } }`),
`sort` (set: `{ by: 'C', direction: 'asc' }`). `get` returns the persisted
model and the hidden-row count; `set` replaces the sheet's model and applies
it; `reapply` re-evaluates after data changed; `clear` unhides what the
filter hid. Reads through `sheet_read_range` honour the filter unless
`includeHidden`.

### 9. `sheet_tabs` → `nessie_sheet_tabs`

`pageId*`, `action*: add|rename|delete|duplicate|move|hide|unhide|setColor`,
`name`, `newName`, `position`, `color`. `delete` snapshots first and refuses
the last visible sheet.

### 10. `sheet_create` → `nessie_sheet_create`

`spaceId*`, `title*`, `parentPageId`, `taskId`, `sheets: [{ name, rows? }]`
(≤ 10 000 cells total), `fromAttachmentId` (an `.xlsx`/`.csv` message
attachment → `UserModel.fromXlsx` / `pasteCsvString`). Returns `{ pageId,
title, url, sheets, warnings }`. The system-prompt documents block gains one
line naming this tool beside `kb_document_compose`.

### 11. `sheet_export` → `nessie_sheet_export`

`pageId*`, `format*: xlsx|csv`, `sheet` (csv only), `versionId`, `postTo:
{ channelId?, threadId? }` (builtin only: `FileService.store` with the run's
attribution, linked to a new message via `thread-message-create`). MCP
returns `{ attachmentId, downloadUrl }`.

### 12. `sheet_versions` → `nessie_sheet_versions`

`pageId*`, `action*: list|save|restore`, `comment` (save), `versionId`
(restore), `limit`. `list` returns `[{ id, number, at, author: { type,
name }, comment, agent?: name }]` newest first; `save` names a snapshot;
`restore` snapshots the current state (`before: restore to v12`) and then
restores — the same door the pane's Restore uses, so an agent can undo its
own or anyone's damage and say which version it went back to.

**Deliberately absent in v1:** comments/notes on cells (page-level
annotations still work), images, charts, pivot tables, data validation,
conditional-formatting authoring and named-range authoring (the engine has
both; tools are Phase 5 candidates).

## Agent presence

An agent editing must look like a person editing. The worker handlers
publish presence frames through `publishDocumentEphemeral` with the agent
actor; `planAgentPresence(batchPlan)` is a pure function with its own test:

1. On any tool call touching a page: `sheet.presence` with the sheet index
   and the target `selection` (range about to be read or written), cursor at
   its top-left. Reads count — a person sees "the agent is looking at
   B2:D40".
2. `sheet_write_range` on ≤ 20 cells: one frame per cell with `draft: { r,
   c, text }` (the value about to land), 120 ms apart, capped at 2.5 s
   total; then the batch. Bounded and honest; a 5 000-cell write does not
   stall the run.
3. After the ack: a frame with `selection` on the written range and `draft:
   null`; `sheet.presence.leave` for the agent `clientId = runId:pageId`
   when the run ends or after 60 s of no further sheet tools (a `runContext`
   timer, not a process global).
4. Colour and name come from the agent record; the admin renders the same
   `IdentityTile` it uses elsewhere.
5. The first write of a run to a page takes the automatic `before: <agent>
   started editing` version (`storage-and-concurrency.md` §"Version history
   is the safety net"), and the tool card in chat links it.

## Prompt block and eligibility

- `worker/src/run/execute/agent-documents.ts` `hasDocumentsPromptTools`
  gains an "or `sheet_create` + `sheet_read_range` + `sheet_write_range`"
  arm; the block adds "Spreadsheets: create with `sheet_create` in the same
  home; describe, then read, before you write; A1 ranges, sheet names; a
  version is saved before anything destructive and `sheet_versions restore`
  undoes it".
- Eligibility follows the existing registry/grant gate.

## Failure shapes

| Condition | Result |
|---|---|
| Page not a spreadsheet | `{ error: 'Not a spreadsheet document' }` |
| Unknown sheet | `{ error, sheets: [names] }` |
| Range > cap | `{ error, cells, cap, suggestion }` |
| Engine refused (delete last sheet, invalid formula) | `{ error, cell?, reason }` — the engine's message, verbatim |
| Sort over merged cells | `{ error, merges: ['B2:C3'] }` |
| Engine version migrating | `{ error: 'This spreadsheet is being upgraded; retry shortly', retryable: true }` |
| Restricted tier / private to another agent | the kb tools' `PAGE_UNREACHABLE` sentence |
| Import warnings | `{ ok, warnings: ['Charts are not imported', …] }` |

## Tests (Phase 4)

- `worker/test/db/spreadsheet-tools.test.ts` (DB-backed, gated on
  `DATABASE_URL`): each tool against a seeded page; read caps; A1 parsing;
  a formula written then read back evaluated; `insertRowsBelow`; sort with
  styles and a formula whose relative reference moved with its row; filter
  set/get/reapply/clear and a filtered read; replace with a formula
  refusal; destructive snapshot created and named; `sheet_versions restore`
  round-trips; idempotent replay by `toolCallId` returns the same `seq`;
  disclosure sink fed on reads; agent refused on restricted tier; presence
  frames observed on a recorder transport in order.
- `api/test/mcp-spreadsheet-tools.test.ts`: MCP mirror through
  `buildNessieMcpServer` with a credential fixture: scope refusal, `via`
  audit stamp, `requestId` idempotency, read-only credential cannot write.
- Mock-LLM scenario `spreadsheet-agent-edit`: a scripted run calls
  `sheet_describe`, `sheet_read_range`, `sheet_write_range`, then
  `sheet_versions restore`; the browser asserts the agent's presence range
  and draft render before the values change and that the restore shows in
  History (screenshot 4 in `admin-ui.md`).
