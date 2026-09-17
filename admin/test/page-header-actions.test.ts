import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const source = (path: string): string =>
  readFileSync(isAbsolute(path) ? path : fileURLToPath(new URL(path, import.meta.url)), 'utf8')
    .replaceAll('\r\n', '\n')

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

// A page-header action is styled by the role it declares, and the role has to
// be a name a stylesheet can reach. Spelt as colour utilities at the call
// site, the header's hover rule had nothing to attach to, so a whole row of
// controls answered a pointer with nothing while its stylesheet rule sat dead.
test('page-header actions carry their role as a class the stylesheet owns', () => {
  const header = source('../src/components/shared/ResponsivePageHeader.tsx')
  const styles = source('../src/styles.css')

  for (const role of ['primary', 'selected', 'secondary', 'open']) {
    assert.match(header, new RegExp(`admin-page-action-${role}`))
    assert.match(styles, new RegExp(`\\.admin-page-action-${role}[,\\s:{]`))
  }
  // Colour belongs to the stylesheet; the utilities left here own the box.
  assert.doesNotMatch(header, /bg-\[color:var\(--accent\)\]/)
  assert.doesNotMatch(header, /hover:(?:bg-|opacity-|text-)/)

  assert.match(
    styles,
    /\.admin-page-action-primary \{[^}]*background: var\(--accent\);[^}]*color: var\(--on-accent\)/,
  )
  assert.match(
    styles,
    /\.admin-page-action-secondary \{[^}]*border-color: var\(--sep\);[^}]*background: var\(--overlay-weak\)/,
  )
  // A hover that also matched a disabled control would repaint the one cue
  // saying the action cannot be pressed, exactly when the pointer arrives —
  // these rules are unlayered and beat the `opacity-50` utility.
  const withoutComments = styles.replaceAll(/\/\*[\s\S]*?\*\//g, '')
  const rules = withoutComments
    .split('\n\n')
    .filter((chunk) => /^\.admin-page-action[^\n]*:(?:hover|focus-visible)/m.test(chunk))
  assert.ok(rules.length >= 3, 'expected hover/focus rules for each action role')
  for (const rule of rules) {
    for (const selector of rule.split('{')[0]?.split(',') ?? []) {
      if (!/:(?:hover|focus-visible)/.test(selector)) continue
      assert.match(selector, /:not\(:disabled\)/)
    }
  }
})

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

// The bar's geometry is a set of tokens consumed by the one header component,
// so rescaling it is a one-line edit — and the pointer, not a breakpoint,
// decides which values the tokens hold. A hard-coded height back in the
// component, or a compact bar shipped to a coarse pointer, is the regression
// this pins.
test('the header geometry is tokenised and split by pointer', () => {
  const header = source('../src/components/shared/ResponsivePageHeader.tsx')
  const styles = source('../src/styles.css')

  // The component consumes the tokens and states no geometry of its own.
  for (const token of [
    '--page-header-height',
    '--page-header-gap',
    '--page-header-action-height',
    '--page-header-toggle-height',
  ]) {
    assert.match(header, new RegExp(`var\\(${token}\\)`), `header consumes ${token}`)
    assert.match(styles, new RegExp(`:root \\{[\\s\\S]*${token}:`), `styles declare ${token}`)
  }
  assert.doesNotMatch(header, /h-\[50px\]|\bh-11\b|\bw-11\b|\bh-8\b/)

  // A compact action is a square at whatever the action height is.
  assert.match(header, /w-\[var\(--page-header-action-height\)\]/)

  // The font-size lives on the unlayered rule, where it beats the
  // `button { font: inherit }` reset — a `text-*` utility on the element is
  // silently ignored.
  assert.match(styles, /\.admin-page-action \{[^}]*font-size: var\(--page-header-action-font-size\)/)
  assert.doesNotMatch(header, /admin-page-action inline-flex[^']*text-xs/)

  // The compact geometry is the fine-pointer case; a coarse pointer restores
  // the touch geometry, so a finger still gets its 44px target.
  const coarse = styles.match(/@media \(pointer: coarse\) \{\s*:root \{([^}]*)\}/)
  assert.ok(coarse, 'a (pointer: coarse) block re-declares the header tokens')
  assert.match(coarse[1] ?? '', /--page-header-action-height: 44px/)
  assert.match(coarse[1] ?? '', /--page-header-height: 50px/)
})
