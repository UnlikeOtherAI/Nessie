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
