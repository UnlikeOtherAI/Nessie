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
    { end: 12, kind: 'inline', start: 4 },
    { end: 35, kind: 'block', start: 17 },
  ])
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
