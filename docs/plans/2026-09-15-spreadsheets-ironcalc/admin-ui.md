# Admin UI, navigation, theme, phone

## Rule zero — home and doorways

| | Where |
|---|---|
| **Home** | The knowledge workspace pane: `KnowledgeDocumentPane` renders `SpreadsheetPane` when `page.kind === 'spreadsheet'`. Reached through every existing knowledge doorway: `/knowledge-base` (My Docs, spaces), `/knowledge-base/spaces/:spaceId?pageId=` (deep link via `KNOWLEDGE_INTENT`), project Docs tab, agent Documents tab, ticket documents. **No new route, no new surface row.** |
| **Create** | Two entries in the Finder's `new-file-types.ts` registry — `spreadsheet` ("Spreadsheet") and `spreadsheet-import` ("Spreadsheet from a file…") — which the toolbar's **New** menu and a folder column's background menu both read, so each appears in both. `TaskDocuments.tsx` keeps its own "New spreadsheet" beside "New note". An `.xlsx`/`.csv`/`.tsv` file row offers **Open as spreadsheet** in its right-click menu and in `FileNodeViewer`'s header; an `.xls` is offered **disabled with its reason** rather than omitted. |
| **Find** | Finder rows take their glyph from the `spreadsheet` **file family** (`file-icons.ts`), which is its own family beside `excel`: an uploaded `.xlsx` is a file you download, this is a workbook you edit. `kb_search` results carry `kind` and open the page. |
| **In chat** | `DocumentRefChip` already links any page; agent tool cards for `sheet_*` link to the page with the range in the label ("wrote B2:D40 in *Q3 Forecast*"). |
| **Presence** | The avatar strip in the pane header (`IdentityTile`s with the actor colour ring) is the home; the overlay is the in-context doorway. |
| **History / Restore** | Existing `VersionHistory.tsx` via the pane's "History" action, extended for the kind: author with an `agent` badge, comment, **Restore this version** (confirmed, snapshots first), "Download" serves the xlsx. Restore is also reached from the transient "Saved a version before <action> — Restore" notice the pane shows after every automatic pre-destructive snapshot, and from agent tool cards in chat ("Restore the version from before this"). |
| **Sort / filter / find** | Our action bar (Sort…, Filter, Find & replace) plus filter buttons drawn on column headers of a filtered range and a chips bar naming active criteria — the same server implementation the tools use. |

Copy says **spreadsheet** for the document and **sheet** for a tab.

## Embedding IronCalc (Phase 3a)

- Dependencies (pinned exact, Phase 0): `@ironcalc/workbook`, `@ironcalc/wasm`
  (the version `SPREADSHEET_ENGINE_VERSION` names), plus its peers
  `i18next`, `react-i18next`, `lucide-react`. The workbook uses its own
  `i18n.createInstance()`, so nothing else in the admin changes.
- Loading: `SpreadsheetPane` is `lazy()`-imported from `KnowledgeDocumentPane`,
  and the chunk calls `init(wasmUrl)` once (`import wasmUrl from
  '@ironcalc/wasm/wasm_bg.wasm?url'`) — the 1.9 MB wasm and the workbook
  JS/CSS load only when a spreadsheet opens (acceptance: absent from the
  network log on `/knowledge-base` until then). Same-origin, so the CSP and
  the Tauri allowlist need nothing.
- Model creation: `Model.fromBytes(snapshot, lang)` from the bootstrap, then
  the batches since (paused, one `evaluate()`), then `<IronCalc model
  themeVariables rootContainer={paneEl} canEdit={viewer.canWrite &&
  !engineMigrating} ref={handle}>`.
- **Theme:** `themeVariables` maps the admin's `styles.css` tokens onto
  IronCalc's `--palette-*` / `--typography-*` variables
  (`spreadsheet-theme.ts`, a pure mapping tested against the token list);
  dark mode passes `darkThemeVariables` merged with the same mapping. The
  grid canvas follows because IronCalc draws from the model theme and these
  variables — no CSS override file is needed.
- **The one patch:** `pnpm patch @ironcalc/workbook` adds `redraw()` to
  `IronCalcHandle` (lift `setRedrawId` from `Workbook.tsx` into a ref the
  root exposes; ≈ 20 lines on `dist/ironcalc.js` + `index.d.ts`). Without
  it, a remote batch applied to the model is not painted until the person
  acts. Phase 0 files the upstream PR (`redraw` + `onModelChange`) and
  records the patch in `patches/`.
- **Method shadowing, not a fork** (`spreadsheet-model-bridge.ts`): after
  creating the `Model`, define own-property wrappers on the instance for
  every mutating method (the list is generated from `Model.prototype` at
  Phase 0 and checked in as a constant with a test that fails when the
  installed version adds one): each wrapper calls the prototype method,
  records a `SpreadsheetIntent` (method + args), and schedules a microtask
  that `flushSendQueue()`s into the sync layer. Selection methods
  (`setSelectedCell/Range/Sheet`, `onArrow*`, `onPage*`,
  `onExpandSelectedRange`, `onAreaSelecting`) additionally emit a presence
  frame from `getSelectedView()`. `undo`/`redo` are wrapped the same way
  (their diffs go to the queue like any other). Because wrappers are own
  properties on the real instance, `this.__wbg_ptr` is untouched.
- **Draft observer** (`useDraftObserver.ts`): a delegated `input` listener on
  the pane container for `.ic-worksheet-editor-wrapper textarea`, reading
  `textarea.value` and `getSelectedView()` → `draft` frames; cleared on
  `blur`, Enter/Escape (keydown), or when the editor unmounts. The formula
  bar (`.ic-formula-bar` input) is observed the same way. The one DOM
  reach-in, isolated here.
- Toolbar items IronCalc lacks (sort, filter, find & replace, history,
  export, save version, fullscreen) live in **our** action bar above the
  widget (`SpreadsheetActionBar.tsx`), built from the design-system
  primitives; IronCalc's own toolbar keeps formatting. The pane never
  re-implements a control IronCalc has.
- **Filter UI:** when a sheet has a filter model, `FilterHeaderButtons.tsx`
  draws a small funnel button over each column header of the range
  (positioned by the same `cellRect` geometry the presence overlay uses;
  IronCalc's canvas is untouched) opening `FilterPopover.tsx` — value
  checklist with search and "select all", or a condition — and
  `FilterChipsBar.tsx` under the action bar names each active criterion
  with a clear-one and clear-all; `Re-apply` sits there too. Sort goes
  through `SpreadsheetSortDialog.tsx` (columns, direction, header row) and
  refuses merges by naming them.
- **Find & replace:** `FindReplacePopover.tsx` (Ctrl/Cmd-F) searches the
  client model as you type (workbook / sheet / selection scope, match case,
  whole cell, regex, in formulas), steps through matches by moving the
  selection, and `Replace` / `Replace all` post to the replace route so the
  change lands in the journal; refusals come back per cell.

## Components (Phase 3a unless marked 3b)

Under `admin/src/components/features/knowledge/spreadsheet/`:

- `SpreadsheetPane.tsx` — pane body: `SpreadsheetActionBar`, `PresenceStrip`,
  the widget host filling the remaining height, offline / engine-migrating /
  error notices.
- `WorkbookHost.tsx` — creates the model from the bootstrap, applies the
  bridge, renders `<IronCalc>`, exposes `{ model, handle }` to the live layer.
- `spreadsheet-theme.ts` — token mapping (light + dark).
- `PresenceStrip.tsx` — one `IdentityTile` per peer (users via the users
  directory, agents via `useAgentIdentityLookup()`; frames carry
  `displayName`/`color` for anything unresolvable), ring in the presence
  colour, tooltip "on *Sheet2*, B4", "+N".
- `PresenceOverlay.tsx` (3b) — absolutely positioned layer over
  `.ic-worksheet-sheet-container`; `cellRect(sheetView, r, c)` from
  `getColumnWidth`/`getRowHeight` sums, frozen counts, `top_row/left_column`
  from `getSelectedView()`, the scroll element's `scrollLeft/Top`, and the
  `headerRowHeight`/`headerColumnWidth` constants; redraws on scroll, resize,
  and every applied batch (widths change).
- `useDraftObserver.ts` (3b), `SpreadsheetConflictNotice.tsx` (3b).
- `SpreadsheetCreateDialog.tsx`, `SpreadsheetImportDialog.tsx` (reuses
  `FileVersionUploadDialog`'s drop/progress pieces; shows warnings),
  `SpreadsheetFindPopover.tsx` (client-side iteration of the model's used
  range), `SpreadsheetSortDialog.tsx` / `SpreadsheetFilterPopover.tsx`
  (call the REST `structure` endpoint — the same server implementation the
  tools use, so a person and an agent sort identically).

Facades (`admin/src/facades/knowledge/`):

- `spreadsheet-hooks.ts` — `useSpreadsheetBootstrap(pageId)` (key
  `knowledgeKeys.spreadsheet(pageId)`, `placeholderData` per the id-keyed
  rule), `useCreateSpreadsheet`, `useImportSpreadsheet`,
  `useConvertToSpreadsheet`, `useSaveSpreadsheetVersion`,
  `useExportSpreadsheet`, `useRestructureSpreadsheet`.
- `spreadsheet-live.ts` (3b) — `useSpreadsheetLive({ pageId, clientId,
  model, handle, canWrite })`: opens the lane with `readSseStream` +
  `runStreamConnectionLoop`, owns `appliedSeq`, pending map with intents,
  gap buffer, presence sender, peer map with expiry, rebase (rule 4);
  exposes `{ peers, status }`. The bridge's flush callback → `submitBatch`.
- The client imports `shiftIntent` and the A1 helpers from
  `@nessie/spreadsheet` (browser-safe entry; the Node-only module is a
  separate `exports` entry the admin never imports).

Navigation compliance: no new route; fullscreen is an overlay
(`useOverlay({ kind: 'Modal', id: 'spreadsheet-fullscreen' })`) that
re-parents the same host (one model, one widget); Back closes it through the
registered overlay. On `single` layout the pane is a stack layer like any
page pane.

## Kind switch sites

**Rewritten after the Documents Finder landed.** `KnowledgeWorkspace`'s
filesystem rows, its sidebar tree and `knowledge-workspace-actions.ts` are
gone; the sites below are the ones that exist. Each is exhaustive over
`KnowledgePageKind` on purpose, so the next kind is a compile error rather
than a row that reads as a document.

- `packages/schemas/src/knowledge.ts` — `KnowledgePageKindSchema`, the one
  spelling of the union. `packages/knowledge/src/types.ts` mirrors it for the
  server; `admin/src/facades/knowledge/hooks.ts` re-exports it.
- `KnowledgeDocumentPane.tsx` — which pane opens; the spreadsheet chunk is
  the lazy import here and nowhere else.
- `finder/finder-sort.ts` (`familyForRow`), `shared/file-icons.ts` (the
  `spreadsheet` family, its label, tone and glyph), `finder/FinderRow.tsx`
  (`data-finder-kind`), `finder/finder-menu-target.ts` (`menuKind`),
  `finder/finder-menu.ts` (`FinderMenuKind` and the row's items),
  `finder/GetInfoDialog.tsx` (Kind, Contains, Search),
  `finder/sharing-copy.ts` (`ShareSubjectKind`),
  `packages/knowledge/src/native-indexing-status.ts` (`spreadsheetState`),
  `packages/knowledge/src/native-page-info.ts` (`countsFor`).
- `PageEditor.tsx` refuses to edit the kind; `ProjectDocumentsSection.tsx`
  and `kanban/TaskDocuments.tsx` draw their own row icon.

## Phone and desktop

**Evidence** (`library-assessment.md` §"Touch"): in `usePointer.ts` any
non-mouse pointer skips range selection ("use touch move only to scroll for
now"), so on a phone a tap selects, a drag scrolls natively, double-tap
opens the `<textarea>` editor and the on-screen keyboard, and Enter commits
— verified on `app.ironcalc.com` at 375×812 where the toolbar collapses into
a scrollable strip with a "more" chevron and a typed value committed. There
are no selection handles, no `touch-action` rules, no pinch handling (the
browser's own pinch zoom works because the viewport meta allows it) and no
responsive CSS. Nothing about it is broken; one capability is missing.

**Verdict: phones get full editing** (owner decision 6). Nessie supplies
the missing piece from outside the library, in the same overlay that draws
presence:

- **Touch range selection:** `useTouchSelection.ts` (3b) listens for
  `pointerType === 'touch'` on the sheet container; a long-press (350 ms,
  haptic via the WebView bridge where available) enters selection mode,
  drag extends the range through `cellRect⁻¹` → `setSelectedRange`, release
  leaves it; a plain tap and a plain drag keep IronCalc's own behaviour.
- **Handles:** two corner handles on the selection rectangle (Sheets
  style) drawn by the overlay; dragging one resizes the range the same way.
- **Chrome:** our action bar collapses to icons under the `single`
  breakpoint; IronCalc's toolbar stays (it already scrolls) but the pane
  hides it below 480 px behind a "Format" toggle so the grid keeps the
  height; the formula bar and sheet tabs stay. The native header follows
  the shell contract (§10). `canEdit` stays on; the only view-only case is
  `viewer.canWrite === false`, never the device.
- **Upstream:** a PR adding touch range selection to `usePointer` is
  opened in Phase 0; when it lands our handler stands down.
- No native code changes; the WebView bridge is not touched.

**Desktop (Tauri)** loads `https://app.nessie.works/**`; the wasm is
same-origin.

## Verification (3a/3b acceptance, headless Playwright on :5455)

Screenshots into `admin/e2e/screenshots/spreadsheets/`:

1. `create.png` — the Finder's New menu → Spreadsheet → grid, IronCalc toolbar,
   formula bar, tabs and our action bar render; wasm + chunk appear in the
   network log only now.
2. `theme-dark.png` / `theme-light.png` — chrome and grid follow the org
   theme.
3. `two-browsers.png` — two contexts (two users): A selects B2:D5 and types
   "hello" without Enter; B's screenshot shows A's coloured range, name tag,
   and the ghosted draft in B2; after Enter, B shows the committed value.
4. `agent-presence.png` — mock-LLM run writes a range; the agent's tile and
   its range/draft show before the cells fill.
5. `structural-rebase.png` — A inserts a row above while B has a pending
   edit below; B's edit lands one row lower; no notice (nothing dropped).
6. `history.png` — Save version → History lists it → Download yields an
   xlsx that `UserModel.fromXlsx` re-reads with equal cell values (asserted
   in the script through the API's export).
7. `phone.png` — `NAV_E2E_VIEWPORT=phone`, `hasTouch` context: grid
   scrolls, double-tap + type + Enter commits, the action bar is collapsed.
8. `phone-selection.png` — long-press-drag selects B2:C4 with handles
   visible; a tap outside clears it.
9. `filter.png` — a filter on column C hides the non-matching rows, funnel
   buttons and chips show, `Re-apply` after an edit re-hides; sort dialog
   result shows a formula that moved with its row.
10. `restore.png` — after an agent's `deleteRows`, the pane's "Saved a
   version — Restore" notice, History with the `agent` badge, and a restore
   bringing the rows back.
