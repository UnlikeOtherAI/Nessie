import assert from 'node:assert/strict'
import test from 'node:test'

import { buildResearchRoutingBlock } from './research-routing.js'

const facts = (over: Partial<Parameters<typeof buildResearchRoutingBlock>[0]> = {}) => ({
  hasDelegate: false,
  hasResearchTools: false,
  hasWebSearch: false,
  isHandoffTurn: false,
  ...over,
})

test('granted research tools route deep work to DeepWater, with consent first', () => {
  const block = buildResearchRoutingBlock(facts({ hasResearchTools: true, hasWebSearch: true }))
  assert.ok(block)
  assert.match(block, /mcp_research_start/)
  assert.match(block, /go-ahead in this thread/)
  assert.match(block, /already agreed — or already declined/)
  // Quick lookups still go straight to search.
  assert.match(block, /web_search directly/)
})

test('without research tools the agent researches itself and fans out via delegate', () => {
  const withDelegate = buildResearchRoutingBlock(
    facts({ hasDelegate: true, hasWebSearch: true }),
  )
  assert.ok(withDelegate)
  assert.doesNotMatch(withDelegate, /mcp_research_start/)
  assert.match(withDelegate, /fan the search out with delegate/)
  assert.match(withDelegate, /gap in your coverage, not a source/)

  const withoutDelegate = buildResearchRoutingBlock(facts({ hasWebSearch: true }))
  assert.ok(withoutDelegate)
  assert.doesNotMatch(withoutDelegate, /delegate/)
})

test('a DeepWater launch turn gets no routing block at all', () => {
  assert.equal(
    buildResearchRoutingBlock(
      facts({ hasDelegate: true, hasResearchTools: true, hasWebSearch: true, isHandoffTurn: true }),
    ),
    null,
  )
})

test('no research capability means no block — never an upsell for ungranted DeepWater', () => {
  assert.equal(buildResearchRoutingBlock(facts()), null)
  assert.equal(buildResearchRoutingBlock(facts({ hasDelegate: true })), null)
})

test('exactly one block is produced for any combination of facts', () => {
  for (const hasResearchTools of [false, true]) {
    for (const hasWebSearch of [false, true]) {
      for (const hasDelegate of [false, true]) {
        const block = buildResearchRoutingBlock(
          facts({ hasDelegate, hasResearchTools, hasWebSearch }),
        )
        if (!block) continue
        assert.equal(
          block.split('Research routing:').length - 1,
          1,
          'expected exactly one routing block',
        )
      }
    }
  }
})
