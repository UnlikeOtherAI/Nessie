// The four facts `WorkbookHost`'s `repaintGrid` stands on, pinned against the
// installed `@ironcalc/workbook`.
//
// The grid is IronCalc's own canvas and the package publishes no repaint, so a
// peer's or an agent's batch is invisible until the widget's `Workbook` subtree
// re-renders. `repaintGrid` makes that happen with one synthetic `Escape`
// `keydown` aimed at the widget's own root element. That used to be a
// `pnpm patch` (`patches/@ironcalc__workbook@0.8.3.patch`), and the patch had
// one virtue this file has to reproduce: **a release that moved the anchors
// failed loudly.** A DOM reach-in fails silently — the canvas simply stops
// following the model — so the loudness lives here instead.
//
// If this file goes red after an IronCalc upgrade, do not loosen it. Re-read
// `Workbook.tsx` / `Worksheet.tsx` in the new `dist/ironcalc.js`, check whether
// upstream has published a repaint on `IronCalcHandle` (case 0 below), and fix
// `repaintGrid` before anything else.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))

/** pnpm's hoisted linker puts it at the repo root; keep the isolated layout working too. */
const packageRoot = (): string => {
  const candidates = [
    resolve(here, '..', '..', 'node_modules', '@ironcalc', 'workbook'),
    resolve(here, '..', 'node_modules', '@ironcalc', 'workbook'),
  ]
  for (const candidate of candidates) {
    try {
      readFileSync(resolve(candidate, 'package.json'), 'utf8')
      return candidate
    } catch {
      // next candidate
    }
  }
  throw new Error(`@ironcalc/workbook is not installed; looked in ${candidates.join(', ')}`)
}

const root = packageRoot()
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  version: string
}
const bundle = readFileSync(resolve(root, 'dist', 'ironcalc.js'), 'utf8')
const handleTypes = readFileSync(resolve(root, 'dist', 'IronCalc.d.ts'), 'utf8')

// Identifiers are minified and change on every release, so every anchor below
// matches the *shape* and back-references the name it captured.

test('the version the repaint route was read against', () => {
  assert.equal(manifest.version, '0.8.3')
})

test('the package is unpatched: nothing in the repo modifies it', () => {
  assert.equal(
    /redraw/.test(bundle),
    false,
    'dist/ironcalc.js contains "redraw" — the pnpm patch is back, or upstream shipped one',
  )
})

test('IronCalcHandle still publishes no repaint', () => {
  // The day this fails because upstream added one, delete `repaintGrid` and
  // call the handle: a published method beats a synthetic key press.
  const handle = /export interface IronCalcHandle \{([\s\S]*?)\}/.exec(handleTypes)
  assert.ok(handle, 'IronCalc.d.ts no longer declares IronCalcHandle')
  assert.equal(handle[1].trim(), 'setLanguage: (language: string) => void;', handle[1])
})

test('`.ic-workbook-container` is the element that carries the key handler', () => {
  assert.match(
    bundle,
    /className: `ic-workbook-container\$\{[^`]*`,\s*\n\s*ref: \w+,\s*\n\s*onKeyDown: \w+,/u,
  )
})

test('the key handler ignores anything whose target is not that element', () => {
  // This is what keeps the synthetic Escape away from the cell editor: an edit
  // arriving while somebody is typing must leave their `<textarea>` alone.
  assert.match(
    bundle,
    /\{ root: (\w+) \} = \w+;\s*\n\s*if \(!\1\.current \|\| (\w+)\.target !== \1\.current\) return;/u,
  )
})

test('Escape is routed to onEscape', () => {
  assert.match(bundle, /case "Escape": \w+\.onEscape\(\);/u)
})

test('onEscape bumps the refresh counter and does nothing else that has to be kept', () => {
  // Drawing state only: the cut outline and the format painter. A paste still
  // reads `type: "cut"` off the clipboard payload, so paste semantics do not
  // ride on `cutRange`.
  const escape =
    /onEscape: \(\) => \{\s*\n\s*(\w+)\.clearCutRange\(\), \1\.setCopyStyles\(null\);([\s\S]*?)\n\t\t\},/u
      .exec(bundle)
  assert.ok(escape, "Workbook's onEscape no longer starts with clearCutRange + setCopyStyles(null)")
  const body = escape[2]
  assert.match(body, /\(\w+\) => \w+ \+ 1\);/u, 'onEscape no longer bumps the refresh counter')
  assert.equal(
    /setUserInput|clearEditingCell|setEditingCell|setSelected|undo\(\)|redo\(\)/u.test(body),
    false,
    `onEscape gained a side effect worth keeping: ${body}`,
  )
})

test('any re-render of the Worksheet subtree repaints the canvas from the model', () => {
  // `Worksheet` rebuilds `WorksheetCanvas` and calls `renderSheet()` in an
  // effect with **no dependency array** — the `});` is the assertion.
  assert.match(bundle, /\.renderSheet\(\), \w+\.current = \w+;\s*\n\t\}\);/u)
})
