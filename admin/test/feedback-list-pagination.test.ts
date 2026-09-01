import assert from 'node:assert/strict'
import test from 'node:test'
import { getFeedbackPage } from '../src/pages/feedback/FeedbackList'

test('feedback pagination displays five issues at a time', () => {
  const items = Array.from({ length: 11 }, (_, index) => `issue-${index + 1}`)

  assert.deepEqual(getFeedbackPage(items, 1), {
    currentPage: 1,
    items: ['issue-1', 'issue-2', 'issue-3', 'issue-4', 'issue-5'],
    totalPages: 3,
  })
  assert.deepEqual(getFeedbackPage(items, 3), {
    currentPage: 3,
    items: ['issue-11'],
    totalPages: 3,
  })
})

test('feedback pagination returns to an available page when the list shrinks', () => {
  assert.deepEqual(getFeedbackPage(['issue-1'], 3), {
    currentPage: 1,
    items: ['issue-1'],
    totalPages: 1,
  })
})
