import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { GmailUnsupportedDraftPanel } from '../src/components/features/connected-mail/GmailUnsupportedDraftPanel.js'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

test('an unsupported Gmail draft names its attachment and opens Gmail instead of Send', () => {
  const html = renderToStaticMarkup(createElement(GmailUnsupportedDraftPanel, {
    attachments: [{ filename: 'contract.pdf', mimeType: 'application/pdf', sizeBytes: 12 }],
    reason: 'attachments',
  }))

  assert.match(html, /contract\.pdf/)
  assert.match(html, /Open Gmail to send this draft/)
  assert.match(html, /https:\/\/mail\.google\.com\/mail\/u\/0\/#drafts/)
  assert.doesNotMatch(html, /Send email/)
})
