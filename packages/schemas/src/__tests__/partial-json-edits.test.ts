import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createPartialJsonEditScanner } from '../partial-json.js'

const feedCharByChar = (json: string) => {
  const scanner = createPartialJsonEditScanner()
  for (const char of json) scanner.push(char)
  return scanner
}

test('reads a streaming edits array in order', () => {
  const scanner = createPartialJsonEditScanner()
  scanner.push('{"pageId":"p1","edits":[{"find":"old text","replace":"new ')
  let edits = scanner.edits()
  assert.equal(edits.length, 1)
  assert.equal(edits[0]?.find, 'old text')
  assert.equal(edits[0]?.replace, 'new ')
  assert.equal(edits[0]?.replaceComplete, false)

  scanner.push('text"},{"find":"second","replace":"other"}]}')
  edits = scanner.edits()
  assert.equal(edits.length, 2)
  assert.equal(edits[0]?.replace, 'new text')
  assert.equal(edits[0]?.replaceComplete, true)
  assert.equal(edits[1]?.find, 'second')
  assert.equal(edits[1]?.replace, 'other')
  assert.equal(scanner.error(), null)
})

test('the anchor is readable before its replacement starts arriving', () => {
  const scanner = createPartialJsonEditScanner()
  scanner.push('{"edits":[{"find":"## Numbers","replace":"')
  const edit = scanner.edits()[0]
  // This is what lets the viewer jump to the edit site before any new text
  // exists to show there.
  assert.equal(edit?.find, '## Numbers')
  assert.equal(edit?.replace, '')
})

test('replacement text is a committed prefix at every step', () => {
  const body = 'line one\nline "two" \\ three é 😀'
  const json = JSON.stringify({ edits: [{ find: 'anchor', replace: body }] })
  const scanner = createPartialJsonEditScanner()
  const prefixes: string[] = []
  for (const char of json) {
    scanner.push(char)
    prefixes.push(scanner.edits()[0]?.replace ?? '')
  }
  const final = scanner.edits()[0]?.replace ?? ''
  assert.equal(final, body)
  for (const prefix of prefixes) {
    assert.equal(final.startsWith(prefix), true, `not a prefix: ${JSON.stringify(prefix)}`)
  }
})

test('holds back a lone high surrogate in a replacement', () => {
  const scanner = createPartialJsonEditScanner()
  scanner.push('{"edits":[{"find":"a","replace":"hi \\ud83d')
  assert.equal(scanner.edits()[0]?.replace, 'hi ')
  scanner.push('\\ude00"}]}')
  assert.equal(scanner.edits()[0]?.replace, 'hi 😀')
})

test('exposes top-level scalars such as pageId', () => {
  const scanner = createPartialJsonEditScanner()
  scanner.push('{"pageId":"page-123","changeComment":"tighten intro","edits":[{"find":"x"')
  assert.equal(scanner.fields().pageId, 'page-123')
  assert.equal(scanner.fields().changeComment, 'tighten intro')
})

test('ignores same-named keys nested deeper than an edit entry', () => {
  const scanner = createPartialJsonEditScanner()
  scanner.push('{"edits":[{"find":"a","replace":"b","meta":{"find":"trap","replace":"trap"}}]}')
  const edits = scanner.edits()
  assert.equal(edits.length, 1)
  assert.equal(edits[0]?.find, 'a')
  assert.equal(edits[0]?.replace, 'b')
})

test('an empty replacement is a deletion, not a missing value', () => {
  const scanner = feedCharByChar('{"edits":[{"find":"remove me\\n","replace":""}]}')
  const edit = scanner.edits()[0]
  assert.equal(edit?.find, 'remove me\n')
  assert.equal(edit?.replace, '')
  assert.equal(edit?.replaceComplete, true)
})

test('matches JSON.parse once the arguments are complete', () => {
  const payload = {
    pageId: 'p9',
    edits: [
      { find: '## Old heading', replace: '## New heading' },
      { find: 'Díky', replace: 'Děkuji — 完了 🎉' },
    ],
  }
  const scanner = feedCharByChar(JSON.stringify(payload))
  const edits = scanner.edits()
  assert.equal(edits.length, 2)
  edits.forEach((edit, index) => {
    assert.equal(edit.find, payload.edits[index]!.find)
    assert.equal(edit.replace, payload.edits[index]!.replace)
    assert.equal(edit.replaceComplete, true)
  })
})
