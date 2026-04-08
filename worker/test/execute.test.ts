import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildMemoryContext,
  detectReferencedRecallIds,
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
