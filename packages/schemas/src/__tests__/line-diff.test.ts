import assert from 'node:assert/strict'
import test from 'node:test'

import { computeLineDiff, htmlToLines, renderLineDiffHunks, textToLines } from '../line-diff.js'

test('an HTML body diffs as its block lines', () => {
  assert.deepEqual(htmlToLines('<p>One</p><p>Two &amp; three</p>'), ['One', 'Two & three'])
  assert.deepEqual(computeLineDiff(['a', 'b'], ['a', 'c']), [
    { type: 'equal', text: 'a' },
    { type: 'remove', text: 'b' },
    { type: 'add', text: 'c' },
  ])
})

test('plain text keeps its blank lines and ignores trailing whitespace', () => {
  assert.deepEqual(textToLines('one  \r\n\ntwo'), ['one', '', 'two'])
  assert.deepEqual(textToLines(null), [])
})

test('hunks carry two lines of context and merge changes that are close', () => {
  const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']
  const after = ['1', '2', '3', 'three and a half', '4', '5', '6', '7', '8', '9', '10', 'eleven', '12']
  const hunks = renderLineDiffHunks(computeLineDiff(before, after), { maxChars: 10_000 })
  assert.equal(hunks.added, 2)
  assert.equal(hunks.removed, 1)
  assert.equal(hunks.truncated, false)
  assert.equal(hunks.text, [
    '@@ -2,4 +2,5 @@',
    ' 2',
    ' 3',
    '+three and a half',
    ' 4',
    ' 5',
    '@@ -9,4 +10,4 @@',
    ' 9',
    ' 10',
    '-11',
    '+eleven',
    ' 12',
  ].join('\n'))
  // Two changes four lines apart share one hunk.
  const close = renderLineDiffHunks(computeLineDiff(['a', 'b', 'c', 'd', 'e', 'f'], ['A', 'b', 'c', 'd', 'e', 'F']), {
    maxChars: 10_000,
  })
  assert.equal(close.text.split('\n').filter((line) => line.startsWith('@@')).length, 1)
})

/** Every op in order: the old text is the equal and removed lines, the new text the equal and added ones. */
const replays = (ops: ReturnType<typeof computeLineDiff>, before: string[], after: string[]) => {
  assert.deepEqual(ops.filter((op) => op.type !== 'add').map((op) => op.text), before)
  assert.deepEqual(ops.filter((op) => op.type !== 'remove').map((op) => op.text), after)
}

test('a one-line edit in a long document is one line, however long the document', () => {
  const before = Array.from({ length: 2_100 }, (_, index) => `line ${index}`)
  const after = before.map((line, index) => (index === 1_000 ? `${line} edited` : line))
  const ops = computeLineDiff(before, after)
  replays(ops, before, after)
  const hunks = renderLineDiffHunks(ops, { maxChars: 12_000 })
  assert.deepEqual([hunks.added, hunks.removed, hunks.truncated], [1, 1, false])
  assert.equal(hunks.text, [
    '@@ -999,5 +999,5 @@', ' line 998', ' line 999', '-line 1000', '+line 1000 edited', ' line 1001', ' line 1002',
  ].join('\n'))
})

test('scattered edits in a long document stay those few lines', () => {
  const before = Array.from({ length: 2_400 }, (_, index) => `line ${index}`)
  const after = before.flatMap((line, index) =>
    index === 3 ? ['inserted'] : index === 1_200 ? [`${line} edited`] : index === 2_396 ? [line, 'appended'] : [line])
  const ops = computeLineDiff(before, after)
  replays(ops, before, after)
  const counts = (diff: typeof ops) =>
    [diff.filter((op) => op.type === 'add').length, diff.filter((op) => op.type === 'remove').length]
  assert.deepEqual(counts(ops), [3, 2])
  // Lines unique on both sides: the least diff is exactly what was dropped and what was added.
  let seed = 7
  const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648)
  const many = Array.from({ length: 3_000 }, (_, index) => `row ${index}`)
  const edited = many.filter(() => random() > 0.01)
  const dropped = many.length - edited.length
  for (let insert = 0; insert < 25; insert += 1) {
    edited.splice(Math.floor(random() * edited.length), 0, `new row ${insert}`)
  }
  const minimal = computeLineDiff(many, edited)
  replays(minimal, many, edited)
  assert.deepEqual(counts(minimal), [25, dropped])
  // Past what Myers keeps, the middle is still a correct diff, only a coarse one.
  const shuffled = before.map((_, index) => `other ${index}`)
  const coarse = computeLineDiff(before, shuffled)
  replays(coarse, before, shuffled)
})

test('an over-long line is clipped around its change, never dropped', () => {
  const head = 'x'.repeat(30_000)
  const before = ['Intro', `${head} the OLD wording ${'y'.repeat(5_000)}`, 'Outro']
  const after = ['Intro', `${head} the NEW wording ${'y'.repeat(5_000)}`, 'Outro']
  const hunks = renderLineDiffHunks(computeLineDiff(before, after), { maxChars: 4_000 })
  assert.equal(hunks.truncated, false)
  assert.ok(hunks.text.length <= 4_000)
  const lines = hunks.text.split('\n')
  const [removed, added] = [lines.find((line) => line.startsWith('-')), lines.find((line) => line.startsWith('+'))]
  assert.match(removed ?? '', /^-\[… \d+ characters\] x+ the OLD wording y+ \[\d+ more characters …\]$/)
  assert.match(added ?? '', /^\+\[… \d+ characters\] x+ the NEW wording y+ \[\d+ more characters …\]$/)
  assert.ok((removed ?? '').length <= 1_000 + 60, 'clipped to a quarter of the bound, plus its markers')
  assert.match(hunks.text, /\n Intro\n/, 'short lines are left whole')
})

test('hunks are cut at the bound, whole lines at a time, and say so', () => {
  const before = Array.from({ length: 400 }, (_, index) => `line ${index}`)
  const after = before.map((line) => `${line} changed`)
  const hunks = renderLineDiffHunks(computeLineDiff(before, after), { maxChars: 1_000 })
  assert.equal(hunks.truncated, true)
  assert.ok(hunks.text.length <= 1_000)
  assert.equal(hunks.added, 400)
  assert.ok(hunks.text.split('\n').every((line) => /^(@@|[ +-])/.test(line)))
  assert.equal(renderLineDiffHunks(computeLineDiff(['same'], ['same']), { maxChars: 100 }).text, '')
})
