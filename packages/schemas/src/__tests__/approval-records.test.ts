import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APPROVAL_ACTION_VALUES,
  APPROVAL_ACTIONS,
  APPROVAL_EFFECT_ACTIONS,
  ApprovalGateMetadataSchema,
  EFFECT_FREE_APPROVAL_ACTIONS,
} from '../approval-records.js'

// The approval `action` was once free text spelled out per construction site,
// with a silent default in the effect dispatcher swallowing anything
// misspelled. The vocabulary is now closed, and these pin the rules the
// dispatch relies on.

test('every action belongs to exactly one of the effect and effect-free sets', () => {
  const partition = [...APPROVAL_EFFECT_ACTIONS, ...EFFECT_FREE_APPROVAL_ACTIONS]
  assert.deepEqual(
    new Set(partition),
    new Set(APPROVAL_ACTION_VALUES),
    'an action missing from both sets would fall into the loud unrecognised branch',
  )
  assert.equal(
    partition.length,
    new Set(partition).size,
    'an action in both sets would be dispatched AND excused from dispatch',
  )
})

test('an approval card accepts a known action and refuses an invented one', () => {
  const base = {
    action: APPROVAL_ACTIONS.knowledgePagePublish,
    approvalId: 'approval-1',
    status: 'pending' as const,
  }
  assert.ok(ApprovalGateMetadataSchema.safeParse(base).success)

  // The card is what the effect dispatch and the admin render from, so the
  // typo that used to die silently in `default: return {}` must not parse
  // here either.
  const typo = ApprovalGateMetadataSchema.safeParse({
    ...base,
    action: 'knowledge.page.publsh',
  })
  assert.equal(typo.success, false)
})

test('no two names map to the same action string', () => {
  const values = Object.values(APPROVAL_ACTIONS)
  assert.equal(new Set(values).size, values.length)
})
