# Phase 3a — the admin UI shell, as built

What landed on `agent/sheets-ui`, and the places it departs from
[admin-ui.md](admin-ui.md). Every departure below was forced by something
measured, and says what.

Measured 2026-09-16 against `@ironcalc/workbook` 0.8.3 + `@ironcalc/wasm`
0.8.4, React 19.2, Vite 7.3.

## Evidence

| Screenshot | What it shows |
|---|---|
| [`phase-3a/create.png`](phase-3a/create.png) | The grid in the default theme: our action bar, the chips bar, funnel buttons on A/B/C, IronCalc's toolbar, formula bar and sheet tabs, `B6 = 445` from `=SUM(B2:B5)`. |
| [`phase-3a/theme-light.png`](phase-3a/theme-light.png) | `daylight`: surface `rgb(255,255,255)`, grid `rgb(216,222,232)` — the spike's numbers, reproduced. |
| [`phase-3a/theme-dark.png`](phase-3a/theme-dark.png) | `midnight`: surface `rgb(17,24,39)`, grid `rgb(31,41,55)`, toolbar icons **painted** (the `--palette-common-black` trap, not re-entered), no white band across the formula bar. |
| [`phase-3a/phone.png`](phase-3a/phone.png) | 390×844, `hasTouch`: the action bar collapsed to icons, IronCalc's toolbar parked behind "Format", formula bar and sheet tabs kept, `canEdit` on. |

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
8. **`shiftIntent` is not imported from `@nessie/spreadsheet`.** It does not
   exist yet; the A1 helpers come from `@nessie/schemas`, which already
   exports them. Phase 3b picks the rebase helper up.
9. **The e2e suite is `admin/e2e/spreadsheet-shell/`**, because Phase 3b owns
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

## Seams left for Phase 3b

- `SpreadsheetPane`'s `onSession`, `onFlush`, `onPresence`, `peers` and
  `liveStatus` props. `WorkbookSession` carries `{ model, handle, redraw,
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
