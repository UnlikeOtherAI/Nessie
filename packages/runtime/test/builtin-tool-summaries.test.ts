import assert from 'node:assert/strict'
import test from 'node:test'

import { SYSTEM_TOOL_DEFINITIONS } from '../src/index.js'

const summaryFor = (toolId: string) => {
  const tool = SYSTEM_TOOL_DEFINITIONS.find(({ id }) => id === toolId)
  assert.ok(tool, `Expected ${toolId} in SYSTEM_TOOL_DEFINITIONS`)
  return tool.summary
}

test('every system tool has a concise summary', () => {
  const invalidTools = SYSTEM_TOOL_DEFINITIONS.filter(
    ({ summary }) => typeof summary !== 'string' || !summary.trim() || summary.length > 80,
  )

  assert.deepEqual(invalidTools, [])
})

test('web and document read summaries distinguish their source and operation', () => {
  const expectedSummaries = new Map([
    ['web_search', 'Search the public web for current results and answer snippets.'],
    ['web_fetch', 'Extract readable text from a public web page URL.'],
    ['http_fetch', 'Make a generic HTTP request with headers, body, and auth.'],
    ['document_read', 'Read a project-local markdown document by path or topic.'],
  ])

  for (const [toolId, expectedSummary] of expectedSummaries) {
    assert.equal(summaryFor(toolId), expectedSummary)
  }
  assert.equal(
    new Set([...expectedSummaries.keys()].map(summaryFor)).size,
    expectedSummaries.size,
  )
})

test('knowledge document summaries distinguish drafting, composing, and editing', () => {
  const expectedSummaries = new Map([
    ['kb_draft_write', 'Create a rich-text page draft or a new draft version for review.'],
    ['kb_document_compose', 'Live-write a complete markdown document as a new knowledge-base file.'],
    ['kb_document_edit', 'Apply targeted exact-match edits to an existing markdown document.'],
  ])

  for (const [toolId, expectedSummary] of expectedSummaries) {
    assert.equal(summaryFor(toolId), expectedSummary)
  }
  assert.equal(
    new Set([...expectedSummaries.keys()].map(summaryFor)).size,
    expectedSummaries.size,
  )
})

test('message search summaries distinguish team, channel, and author scope', () => {
  const expectedSummaries = new Map([
    ['team_search', 'Search accessible team conversations, threads, and messages.'],
    ['message_search', 'Search accessible channel messages, optionally within one channel.'],
    ['authored_message_search', 'Search accessible messages written by the current user.'],
  ])

  for (const [toolId, expectedSummary] of expectedSummaries) {
    assert.equal(summaryFor(toolId), expectedSummary)
  }
  assert.equal(
    new Set([...expectedSummaries.keys()].map(summaryFor)).size,
    expectedSummaries.size,
  )
})
