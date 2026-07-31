import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { MessageMarkdown } from '../src/components/features/channels/MessageMarkdown.js'

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

test('renders mentions in prose without changing code literals', () => {
  const html = renderMarkdown('Hello @Ada. Use `@Ada` in the example.', (text) =>
    text.includes('@Ada')
      ? createElement('span', { className: 'mention-tag' }, text)
      : text,
  )

  assert.equal((html.match(/class="mention-tag"/g) ?? []).length, 1)
  assert.match(html, /<code class="admin-message-code">@Ada<\/code>/)
})
