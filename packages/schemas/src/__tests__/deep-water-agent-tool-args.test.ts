import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DeepWaterBriefInputSchema,
  DeepWaterResearchRunListSchema,
  DeepWaterScopeStartToolArgsSchema,
  IntegratedProductResponseSchema,
  deepWaterToolAsksToPublish,
  deepWaterToolEditsBrief,
  deepWaterToolResearchId,
  toLedgerBriefSettings,
} from '../index.js'

test('an agent scope start in Ledger wire vocabulary becomes the stored brief input', () => {
  const parsed = DeepWaterScopeStartToolArgsSchema.parse({
    topic: 'Heat pumps in older houses',
    context: '  Victorian terraces only.  ',
    pillars: ['Costs', 'Performance'],
    settings: { depth: 'deep', chapter_depth: 'detailed', languages: ['cs'] },
  })
  assert.deepEqual(parsed, {
    topic: 'Heat pumps in older houses',
    context: 'Victorian terraces only.',
    pillars: ['Costs', 'Performance'],
    settings: { depth: 'deep', chapterDepth: 'detailed', languages: ['cs'] },
  })
  // The stored input round-trips to the exact wire settings a replay sends.
  assert.deepEqual(toLedgerBriefSettings(parsed.settings ?? {}), {
    depth: 'deep',
    chapter_depth: 'detailed',
    languages: ['cs'],
  })
  assert.ok(DeepWaterBriefInputSchema.safeParse({ schemaVersion: 1, ...parsed, originRootMessageId: null }).success)
})

test('blank background and an empty settings object seed nothing', () => {
  const parsed = DeepWaterScopeStartToolArgsSchema.parse({ topic: 'Heat pumps', context: '   ', settings: {} })
  assert.equal(parsed.context, null)
  assert.equal(parsed.settings, null)
  assert.equal(parsed.pillars, null)
})

test('arguments outside Ledger\'s contract are refused before any claim', () => {
  assert.equal(DeepWaterScopeStartToolArgsSchema.safeParse({ topic: 'ok' }).success, false)
  assert.equal(DeepWaterScopeStartToolArgsSchema.safeParse({ topic: 'Heat pumps', title: 'x' }).success, false)
  assert.equal(
    DeepWaterScopeStartToolArgsSchema.safeParse({ topic: 'Heat pumps', settings: { depth: 'thesis' } }).success,
    false,
  )
  assert.equal(
    DeepWaterScopeStartToolArgsSchema.safeParse({ topic: 'Heat pumps', settings: { chapterDepth: 'brief' } }).success,
    false,
  )
})

test('structural facts of a bound call: its research id, whether it edits, whether it publishes', () => {
  assert.equal(deepWaterToolResearchId({ id: 'rs_abc' }), 'rs_abc')
  assert.equal(deepWaterToolResearchId({ id: '' }), null)
  assert.equal(deepWaterToolResearchId({}), null)
  assert.equal(deepWaterToolEditsBrief({ id: 'rs_abc', revision: 2 }), false)
  assert.equal(deepWaterToolEditsBrief({ id: 'rs_abc', revision: 2, pillars: ['A'] }), true)
  assert.equal(deepWaterToolEditsBrief({ id: 'rs_abc', revision: 2, settings: { depth: null } }), true)
  assert.equal(deepWaterToolAsksToPublish({ id: 'rs_abc', public: true }), true)
  assert.equal(deepWaterToolAsksToPublish({ id: 'rs_abc', public: false }), false)
})

test('the run list carries its page metadata beside the items', () => {
  const list = DeepWaterResearchRunListSchema.parse({
    items: [],
    meta: { hasMore: false, nextCursor: null, prevCursor: null },
  })
  assert.deepEqual(list.items, [])
  assert.equal(DeepWaterResearchRunListSchema.safeParse({ items: [] }).success, false)
})

test('readiness rides only on the deep-water product entry', () => {
  const base = IntegratedProductResponseSchema.shape
  assert.ok(base.research.isOptional())
  const readiness = base.research.parse({ state: 'account_not_linked', viewerCanChangeTeam: false })
  assert.deepEqual(readiness, { state: 'account_not_linked', viewerCanChangeTeam: false })
  assert.equal(base.research.safeParse({ state: 'maybe', viewerCanChangeTeam: false }).success, false)
})
