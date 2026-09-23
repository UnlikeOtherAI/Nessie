import assert from 'node:assert/strict'
import test from 'node:test'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { RestrictedMessageCard } from '../src/components/features/channels/RestrictedMessageCard'

const renderCard = (mode: 'shareable' | 'withheld'): string =>
  renderToStaticMarkup(createElement(RestrictedMessageCard, {
    allowStanding: false,
    expectedContent: 'private-source answer',
    messageId: 'message-1',
    mode,
    onShare: async () => undefined,
  }))

test('a shareable reply describes reader access rather than channel membership', () => {
  const markup = renderCard('shareable')

  assert.match(
    markup,
    /sources that aren’t available to everyone who can read this channel/,
  )
  assert.doesNotMatch(markup, /sources that aren’t shared with everyone in this channel/)
  assert.match(markup, /Share this reply/)
})

test('a withheld reply keeps its reader-specific privacy explanation', () => {
  const markup = renderCard('withheld')

  assert.match(markup, /sources you don’t have access to/)
  assert.doesNotMatch(markup, /Share this reply/)
})
