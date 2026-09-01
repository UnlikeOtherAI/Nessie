import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { MessageMarkdown } from '../src/components/features/channels/MessageMarkdown.js'
import {
  findMarkdownCodeRanges,
  normalizeMessageMarkdown,
} from '../src/lib/message-markdown.js'

const renderMarkdown = (
  content: string,
  renderInlineText: (text: string) => React.ReactNode = (text) => text,
): string =>
  renderToStaticMarkup(
    createElement(MessageMarkdown, { renderInlineText }, content),
  )

test('renders human and agent post formatting as GitHub-flavoured Markdown', () => {
  const html = renderMarkdown([
    '## Release notes',
    '',
    '**Ready** for review.',
    '',
    '- one',
    '- two',
    '',
    '~~old~~',
  ].join('\n'))

  assert.match(html, /<h2>Release notes<\/h2>/)
  assert.match(html, /<strong>Ready<\/strong>/)
  assert.match(html, /<ul>/)
  assert.match(html, /<del>old<\/del>/)
})

test('gives Markdown tables an expandable, horizontally scrollable viewport', () => {
  const html = renderMarkdown([
    '| Prospect | Evidence |',
    '| --- | --- |',
    '| Amici Pizza | Multi-site restaurant |',
  ].join('\n'))

  assert.match(html, /aria-label="Expand Message table"/)
  assert.match(html, /class="admin-expandable-table__viewport"/)
  assert.match(html, /<table>/)
})

test('renders single-backtick code and triple-backtick fenced code', () => {
  const html = renderMarkdown([
    'Use `const ready = true`.',
    '',
    '```ts',
    'const answer = 42',
    '```',
  ].join('\n'))

  assert.match(html, /<code class="admin-message-code">const ready = true<\/code>/)
  assert.match(html, /<pre class="admin-message-code-block" tabindex="0">/)
  assert.match(html, /class="language-ts admin-message-code"/)
  assert.match(html, /const answer = 42/)
})

test('turns inline-position triple backticks into a newline-preserving block', () => {
  const source = 'hey ```is it done\nbi?```?'
  const normalized = normalizeMessageMarkdown(source)
  const html = renderMarkdown(source)

  assert.equal(normalized, 'hey \n\n```\nis it done\nbi?\n```\n\n?')
  assert.match(html, /<p>hey<\/p>/)
  assert.ok(html.includes('is it done\nbi?\n</code></pre>'))
  assert.match(html, /<p>\?<\/p>/)
})

test('finds live-editor inline and multiline code ranges', () => {
  const source = 'one `inline` two ```first\nsecond``` end'

  assert.deepEqual(findMarkdownCodeRanges(source), [
    { contentEnd: 11, contentStart: 5, end: 12, kind: 'inline', start: 4 },
    { contentEnd: 32, contentStart: 20, end: 35, kind: 'block', start: 17 },
  ])
})

test('reports the delimiters of a fence the author has not closed yet', () => {
  assert.deepEqual(findMarkdownCodeRanges('```typing'), [
    { contentEnd: 9, contentStart: 3, end: 9, kind: 'block', start: 0 },
  ])
  assert.deepEqual(findMarkdownCodeRanges('```'), [
    { contentEnd: 3, contentStart: 3, end: 3, kind: 'block', start: 0 },
  ])
})

test('keeps every word of a fence the author never closed', () => {
  const source = '```is it doneoi?'
  const html = renderMarkdown(source)

  assert.equal(normalizeMessageMarkdown(source), '\n```\nis it doneoi?\n```\n')
  assert.ok(html.includes('is it doneoi?'))
  assert.match(html, /<pre class="admin-message-code-block"/)
})

test('closes an unterminated fence that opens mid-sentence', () => {
  const source = 'hey ```is it done\nbi?'

  assert.equal(normalizeMessageMarkdown(source), 'hey \n\n```\nis it done\nbi?\n```\n')
})

test('leaves an unterminated language-tagged block to standard Markdown', () => {
  const source = '```ts\nconst answer = 42'

  assert.equal(normalizeMessageMarkdown(source), source)
  assert.match(renderMarkdown(source), /class="language-ts admin-message-code"/)
})

test('leaves standard language-tagged fenced blocks unchanged', () => {
  const source = '```ts\nconst answer = 42\n```'

  assert.equal(normalizeMessageMarkdown(source), source)
})

test('renders mentions in prose without changing code literals', () => {
  const html = renderMarkdown('Hello @Ada. Use `@Ada` in the example.', (text) =>
    text.includes('@Ada')
      ? createElement('span', { className: 'mention-tag' }, text)
      : text,
  )

  assert.equal((html.match(/class="mention-tag"/g) ?? []).length, 1)
  assert.match(html, /<code class="admin-message-code">@Ada<\/code>/)
})
