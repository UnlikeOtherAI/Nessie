import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { MessageMarkdown } from '../src/components/features/channels/MessageMarkdown.js'

/**
 * `resolveAttachmentImages` swaps exactly one image form — the inline
 * attachment path — for the authed component, and nothing else. The authed
 * component renders its loading box on the server pass (no effect has run),
 * which is what these assertions read: the API path appears only as a data
 * attribute, never as an `<img src>`.
 */

const ID = '22222222-2222-4222-8222-222222222222'
const PATH = `/api/attachments/${ID}`

const render = (markdown: string, props: { allowRemoteImages?: boolean; resolveAttachmentImages?: boolean } = {}) =>
  renderToStaticMarkup(
    createElement(MessageMarkdown, { renderInlineText: (text: string) => text, ...props }, markdown),
  )

test('an inline attachment image is resolved through the authed component', () => {
  const html = render(`![shot](${PATH})`, { resolveAttachmentImages: true })
  assert.match(html, new RegExp(`data-attachment-src="${PATH}"`))
  assert.match(html, /class="admin-attachment-image-loading"/)
  assert.match(html, /aria-label="shot"/)
  assert.doesNotMatch(html, /<img[^>]*src="\/api\/attachments/, 'the API path never becomes an <img src>')
})

test('any other image renders exactly as it does without the prop', () => {
  for (const markdown of [
    '![remote](https://example.com/pic.png)',
    '![thumb](/api/attachments/22222222-2222-4222-8222-222222222222/thumbnail)',
    '![other](/api/files/abc)',
  ]) {
    assert.equal(render(markdown, { resolveAttachmentImages: true }), render(markdown), markdown)
    assert.doesNotMatch(render(markdown, { resolveAttachmentImages: true }), /data-attachment-src/)
  }
})

test('off by default: an attachment path stays today’s plain image', () => {
  const html = render(`![shot](${PATH})`)
  assert.match(html, new RegExp(`<img src="${PATH}" alt="shot"/>`))
  assert.doesNotMatch(html, /data-attachment-src/)
})

test('with remote images blocked, the attachment still resolves and the remote one stays inert', () => {
  const html = render(`![shot](${PATH})\n\n![beacon](https://attacker.example/b.png)`, {
    allowRemoteImages: false,
    resolveAttachmentImages: true,
  })
  assert.match(html, new RegExp(`data-attachment-src="${PATH}"`))
  assert.match(html, /data-testid="blocked-remote-image"/)
  assert.doesNotMatch(html, /attacker\.example/)
})
