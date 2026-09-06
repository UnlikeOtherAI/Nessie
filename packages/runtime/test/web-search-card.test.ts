import assert from 'node:assert/strict'
import test from 'node:test'

import { renderWebSearchCardPlainText, toWebSearchCard } from '../src/web-search-card.js'
import type { WebSearchOutput } from '../src/web-search.js'

const output = (overrides: Partial<WebSearchOutput> = {}): WebSearchOutput => ({
  provider: 'serper',
  query: 'nessie sightings',
  page: 2,
  count: 5,
  answer: 'A long-standing local legend.',
  answerSource: { title: 'Loch Ness', url: 'https://example.com/loch' },
  knowledgePanel: { title: 'Loch Ness Monster', description: 'A cryptid.' },
  results: [
    {
      position: 1,
      title: 'First',
      url: 'https://example.com/one',
      snippet: 'A snippet.',
      source: 'example.com',
      date: '2 days ago',
    },
  ],
  related: ['loch ness webcam'],
  hasMore: true,
  text: 'unused by the card',
  ...overrides,
})

test('the card is built from the provider response, field for field', () => {
  const card = toWebSearchCard(output())

  assert.equal(card.schemaVersion, 1)
  assert.equal(card.provider, 'serper')
  assert.equal(card.page, 2)
  assert.equal(card.hasMore, true)
  assert.deepEqual(card.results[0], {
    position: 1,
    title: 'First',
    url: 'https://example.com/one',
    snippet: 'A snippet.',
    source: 'example.com',
    date: '2 days ago',
  })
  assert.deepEqual(card.related, ['loch ness webcam'])
})

test('a result link that is not http(s) is refused rather than rendered', () => {
  assert.throws(() =>
    toWebSearchCard(
      output({
        results: [
          {
            position: 1,
            title: 'Hostile',
            // eslint-disable-next-line no-script-url
            url: 'javascript:alert(1)',
            snippet: '',
          },
        ],
      }),
    ))
})

test('an empty page still produces a card, so the pager stays reachable', () => {
  const card = toWebSearchCard(
    output({ answer: null, answerSource: null, knowledgePanel: null, related: [], results: [], hasMore: false }),
  )
  assert.deepEqual(card.results, [])
  assert.equal(card.answer, undefined)
  assert.match(renderWebSearchCardPlainText(card), /No results\./)
})

test('the plain text says what the card shows, for every client that is not the card', () => {
  const text = renderWebSearchCardPlainText(toWebSearchCard(output()))

  assert.match(text, /Web results for “nessie sightings” \(page 2\)/)
  assert.match(text, /A long-standing local legend\./)
  assert.match(text, /1\. First — https:\/\/example\.com\/one/)
})
