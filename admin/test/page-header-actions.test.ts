import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const srcDir = fileURLToPath(new URL('../src', import.meta.url))

const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = `${directory}/${entry.name}`
    if (entry.isDirectory()) return walk(full)
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [full] : []
  })

// The object literal a call site writes for one header action. Anchored on
// `priority`, which every action carries and nothing else in these files does
// at the top level of an object.
const actionLiterals = (contents: string): string[] => {
  const lines = contents.split('\n')
  return lines.flatMap((line, index) => {
    if (!/^\s*priority: \d+,?$/.test(line)) return []
    let depth = 0
    let start = index
    outer: for (let cursor = index; cursor >= 0; cursor -= 1) {
      const text = lines[cursor] ?? ''
      for (let column = text.length - 1; column >= 0; column -= 1) {
        if (text[column] === '}') depth += 1
        else if (text[column] === '{') {
          if (depth === 0) { start = cursor; break outer }
          depth -= 1
        }
      }
    }
    depth = 0
    let end = index
    outer2: for (let cursor = start; cursor < lines.length; cursor += 1) {
      const text = lines[cursor] ?? ''
      for (let column = cursor === start ? text.indexOf('{') : 0; column < text.length; column += 1) {
        if (text[column] === '{') depth += 1
        else if (text[column] === '}') {
          depth -= 1
          if (depth === 0) { end = cursor; break outer2 }
        }
      }
    }
    return [lines.slice(start, end + 1).join(' ')]
  })
}

// The header's buttons look like buttons in every theme, not only in the one
// that happened to style them. Before this, `.admin-page-action` had colour
// rules under `[data-theme='space-white']` alone, so every other theme drew a
// row of bare text where "New task" and "Sign out" belong.
test('every theme draws page-header actions as filled and bordered buttons', () => {
  const styles = source('../src/styles.css')
  const base = styles.slice(0, styles.indexOf("[data-theme='space-white'] .admin-topbar"))

  assert.match(base, /\.admin-page-action \{[^}]*border-radius: var\(--radius-sm\)/)
  assert.match(
    base,
    /\.admin-page-action-primary \{[^}]*background: var\(--accent\);[^}]*color: var\(--on-accent\)/,
  )
  assert.match(
    base,
    /\.admin-page-action-secondary \{[^}]*border-color: var\(--sep\);[^}]*background: var\(--overlay-weak\)/,
  )
  // An icon-only action is a toolbar mark: same box, no frame until it is
  // hovered or on. Six bordered squares in a channel header read as six
  // equals beside the one action that matters.
  assert.match(
    base,
    /\.admin-page-action-secondary\[aria-label\] \{[^}]*background: transparent/,
  )
  const onOrDown = [
    "\\.admin-page-action-selected,\\n",
    "\\.admin-page-action-open,\\n",
    "\\.admin-page-action\\[aria-pressed='true'\\] \\{[^}]*background: var\\(--accent-soft\\)",
  ].join('')
  assert.match(base, new RegExp(onOrDown))
  // A hover that also matched a disabled control would repaint the one cue
  // saying the action cannot be pressed, exactly when the pointer arrives.
  for (const rule of base.split('\n\n').filter((chunk) => /^\.admin-page-action[^\n]*:hover/m.test(chunk))) {
    assert.match(rule, /:hover:not\(:disabled\)/)
  }
})

// "Creating a new item should always be primary." The rule holds per header,
// not per button: Knowledge offers New page, New folder and Upload file in one
// row, and Dashboards offers Add widget beside Done. Exactly one of them is
// filled — the one the screen exists for — so what the test pins is that a
// header which offers a creation names a primary at all, never that three
// filled buttons compete in the same row.
test('a header that offers a creation names a primary action', () => {
  const offenders: string[] = []
  for (const file of walk(srcDir)) {
    const literals = actionLiterals(source(file))
    if (literals.length === 0) continue
    const creates = literals.filter(
      (literal) => /label: (?:'|`)(New |Add |Create )/.test(literal) && !/kind: 'menu'/.test(literal),
    )
    if (creates.length === 0) continue
    if (!literals.some((literal) => /\bprimary:/.test(literal))) {
      offenders.push(`${file}: offers ${creates.length} creation(s) and no primary action`)
    }
    // A label that draws its own mark ("+ Add widget") stopped making sense
    // the moment the action became a real button with an icon slot.
    for (const literal of creates) {
      if (/label: (?:'|`)\+/.test(literal)) offenders.push(`${file}: a label draws its own +`)
    }
  }
  assert.deepEqual(offenders, [])
})
