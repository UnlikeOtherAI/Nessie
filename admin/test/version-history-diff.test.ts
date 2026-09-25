import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
Object.assign(globalThis, {
  DOMParser: dom.window.DOMParser,
  Node: dom.window.Node,
})

const { buildVersionDiff, richTextToTokens } = await import(
  '../src/components/features/knowledge/version-history-diff.js'
)

test('diff marks added and removed words while keeping unchanged words neutral', () => {
  const diff = buildVersionDiff('<p>Keep old</p>', '<p>Keep new</p>')
  assert.deepEqual(
    diff.filter((operation) => operation.change !== 'same').map((operation) => [
      operation.change,
      operation.oldToken?.text,
      operation.newToken?.text,
    ]),
    [
      ['removed', 'old', undefined],
      ['added', undefined, 'new'],
    ],
  )
  assert.equal(diff[0]?.change, 'same')
})

test('diff identifies a formatting-only change', () => {
  const diff = buildVersionDiff('<p>A <strong>bold</strong> word</p>', '<p>A bold word</p>')
  assert.equal(diff.find((operation) => operation.oldToken?.text === 'bold')?.change, 'format')
})

test('parses visible text but drops executable and hidden HTML content', () => {
  const tokens = richTextToTokens(
    '<p>Safe &amp; sound</p><script>alert(1)</script><style>.x{}</style><iframe>hidden</iframe>',
  )
  assert.equal(tokens.map((token) => token.text).join(''), 'Safe & sound')
})
