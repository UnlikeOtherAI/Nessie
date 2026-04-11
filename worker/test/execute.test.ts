import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildMemoryContext,
  detectReferencedRecallIds,
  stripLeadingSectionTag,
} from '../src/run/execute.js'

test('buildMemoryContext formats retrieved memories for prompt injection', () => {
  const context = buildMemoryContext([
    {
      content: 'Phone verification is required for KYC compliance in regulated markets.',
      recallId: 'recall-1',
    },
    {
      content: 'The deploy pipeline uses GitHub Actions for production releases.',
      recallId: 'recall-2',
    },
  ])

  assert.equal(
    context,
    [
      'Relevant long-term memories:',
      '1. Phone verification is required for KYC compliance in regulated markets.',
      '2. The deploy pipeline uses GitHub Actions for production releases.',
    ].join('\n'),
  )
})

test('detectReferencedRecallIds marks memories whose phrases appear in the response', () => {
  const recallIds = detectReferencedRecallIds(
    'We need phone verification because it is required for KYC compliance in regulated markets.',
    [
      {
        content: 'Phone verification is required for KYC compliance in regulated markets.',
        recallId: 'recall-1',
      },
      {
        content: 'The deploy pipeline uses GitHub Actions for production releases.',
        recallId: 'recall-2',
      },
    ],
  )

  assert.deepEqual(recallIds, ['recall-1'])
})

test('detectReferencedRecallIds ignores unrelated memories', () => {
  const recallIds = detectReferencedRecallIds(
    'Let us focus on the deployment checklist for this release.',
    [
      {
        content: 'Phone verification is required for KYC compliance in regulated markets.',
        recallId: 'recall-1',
      },
    ],
  )

  assert.deepEqual(recallIds, [])
})

test('stripLeadingSectionTag removes bracketed section labels from the start of a reply', () => {
  assert.equal(
    stripLeadingSectionTag('[Scene] The tavern is dim and smoky.'),
    'The tavern is dim and smoky.',
  )
  assert.equal(stripLeadingSectionTag('  [Setting]\nA moonlit road.'), 'A moonlit road.')
  assert.equal(stripLeadingSectionTag('[OOC] quick check — is this right?'), 'quick check — is this right?')
  assert.equal(stripLeadingSectionTag('[Narrator] You wake up.'), 'You wake up.')
})

test('stripLeadingSectionTag leaves mid-prose brackets and non-label content alone', () => {
  assert.equal(
    stripLeadingSectionTag('The value is [ok] but needs review.'),
    'The value is [ok] but needs review.',
  )
  assert.equal(
    stripLeadingSectionTag('[Note: remember to verify] before sending.'),
    '[Note: remember to verify] before sending.',
  )
  assert.equal(stripLeadingSectionTag('No label here, just a direct answer.'), 'No label here, just a direct answer.')
})
