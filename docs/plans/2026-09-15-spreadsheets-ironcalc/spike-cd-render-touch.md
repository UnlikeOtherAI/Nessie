# Spike C (render) and Spike D (touch) — measured outcomes

Phase 0 items 6 and 7 of [phases.md](phases.md). Measured 2026-09-16 on
`agent/spike-render` against `@ironcalc/workbook` 0.8.3 and `@ironcalc/wasm`
0.8.4, React 19.2.4, Vite 7.3.2, headless Chromium 1234 and — for the one
question the plan left open — **real iOS 26.5 Mobile Safari** in the iPhone 17
Pro simulator.

**Verdicts**

| | Outcome |
|---|---|
| **C — render** | **Pass.** `<IronCalc>` mounts under React 19.2 unchanged, edits, recalculates, undoes, redoes and takes structural ops; a second model's `flushSendQueue()` diffs apply to the mounted one and paint through the patched `redraw()`; the method-shadowing bridge records intent without a fork; both themes reach the canvas. No fork trigger from `library-assessment.md` §"When to fork" was hit. |
| **D — touch** | **Pass — phone editing ships.** Tap selects, double-tap opens the `<textarea>` and the on-screen keyboard path, Enter commits, a drag scrolls. The overlay's long-press range selection works **on real iOS WebKit**, does not fight the native scroll, and cost **182 lines** (the plan budgeted ≈ 200). One extra fix the plan does not mention was needed and is three CSS declarations. |

Everything below is reproducible:

```sh
NAV_E2E_ADMIN_PORT=5561 node admin/e2e/spike-spreadsheet/run.mjs
```

The throwaway page it drives (`admin/src/routes/__spike-spreadsheet/`) is
**deleted from the branch** as the spike's last commit requires; its code is
reproduced below and is the seed for Phase 3a's `WorkbookHost.tsx`,
`spreadsheet-model-bridge.ts`, `spreadsheet-theme.ts` and Phase 3b's
`useTouchSelection.ts`. The complete files stay recoverable on this branch —
`git show <the commit before this document's> -- admin/src/routes/__spike-spreadsheet`,
or `git log --diff-filter=D -- admin/src/routes/__spike-spreadsheet`. Raw
numbers: `spike-cd/findings.json`.

## Spike C — render

| Check | Measured |
|---|---|
| Mounts under React 19.2.4 in `StrictMode` | canvas present, **zero** page errors |
| Seeded `=SUM(B2:B3)` evaluates | `B4 = 200` |
| Edit a cell through the widget's own keyboard path | `B2 = 220`, `B4` recalculated to `300` |
| Undo / redo | `120` then `220` |
| `insertRows(0, 2, 1)` | `A3 = North`, total follows to row 5, still `300` |
| Bridge recorded the edit and drained the queue | one flush, `["setUserInput"]`, **27 diff bytes** |
| Mutating methods shadowed | **52** own-property wrappers |
| Selection frames emitted during the run | 16 |
| Second model's diffs applied to the mounted model | `B3` `220 → 999`, **27 bytes** |
| `applyExternalDiffs` echo into the local queue | none (`flushSendQueue()` returns `[0x00]`) |
| Canvas **without** `redraw()` | unchanged — stale |
| Canvas **with** `redraw()` | repainted |
| Theme light (`daylight`) | grid `rgb(216,222,232)`, surface `rgb(255,255,255)`, outline `rgb(37,99,235)` |
| Theme dark (`midnight`) | grid `rgb(31,41,55)`, surface `rgb(17,24,39)`, outline `rgb(37,99,235)` |

Screenshots: `spike-cd/desktop-light.png`, `spike-cd/desktop-dark.png`.

### The `pnpm patch` — what it changes and why

`patches/@ironcalc__workbook@0.8.3.patch`, **54 lines**, registered from the
root `package.json` (`pnpm.patchedDependencies`) so `pnpm-workspace.yaml` — a
shared file with load-bearing comments pnpm rewrites when it owns the key —
stays untouched.

`Workbook.tsx` keeps a private `useState` counter it bumps after its own
actions; `Worksheet.tsx` rebuilds `WorksheetCanvas` and calls `renderSheet()`
in a `useEffect` **with no dependency array**, so any re-render of that subtree
repaints from the model. Bumping that counter is therefore the whole of
"redraw", and it is the one thing a host cannot reach from outside. The patch
publishes it through an optional ref prop and hangs `redraw()` off
`IronCalcHandle`:

```js
// dist/ironcalc.js — Workbook (src/components/Workbook/Workbook.tsx)
-  …, s = w(null), l = T(0)[1], [u, d] = T(null), …
+  …, s = w(null), l = T(0)[1],
+  __icRedraw = e.redrawRef ? e.redrawRef.current = () => l((e) => e + 1) : null,
+  [u, d] = T(null), …

// dist/ironcalc.js — IronCalc root (src/IronCalc.tsx)
-  let a = n ?? document.body;
+  let a = n ?? document.body, __icRedrawRef = w(null);
       …
   } })),                       →   }, redraw() { __icRedrawRef.current?.(); } })),
   canEdit: r                   →   canEdit: r, redrawRef: __icRedrawRef

// dist/IronCalc.d.ts
 export interface IronCalcHandle {
     setLanguage: (language: string) => void;
+    /** Repaints the grid after the model changed from outside the widget. */
+    redraw: () => void;
 }
```

Four hunks, no behaviour change when `redrawRef` is absent, and the four
anchors are distinctive enough that a release which moves them fails the patch
loudly rather than silently. Well inside the ≤ 50-line fork trigger (the count
above is diff lines; the code change is 6 lines).

**Measured necessity.** Applying a peer batch with the repaint suppressed left
`canvas.toDataURL()` byte-identical; calling `redraw()` changed it. Without the
patch a remote edit is invisible until the person clicks.

### The bridge (method shadowing, not a fork)

Own-property wrappers on the live wasm `Model`. They survived the whole run:
`__wbg_ptr` untouched, every widget call still lands on the real instance.

```ts
const wrap = (name: string, after: (args: unknown[]) => void): void => {
  const original = prototype[name]
  if (typeof original !== 'function') return
  Object.defineProperty(target, name, {
    configurable: true, enumerable: false, writable: true,
    value: function wrapped(this: unknown, ...args: unknown[]): unknown {
      const result = original.apply(this, args)
      if (!suspended) after(args)
      return result
    },
  })
  installed.push(name)
}

for (const name of recorded) {
  wrap(name, (args) => { intents.push({ args, at: Date.now(), method: name }); schedule() })
}
for (const name of SELECTION) {
  wrap(name, () => options.onPresence?.(frameFrom(model.getSelectedView())))
}

// One microtask drains the engine's queue into the sync layer.
const flushNow = (): void => {
  scheduled = false
  const pending = intents.splice(0, intents.length)
  const diffs = model.flushSendQueue()
  if (pending.length === 0 && diffs.length === 0) return
  options.onFlush({ diffs, intents: pending })
}

// Foreign diffs, with recording suspended so a peer's batch is not echoed back.
const applyExternal = (diffs: Uint8Array): void => {
  suspended = true
  try {
    model.pauseEvaluation()
    model.applyExternalDiffs(diffs)
    model.resumeEvaluation()
    model.evaluate()
  } finally { suspended = false }
}
```

The recordable set is derived from `Model.prototype` at runtime — everything
that is not a `get*`/`can*`/`is*` reader, not in `NON_RECORDING`
(`applyExternalDiffs`, `flushSendQueue`, `toBytes`, `evaluate`,
`pause/resumeEvaluation`, `copyToClipboard`, `cycleReference`,
`isValidDefinedName`, `resolveColor`, `free`), and not in `SELECTION`
(`setSelected*`, `onArrow*`, `onPage*`, `onExpandSelectedRange`,
`onAreaSelecting`, `onNavigateToEdgeInDirection`, `setTopLeftVisibleCell`,
`setWindow*`). That yields **52 names**. Two traps for Phase 3a:

- **wasm-bindgen plumbing sits on the same prototype.** `__destroy_into_raw`
  matched the first pass and must be excluded (`!name.startsWith('_')`).
  Shadowing it would corrupt disposal.
- **`undo`/`redo` are wrapped like any other mutator** and their diffs reach the
  queue, as the plan assumes.

### Theme

`spreadsheet-theme.ts` reads the admin tokens off `document.documentElement`
with `getComputedStyle` and returns **all 58 `IronCalcThemeVariables`
keys** as resolved literals. The canvas reads a 14-variable subset via
`getComputedStyle(.ic-root)` in `WorksheetCanvas`'s constructor, and because
that constructor runs in a dependency-free `useEffect`, a theme change plus one
`redraw()` repaints the grid. No CSS bridge file, as the plan predicted — with
two corrections:

1. **`--palette-common-black` is the foreground, not a background.** Every
   toolbar icon is `currentColor` beneath it and `--black-04`/`--black-12` are
   `color-mix`es of it. Mapping it to the dark surface erased the entire
   toolbar (caught by screenshot). It maps to `--tx`; `--palette-common-white`
   maps to `--panel`.
2. **Four rules in `ironcalc.css` hard-code a light colour** and need a small
   override sheet, which the plan says is unnecessary:

```css
.ic-root .ic-editor-container { background: var(--palette-common-white); }
.ic-root .ironcalc-cell-handle { border-color: var(--palette-common-white); }
.ic-root .ic-sheet-tab:hover { background-color: var(--palette-grey-100); }
.ic-root .ic-db-swatch-row + .ic-db-swatch-row { border-top-color: var(--palette-grey-300); }
```

Only the first is visible in ordinary use (a white band across the formula
bar in any dark theme). Upstream PR candidate: swap the four literals for the
palette variables they mean.

`darkThemeVariables`, which `library-assessment.md` and `admin-ui.md` both say
is shipped, **is not exported by the published package** — `dist/index.d.ts`
exports `init`, `Model`, `IronCalc`, the icons and seven primitives, and
nothing from `theme/`. There is no `darkThemeVariables` string anywhere in
`dist/`. Nothing is lost: one mapping over the admin's own tokens covers both
themes, and the admin has eleven themes rather than two.

### Bundle and wasm, measured

`pnpm --filter @nessie/admin build` (through `turbo run build --filter`, so the
workspace deps build first) produces **no IronCalc chunk and no `.wasm`** —
nothing on the app's route graph imports it yet. Baseline entry chunk:
2,483.41 kB / 748.10 kB gzip.

The real cost is measured by building the spike entry with the same Vite,
React and `lazy()` boundary (config kept beside the page; `admin/vite.config.ts`
is shared and was not touched):

| Asset | Raw | Gzip | When |
|---|---|---|---|
| entry `index-*.js` (React + the shell) | 195.03 kB | 61.51 kB | eager |
| entry `index-*.css` | 151.37 kB | 26.76 kB | eager |
| `SpikeWorkbook-*.js` (workbook + i18next + lucide + react-colorful + our 3 modules) | **666.81 kB** | **173.02 kB** | lazy |
| `SpikeWorkbook-*.css` (`ironcalc.css`) | **72.38 kB** | **10.25 kB** | lazy |
| `wasm_bg-*.wasm` | **1,974.50 kB** | **674.70 kB** | lazy |

**Lazy-load proof, on the production build** served by `vite preview`:

```text
EAGER: index.html [446]  index-BEbst1YD.css  index-C0xg0EaO.js
LAZY:  SpikeWorkbook-By5ES0oa.css  SpikeWorkbook-BMd0WaHZ.js  wasm_bg-DW9Xt_vt.wasm [1974495]
```

and in dev the same assertion runs every time (`lazy.beforeOpen: 0`). Against
the plan's "~0.9 MB JS + 1.9 MB wasm": the JS is **0.67 MB** (0.17 MB gzip),
the CSS adds 0.07 MB, the wasm is as predicted. About **858 kB gzip** crosses
the wire the first time a spreadsheet opens, then it is cached.

## Spike D — touch

Phone context, 390 × 844, `hasTouch: true`, `isMobile: true`.

| Check | Measured |
|---|---|
| Tap selects a cell | range `2:1:2:1` |
| Double-tap opens the editor | `document.activeElement` is `textarea` — the on-screen keyboard path |
| Type + Enter commits | `A2 = "Nord"` |
| A real finger drag scrolls (CDP touch sequence) | `scrollTop 0 → 343` |
| IronCalc's own touch drag selects a range | **no** — `2:2:2:2`; `usePointer.ts` ignores non-mouse pointers, as the plan says |
| Overlay: long press enters selection mode | yes, at 350 ms |
| Overlay: drag extends the range | `2:2:5:4` |
| Overlay: `touchmove` prevented while selecting | yes; `touch-action: none` on the container |
| Overlay: two corner handles drawn | yes |
| Overlay: mode released on lift | yes |
| **Real CDP long-press + drag** | range `3:2:7:4`, `scrollTop` unchanged (0 → 0) |

Screenshots: `spike-cd/phone-light.png`, `spike-cd/phone-dark.png`,
`spike-cd/phone-selection.png` (B3:D7 with both handles and the name box).

### On real iOS WebKit — the plan's open question, answered

The plan's one remaining unknown is whether long-press-drag fights the native
scroll on iOS. Chromium cannot answer that, so the page was driven in **Mobile
Safari on iOS 26.5** (iPhone 17 Pro simulator), with an on-page counter
readout instead of a console. Two runs, one gesture each:

```text
long press + drag:  down 1  move 6  up 1  hold 1  prevented 6  sel false  range 3:2:4:3
plain drag:         down 5  move 8  up 5  hold 1  prevented 6  sel false  → scrolled to row 24
```

`prevented 6` is the finding: after a **stationary** long press the gesture has
not committed to scrolling, so WebKit still honours `preventDefault()` on a
non-passive `touchmove`. The range followed the finger, the sheet did not move,
and a plain drag afterwards scrolled normally. Screenshot:
`spike-cd/ios-safari-long-press-range.png`.

**The one thing the plan misses.** iOS answers a long press with its *own*
text-selection gesture. On the first run the page-wide selection highlight
painted over the whole chrome while our range selection ran. The entire fix is
three declarations on the pane, and the grid is a canvas so nothing selectable
is lost:

```css
.spreadsheet-pane {
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}
```

With them the second run is clean (the screenshot above).

**A gap the prototype leaves for Phase 3b:** the handles are painted once and
do not follow a scroll — after the plain drag they stayed at their old screen
positions. `PresenceOverlay` already owes a scroll/resize redraw
(`admin-ui.md` §"Components"); the handles hang off the same one.

### The prototype

**182 lines** including comments (`useTouchSelection.ts`), against the plan's
≈ 200. The upstream `usePointer` change is a nice-to-have, not a prerequisite.
Core:

```ts
const onPointerDown = (event: PointerEvent): void => {
  if (event.pointerType !== 'touch') return
  const [x, y] = point(event)
  origin = { x, y }
  timer = setTimeout(() => {
    anchor = cellFromPoint(model, x, y)
    setMode(true)                              // touch-action: none on the container
    model.setSelectedCell(anchor[0], anchor[1])
    redraw(); paintHandles()
    container.setPointerCapture(event.pointerId)
  }, LONG_PRESS_MS)                            // 350 ms
}

const onPointerMove = (event: PointerEvent): void => {
  if (event.pointerType !== 'touch') return
  const [x, y] = point(event)
  if (!selecting) {
    // Movement before the timer is a scroll; hand it back to the browser.
    if (origin && Math.hypot(x - origin.x, y - origin.y) > SLOP_PX) clearTimeout(timer)
    return
  }
  event.preventDefault()
  const [row, column] = cellFromPoint(model, x, y)
  model.setSelectedRange(anchor[0], anchor[1], row, column)
  redraw(); paintHandles()
}

// Safari reads `touch-action` at gesture start, so the non-passive listener
// is what actually holds the scroll back once a finger is already down.
container.addEventListener('touchmove', (e) => { if (selecting) e.preventDefault() }, { passive: false })
```

`cellFromPoint` / `cellOrigin` re-implement `WorksheetCanvas`'s own sums —
28 px row header, 30 px column header, widths and heights from the model,
`top_row`/`left_column` from `getSelectedView()` — because the canvas instance
is private to `Workbook`. Frozen panes are the one case the prototype skips and
Phase 3b must add (`getFrozenRowsCount`/`getFrozenColumnsCount`).

## What this forces on the contract

1. **`toBytes()` is not a canonical serialisation, and byte equality is not a
   model-equality test.** Two models forked from *the same bytes* serialise
   differently (`twoForksEqual: false`); a single model serialises the same
   bytes twice (`selfEqual: true`); a `from_bytes → toBytes` round-trip is not a
   fixed point (`roundTripSettles: false`). Same length (449 B), first
   difference always at offset 45, immediately after the sheet name, in three
   varint-looking bytes that change every construction — a per-instance
   identifier or counter. **Cell values and structure agreed every time**
   (`valuesEqual: true`). Consequences: **Spike A must not compare `toBytes()`**
   (`phases.md` item 4 says it does) — it has to assert values, dimensions and
   styles; anything in `storage-and-concurrency.md` that hashes or dedupes the
   hot snapshot, or compares two engines byte-for-byte, needs the same
   treatment. `hot_snapshot` remains perfectly good as a *cache*.
2. **An empty send queue flushes as one `0x00` byte, not zero bytes.** The
   client and the write door must treat a 1-byte flush as "nothing to send", or
   every microtask ships an empty batch and burns a `seq`.
3. **`darkThemeVariables` does not exist in the published package** — see
   §Theme. `library-assessment.md` and `admin-ui.md` both promise it.
4. **The theme needs a four-rule CSS override**, against `admin-ui.md`'s "no
   CSS override file is needed", plus the three iOS `user-select` declarations.
5. **`--palette-common-black` is the foreground.** Worth stating in
   `spreadsheet-theme.ts`'s test, because inverting it silently erases the
   toolbar and nothing but a screenshot catches it.
6. **Method names in the plan that the wasm `Model` does not have**, found
   while building the bridge against the real prototype
   (`phases.md` item 3 lists them): `fromBytes` is **`Model.from_bytes`**
   (static, snake_case); `pasteCsvString` is **`pasteCsvText`**; there is **no
   `getSheetDimensions`** (use `getRowsWithData`/`getColumnsWithData`); and
   **no merge API at all** — no `mergeCells`, `unmergeCells` or
   `getMergedCells` in 0.8.4. Merges are an import/export-only concept in this
   version, so `overview.md`'s "merges" in the goal, `agent-tools.md` and
   `SpreadsheetEngineModel` all need revisiting before Phase 1 codes against
   them.
7. **`workbookState: new WorkbookState()` is constructed in `IronCalc`'s render
   body**, so anything that re-renders the *root* (not the Workbook subtree)
   throws away in-cell editing state. `redraw()` only re-renders the subtree and
   is safe; Phase 3a must keep the root's props stable anyway.
8. **Not a contract change, but a Phase 3a note:** Playwright cannot click the
   canvas without `force: true` — IronCalc's own `.ic-worksheet-cell-outline`
   div covers it. The e2e suites will need that everywhere.

## Untested here

- Frozen panes under the touch overlay's coordinate maths.
- Two real browsers against a server; the peer model is in-page by design.
- A physical iPhone (the simulator runs the same WebKit build; the compositor
  is the same code path, but hardware was not available).
- Android Chrome — the Chromium evidence is a strong proxy, not a measurement.
