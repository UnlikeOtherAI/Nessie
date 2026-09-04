import assert from 'node:assert/strict'
import test from 'node:test'

import { QueryClient } from '@tanstack/react-query'

import {
  emailApprovalReviewKey,
  removeEmailApprovalReview,
} from '../src/facades/approvals/hooks'

test('closing or resolving email review evicts exact correspondence immediately', () => {
  const queryClient = new QueryClient()
  const approvalId = 'approval-private-email'
  const key = emailApprovalReviewKey(approvalId)
  const proposal = {
    subject: 'Private contract renewal',
    text: 'The confidential proposal body.',
    to: ['customer@example.test'],
  }
  queryClient.setQueryData(key, proposal)

  removeEmailApprovalReview(queryClient, approvalId)

  assert.equal(queryClient.getQueryData(key), undefined)
})
