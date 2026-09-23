import assert from 'node:assert/strict'
import test from 'node:test'

import { buildResearchRoutingBlock, type ResearchRoutingFacts } from './research-routing.js'

const BRIEF_TOOLS = [
  'research_scope_start',
  'research_scope_reply',
  'research_scope_get',
  'research_scope_launch',
  'research_status',
  'research_report',
  'research_cancel',
  'research_list',
]
const LAUNCHER_TOOLS = ['research_start', 'research_status', 'research_report', 'research_list', 'research_cancel']

const facts = (over: Partial<ResearchRoutingFacts> = {}): ResearchRoutingFacts => ({
  hasDelegate: false,
  researchTools: new Set(),
  hasCardPost: false,
  hasWebSearch: false,
  isHandoffTurn: false,
  ...over,
})

test('the brief contract routes deep work to a DeepWater brief, with consent first', () => {
  const block = buildResearchRoutingBlock(facts({
    researchTools: new Set(BRIEF_TOOLS),
    hasCardPost: true,
    hasWebSearch: true,
  }))
  assert.ok(block)
  assert.match(block, /mcp_research_scope_start/)
  assert.match(block, /go-ahead in this thread/)
  assert.match(block, /already agreed — or already declined/)
  // The planner answers by waking the agent; it never waits or polls.
  assert.match(block, /woken in this thread/)
  assert.match(block, /Do not poll/)
  assert.match(block, /include_transcript only/)
  assert.match(block, /card_post and wait: true only for questions only they can answer/)
  assert.match(block, /mcp_research_scope_launch at the brief's current revision/)
  assert.match(block, /Never start a second research/)
  // N7: a refusal in a private conversation hands the person the Research button.
  assert.match(block, /refused because this conversation is private, do not retry/)
  assert.match(block, /Research button in this chat/)
  assert.match(block, /web_search directly/)
  assert.doesNotMatch(block, /mcp_research_start\b/)
})

test('the brief block names only the tools this run was given', () => {
  const block = buildResearchRoutingBlock(facts({ researchTools: new Set(['research_scope_start']) }))
  assert.ok(block)
  assert.doesNotMatch(block, /card_post/)
  assert.doesNotMatch(block, /mcp_research_scope_launch/)
  assert.doesNotMatch(block, /mcp_research_scope_get/)
  assert.doesNotMatch(block, /mcp_research_status/)
  assert.doesNotMatch(block, /web_search/)
})

test('a team still on the launcher contract keeps the launcher routing', () => {
  const block = buildResearchRoutingBlock(facts({ researchTools: new Set(LAUNCHER_TOOLS), hasWebSearch: true }))
  assert.ok(block)
  assert.match(block, /mcp_research_start/)
  assert.doesNotMatch(block, /mcp_research_scope_start/)
})

test('without research tools the agent researches itself and fans out via delegate', () => {
  const withDelegate = buildResearchRoutingBlock(
    facts({ hasDelegate: true, hasWebSearch: true }),
  )
  assert.ok(withDelegate)
  assert.doesNotMatch(withDelegate, /mcp_research/)
  assert.match(withDelegate, /Default to delegate for discovery/)
  assert.match(withDelegate, /keep only the digests/)
  assert.match(withDelegate, /gap in your coverage, not a source/)

  const withoutDelegate = buildResearchRoutingBlock(facts({ hasWebSearch: true }))
  assert.ok(withoutDelegate)
  assert.doesNotMatch(withoutDelegate, /delegate/)
})

test('a DeepWater launch turn gets no routing block at all', () => {
  assert.equal(
    buildResearchRoutingBlock(facts({
      hasDelegate: true,
      researchTools: new Set(LAUNCHER_TOOLS),
      hasWebSearch: true,
      isHandoffTurn: true,
    })),
    null,
  )
})

test('no research capability means no block — never an upsell for ungranted DeepWater', () => {
  assert.equal(buildResearchRoutingBlock(facts()), null)
  assert.equal(buildResearchRoutingBlock(facts({ hasDelegate: true })), null)
})

test('exactly one block is produced for any combination of facts', () => {
  for (const researchTools of [new Set<string>(), new Set(BRIEF_TOOLS), new Set(LAUNCHER_TOOLS)]) {
    for (const hasWebSearch of [false, true]) {
      for (const hasDelegate of [false, true]) {
        const block = buildResearchRoutingBlock(facts({ hasDelegate, researchTools, hasWebSearch }))
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
