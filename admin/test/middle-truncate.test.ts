import assert from 'node:assert/strict'
import test from 'node:test'
import { middleTruncate } from '../src/components/shared/MiddleTruncate'

/**
 * The name cell (browser-ui.md §4). The reference is Finder's own
 * `Fire_Risk_Ass…Distillery.docx`: the extension and enough of the tail to
 * tell one report from the next survive, and the middle goes.
 *
 * `measure` is injected, so these cases are the real algorithm rather than a
 * canvas's idea of a font.
 */

/** Every character is one unit wide — a ruler, not a renderer. */
const monospace = (value: string): number => value.length

test('text that fits is returned untouched', () => {
  assert.equal(middleTruncate('Lease.pdf', 40, monospace), 'Lease.pdf')
  assert.equal(middleTruncate('Lease.pdf', 9, monospace), 'Lease.pdf')
})

test('the extension and ten characters of the stem travel together', () => {
  const name = 'Fire_Risk_Assessment_Glenlivet_Distillery.docx'
  const result = middleTruncate(name, 29, monospace)

  assert.equal(result, 'Fire_Risk_Ass…Distillery.docx')
  assert.ok(result.endsWith('Distillery.docx'), 'the tail keeps the extension and ten stem chars')
  assert.ok(monospace(result) <= 29)
})

test('the result never overflows the cell it was measured against', () => {
  const name = 'A_very_long_report_about_something_nobody_reads.pdf'
  for (const width of [20, 25, 30, 35, 40, 45]) {
    const result = middleTruncate(name, width, monospace)
    assert.ok(
      monospace(result) <= width,
      `width ${width} produced ${result} (${monospace(result)} wide)`,
    )
  }
})

test('a cell too narrow even for the tail gives the tail back its start', () => {
  const result = middleTruncate('Quarterly_Accounts_2026.numbers', 10, monospace)
  assert.ok(monospace(result) <= 10, `${result} is ${monospace(result)} wide`)
  assert.ok(result.startsWith('…'), 'what is left is the end of the name')
})

test('a name with no extension truncates in the middle all the same', () => {
  const result = middleTruncate('Minutes of the Tuesday planning meeting', 20, monospace)
  assert.ok(monospace(result) <= 20)
  assert.ok(result.includes('…'))
  assert.ok(result.endsWith('ng meeting'), 'ten trailing characters survive')
})

test('a dotfile is a name, not an extension', () => {
  // `.gitignore`'s leading dot must not be read as an extension, which would
  // leave the whole name in the tail and nothing to truncate.
  const result = middleTruncate('.gitignore-but-much-longer-than-this', 15, monospace)
  assert.ok(monospace(result) <= 15)
  assert.ok(result.startsWith('.git'), `expected the start to survive, got ${result}`)
})

test('a full stop inside a sentence is not an extension', () => {
  const name = 'Report on Q1. Findings and recommendations'
  const result = middleTruncate(name, 24, monospace)
  assert.ok(monospace(result) <= 24)
  assert.ok(result.endsWith('endations'), `expected the real tail, got ${result}`)
})

test('exactly one ellipsis, always', () => {
  const name = 'Board_pack_2026_03_final_v7_signed.pdf'
  for (const width of [18, 24, 30]) {
    const result = middleTruncate(name, width, monospace)
    assert.equal(result.split('…').length - 1, 1, `${result} has more than one ellipsis`)
  }
})

test('a zero-width or unmeasured cell returns the whole name', () => {
  // A row that has not been laid out yet must show the real name rather than
  // an ellipsis: the first paint is what a person reads.
  assert.equal(middleTruncate('Lease.pdf', 0, monospace), 'Lease.pdf')
})
