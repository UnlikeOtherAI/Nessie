# Phase 3a — the admin UI shell, as built

What landed on `agent/sheets-ui`, and the places it departs from
[admin-ui.md](admin-ui.md). Every departure below was forced by something
measured, and says what.

Measured 2026-09-16 against `@ironcalc/workbook` 0.8.3 + `@ironcalc/wasm`
0.8.4, React 19.2, Vite 7.3.

## Evidence

| Screenshot | What it shows |
|---|---|
| [`phase-3a/create.png`](phase-3a/create.png) | The grid in the default theme: our action bar, the chips bar, funnel buttons on A/B/C, the pre-destructive “Saved a version before delete rows 2-4 — Restore” notice, IronCalc's toolbar, formula bar and sheet tabs, `B6 = 445` from `=SUM(B2:B5)`. |
| [`phase-3a/theme-light.png`](phase-3a/theme-light.png) | `daylight`: surface `rgb(255,255,255)`, grid `rgb(216,222,232)` — the spike's numbers, reproduced. |
| [`phase-3a/theme-dark.png`](phase-3a/theme-dark.png) | `midnight`: surface `rgb(17,24,39)`, grid `rgb(31,41,55)`, toolbar icons **painted** (the `--palette-common-black` trap, not re-entered), no white band across the formula bar. |
| [`phase-3a/phone.png`](phase-3a/phone.png) | 390×844, `hasTouch`: the action bar collapsed to icons, IronCalc's toolbar parked behind "Format", formula bar and sheet tabs kept, `canEdit` on. |
| [`phase-3a/sort.png`](phase-3a/sort.png) | The sort dialog over a dragged A1:C5 selection: header-row checkbox, the key named by its header (`Region (A)`), direction, "Add another sort column". |
| [`phase-3a/filter.png`](phase-3a/filter.png) | The funnel's popover: sort this column, filter by values or condition, the distinct-value checklist with search and Select all / Clear, `(Blanks)`. |
| [`phase-3a/find.png`](phase-3a/find.png) | Find & replace: live "1 of 2", the four Sheets options, the current match named (`Sheet1 · C2 — Dana`), Replace / Replace all. |
| [`phase-3a/history.png`](phase-3a/history.png) | Versions with the `agent` badge and the comment that says *why* (`before: delete rows 2-4`), Restore on every row and again for the selected version. |

Regenerate with
`NAV_E2E_ADMIN_PORT=5561 pnpm --filter @nessie/admin test:e2e:spreadsheet-shell`
(writes to `e2e/screenshots/spreadsheets/`), and prove the chunk on a
production build with `pnpm --filter @nessie/admin verify:spreadsheet-lazy`.

## Bundle, on a production build

| Asset | Raw | Gzip |
|---|---|---|
| entry `index-*.js` | 2,498.36 kB | 752.08 kB |
| `SpreadsheetPane-*.js` (lazy) | 694.58 kB | 181.57 kB |
| `SpreadsheetPane-*.css` (lazy) | 73.03 kB | 10.38 kB |
| `wasm_bg-*.wasm` (lazy) | 1,974.50 kB | 674.70 kB |

The entry grew 14.95 kB against the spike's 2,483.41 kB baseline — the
doorways and the kind switches, not the widget. `verify:spreadsheet-lazy`
asserts statically that the entry contains no IronCalc, references the chunk
only through a dynamic import, never names the wasm URL, and that
`index.html` preloads neither.

## Departures from admin-ui.md

1. **`VersionHistory.tsx` is not reused.** Its body is a two-column *line
   diff of the markdown body*. A workbook's `body` is the tab-separated text
   projection written for search and embeddings, so diffing it line by line
   shows a reader a wall of tabs and calls it a comparison. The version
   *list* — author, `agent` badge, comment, Restore, Download — is what a
   spreadsheet needs, so `SpreadsheetHistoryPanel.tsx` is that list without
   the diff. `VersionHistory.tsx` is untouched.
2. **Restore's three places are the two in the pane plus the per-row
   control**, not the chat tool card: `sheet_*` tool cards are Phase 4's
   surface. `SpreadsheetHistoryPanel` and `SpreadsheetVersionSavedNoticeBar`
   are exported for Phase 4 to reuse.
3. **The phone breakpoint is `sm` (640 px), not 480 px.**
   `scripts/lint-breakpoints.mjs` rejects an arbitrary viewport variant
   outright: a breakpoint number is authored once, in `styles.css`'s
   `@theme static` block. The pane reads `useViewport().atLeast.sm`.
4. **Fullscreen does not go through `useOverlay`.** That primitive runs its
   open/close motion on `panelRef`, and the pane's box is the element that
   stays on screen afterwards — so leaving fullscreen would fade the inline
   pane. It registers `useLocalBack` and an Escape handler directly, and only
   the pane's own box changes: the host never moves in the tree, which is what
   keeps `workbookState` (IronCalc builds it in its root render body).
5. **The override stylesheet lives beside the component**, not in
   `admin/src/styles/`: `scripts/lint-admin-layers.mjs` forbids a
   `components/*` file importing from the root. Importing it from the lazy
   chunk also keeps it off `/knowledge-base`.
6. **The collapsed toolbar zeroes `--toolbar-height`**, IronCalc's own
   mechanism (`.ic-workbook-container--readonly` does the same), rather than
   `display: none`. The worksheet area is absolutely positioned at
   `top: var(--toolbar-height)`, so hiding the wrapper left the grid pushed
   down 40 px while the wrapper itself measured zero — **a screenshot caught
   it, an assertion on the wrapper could not**.
7. **The funnel button sizes its icon with an inline `fontSize`.** The
   admin's unlayered `button { font: inherit }` reset beats every layered
   `text-*` utility and FontAwesome sizes its `svg` at `1em`, so the glyph
   inherited the pane's 15 px, filled the 16 px box edge to edge and stopped
   reading as a funnel. Measured (`svg` 15×15 in a 16×16 button), then fixed,
   then looked at again.
8. **A pane surface makes the grid `inert` while it is open.** Measured: with
   the sort dialog open, `document.activeElement` is `.ic-workbook-container`
   — the widget takes focus back after one of our overlays has taken it. Two
   things then break silently. `useModalA11y` installs Escape and the focus
   trap on the *panel*, so a panel that has lost focus has lost both. A
   popover's Escape rides a document listener, and the widget's own Escape
   handler stops the event inside React's root before it arrives. Worse, a
   find box that cannot hold focus sends the next keystroke into a cell.
   `inert` is both the fix and the right semantics.
9. **Fullscreen's Escape and Ctrl/Cmd-F are capture-phase listeners**, for the
   same reason: the widget swallows both while the grid has focus, which is
   exactly when a person reaches for them.
10. **`shiftIntent` is not imported from `@nessie/spreadsheet`.** It does not
   exist yet; the A1 helpers come from `@nessie/schemas`, which already
   exports them. Phase 3b picks the rebase helper up.
11. **The e2e suite is `admin/e2e/spreadsheet-shell/`**, because Phase 3b owns
    `admin/e2e/spreadsheets/**`.

## Corrections this phase forces elsewhere

- **`admin/test/**/*.test.tsx` was never discovered.** The package's test
  script globbed `test/**/*.test.ts` only, so
  `agent-visibility-presentation.test.tsx` had been running nowhere at all
  (it passes). The script now names both globs;
  `scripts/lint-test-globs.mjs` did not catch this and still would not.
- **The bootstrap and the filter model must not carry `placeholderData`.**
  Replaying either from the previously open page builds the wrong workbook or
  draws another sheet's filters over this one. Recorded in `skeleton`'s
  exemption list with that reason.

## What the screenshots caught that the assertions did not

Each of these passed every assertion in place at the time, and was obvious the
moment somebody looked.

- **The funnel buttons were not on screen at all.** `cellRect` answers in the
  scroll container's frame while the layer is positioned against the pane, and
  the container is discovered after IronCalc mounts — as a ref, whose
  assignment schedules no render, so the layer measured `null` once and never
  looked again.
- **The collapsed toolbar still reserved its 40 px**, because the worksheet
  area is absolutely positioned at `top: var(--toolbar-height)` while the
  wrapper itself measured zero.
- **The funnel glyph filled its 16 px box** and stopped reading as a funnel:
  the unlayered `button { font: inherit }` reset beats every layered `text-*`
  utility, and FontAwesome sizes its `svg` at `1em`.
- **Both popovers were transparent.** `Popover` places and dismisses; the
  panel's chrome belongs to the caller, as it does at every other call site.
- **Controls sat outside their popover.** The panels were too narrow for their
  content and `overflow: auto` turned the overflow into a clip, so the step
  button and "Replace all" were drawn and unclickable. The run now asserts
  that no control's box escapes its panel's.
- **The `agent` pill read as one word.** `Pill` letter-spaces its label, and a
  literal space between two JSX children collapses against that.

## Seams left for Phase 3b

- `SpreadsheetPane`'s `onSession`, `onFlush`, `onPresence`, `peers`,
  `liveStatus` and `versionNotice` props. The last one is the
  “Saved a version before … — Restore” notice: 3a owns the surface and its
  dismissal, and the *trigger* is a batch summary arriving on the live lane
  (3b) or an agent's tool result (Phase 4), which is not something this pane
  could know on its own. `WorkbookSession` carries `{ model, handle, redraw,
  applyExternal, flushNow, appliedSeq, missingSeqs }`.
- `spreadsheet-geometry.ts` — `cellRect` / `cellFromPoint` with the frozen
  panes the spike's prototype skipped, already shared with the filter header
  buttons so the two layers can never disagree about where B4 is.
- `isEmptyFlush` — the one-`0x00`-byte guard, so 3b's submit door never burns
  a `seq` on an empty microtask.
- `intentFromCall` — the wire intent for a replayed batch. A call the contract
  has no shape for returns `null` and ships its diffs unrebasable.
- `PresenceStrip` takes `peers` as a prop and resolves nothing itself.
- `buildWorkbook` reports `missingSeqs` for batches the fan-out cap dropped,
  and stops at the first gap rather than applying past it.

## Phase 5 correction — the pane's chrome (2026-09-16)

Two cosmetic defects visible in [`phase-3a/create.png`](phase-3a/create.png),
both fixed; the result is
[`phase-5/pane-chrome.png`](phase-5/pane-chrome.png) (from the live
`two-browsers` e2e run, not a fixture).

- **"History" appeared twice on one screen with one meaning** — a page-header
  button and the action bar's fifth item. The header action is gone;
  `SpreadsheetPane`'s `headerActions` is now empty. The bar keeps History,
  beside "Save version", where somebody deciding about versions is already
  looking. Every other spreadsheet action was already in the bar, so nothing
  was left stranded in the header.
- **Our action bar was a second bordered band above IronCalc's toolbar**, which
  itself sits above the formula bar: three rows of chrome before the grid, two
  of them ours. The bar now renders in `ResponsivePageHeader`'s `below` slot —
  the design system's own answer, "one bordered block, never a second header" —
  so it shares the header's surface instead of drawing its own. It keeps its
  border and background only in fullscreen (`framed`), where there is no header
  block to sit in. `KnowledgePane` gained the `below` pass-through and renders
  it even when the native bar has taken the header, because otherwise Sort,
  Filter, Find and Export would vanish on iPad and in the desktop shell.

Neither change touches a `data-testid`, a popover anchor ref or a pressed
state, and the four runnable e2e cases pass unchanged.
