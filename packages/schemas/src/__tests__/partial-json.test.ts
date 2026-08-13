import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createPartialJsonScanner } from '../partial-json.js'

/** Feed a JSON string one character at a time — the worst realistic chunking. */
const scanCharByChar = (json: string, key = 'markdown') => {
  const scanner = createPartialJsonScanner(key)
  const prefixes: string[] = []
  for (const char of json) {
    scanner.push(char)
    prefixes.push(scanner.committed())
  }
  return { prefixes, scanner }
}

test('extracts a top-level string field split across arbitrary chunks', () => {
  const scanner = createPartialJsonScanner('markdown')
  scanner.push('{"title":"Notes","mark')
  scanner.push('down":"# Hea')
  scanner.push('ding\\n\\nBody."}')
  assert.equal(scanner.committed(), '# Heading\n\nBody.')
  assert.equal(scanner.isComplete(), true)
  assert.equal(scanner.error(), null)
})

test('every intermediate read is a prefix of the final value', () => {
  const json = JSON.stringify({
    spaceId: 'a-space',
    title: 'T',
    markdown: 'a\nb "quoted" \\ backslash\ttab é 😀 done',
  })
  const { prefixes, scanner } = scanCharByChar(json)
  const final = scanner.committed()
  for (const prefix of prefixes) {
    assert.equal(final.startsWith(prefix), true, `not a prefix: ${JSON.stringify(prefix)}`)
  }
  assert.equal(final, 'a\nb "quoted" \\ backslash\ttab é 😀 done')
})

test('never emits a half-written escape', () => {
  const scanner = createPartialJsonScanner('markdown')
  scanner.push('{"markdown":"line')
  assert.equal(scanner.committed(), 'line')
  scanner.push('\\')
  // The backslash alone is not yet anything — emitting it would break the prefix.
  assert.equal(scanner.committed(), 'line')
  scanner.push('n')
  assert.equal(scanner.committed(), 'line\n')
})

test('never emits a partial \\u escape', () => {
  const scanner = createPartialJsonScanner('markdown')
  scanner.push('{"markdown":"x\\u00')
  assert.equal(scanner.committed(), 'x')
  scanner.push('e9')
  assert.equal(scanner.committed(), 'xé')
})

test('holds back a lone high surrogate until its pair arrives', () => {
  const scanner = createPartialJsonScanner('markdown')
  scanner.push('{"markdown":"go \\ud83d')
  // A lone high surrogate is not a renderable prefix.
  assert.equal(scanner.committed(), 'go ')
  scanner.push('\\ude00 ok')
  assert.equal(scanner.committed(), 'go 😀 ok')
})

test('holds back a raw surrogate split across chunk boundaries', () => {
  const emoji = '😀'
  const scanner = createPartialJsonScanner('markdown')
  scanner.push(`{"markdown":"hi ${emoji[0]}`)
  assert.equal(scanner.committed(), 'hi ')
  scanner.push(`${emoji[1]}!"}`)
  assert.equal(scanner.committed(), `hi ${emoji}!`)
})

test('rejects a duplicate top-level target key', () => {
  const scanner = createPartialJsonScanner('markdown')
  scanner.push('{"markdown":"first","markdown":"second"}')
  assert.notEqual(scanner.error(), null)
  assert.match(scanner.error() ?? '', /Duplicate/)
})

test('ignores the key name appearing inside another value', () => {
  const scanner = createPartialJsonScanner('markdown')
  scanner.push('{"title":"a \\"markdown\\": trap","markdown":"real"}')
  assert.equal(scanner.error(), null)
  assert.equal(scanner.committed(), 'real')
})

test('ignores a same-named key nested inside an object value', () => {
  const scanner = createPartialJsonScanner('markdown')
  scanner.push('{"meta":{"markdown":"nested"},"markdown":"top"}')
  assert.equal(scanner.error(), null)
  assert.equal(scanner.committed(), 'top')
})

test('ignores a same-named key nested inside an array of objects', () => {
  const scanner = createPartialJsonScanner('markdown')
  scanner.push('{"items":[{"markdown":"n1"},{"markdown":"n2"}],"markdown":"top"}')
  assert.equal(scanner.error(), null)
  assert.equal(scanner.committed(), 'top')
})

test('an absent target key yields nothing and no error', () => {
  const scanner = createPartialJsonScanner('markdown')
  scanner.push('{"title":"only a title"}')
  assert.equal(scanner.committed(), '')
  assert.equal(scanner.isComplete(), false)
  assert.equal(scanner.error(), null)
})

test('exposes completed sibling scalars for early metadata', () => {
  const scanner = createPartialJsonScanner('markdown')
  scanner.push('{"spaceId":"space-1","title":"Weekly notes","markdown":"body')
  const fields = scanner.fields()
  assert.equal(fields.spaceId, 'space-1')
  assert.equal(fields.title, 'Weekly notes')
  // The streaming field itself never lands in `fields`.
  assert.equal(fields.markdown, undefined)
})

test('handles non-English content and slang unchanged', () => {
  const body = 'Ahoj! Тест — ça marche, ¿verdad? 大丈夫だよ 🙌'
  const json = JSON.stringify({ title: 'Přehled', markdown: body })
  const { scanner } = scanCharByChar(json)
  assert.equal(scanner.committed(), body)
})

test('closing the string marks the field complete without extra output', () => {
  const scanner = createPartialJsonScanner('markdown')
  scanner.push('{"markdown":"done"}')
  assert.equal(scanner.isComplete(), true)
  scanner.push('{"markdown":"ignored"}')
  assert.equal(scanner.committed(), 'done')
})

test('the committed value matches JSON.parse for the finished document', () => {
  const body = '# Title\n\n```ts\nconst x = "y";\n```\n\n- a\n- b\n\n> quote "inner" \\ end'
  const json = JSON.stringify({ spaceId: 's', title: 't', markdown: body })
  const { scanner } = scanCharByChar(json)
  assert.equal(scanner.committed(), (JSON.parse(json) as { markdown: string }).markdown)
})
