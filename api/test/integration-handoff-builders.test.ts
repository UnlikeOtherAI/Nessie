import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDeepWaterLaunchMessage } from '../src/routes/integrations/handoff-builders.js'

test('DeepWater handoff maps legacy launcher controls to Ledger MCP contract', () => {
  const message = buildDeepWaterLaunchMessage({
    artifactDestination: 'knowledge_draft',
    chapterDepth: 'exhaustive',
    depth: 'dissertation',
    outputLanguage: 'en',
    outputTier: 'full',
    query: 'Compare the current primary evidence.',
    recency: 'month',
    searchQuality: 'premium',
    searchesPerPillar: 7,
    sections: 12,
    title: 'Evidence review',
  })

  assert.match(message, /approved Ledger MCP connector/)
  assert.match(message, /Depth: heavy/)
  assert.match(message, /Recency: recent/)
  assert.match(message, /mcp_research_start/)
  assert.match(message, /mcp_research_status/)
  assert.match(message, /mcp_research_report/)
  assert.doesNotMatch(message, /mcp_research_create/)
  assert.doesNotMatch(message, /mcp_research_get/)
  assert.match(message, /context string \(not as extra top-level tool arguments\)/)
  assert.match(message, /copy cost\.amount exactly to totalCost/)
  assert.match(message, /immutable booked rate-card charge/)
  assert.match(message, /not an upstream provider-invoice actual/)
  assert.match(message, /complex runs may reconcile to a higher provider amount/)
  assert.match(message, /If cost is absent, omit both fields/)
  assert.match(message, /Do not call Deep Water directly/)
  assert.match(message, /Do not busy-poll/)
  assert.match(message, /end this turn/)
  assert.match(message, /call kb_list with no arguments/)
  assert.match(message, /accessible writable spaceId returned by that call/)
  assert.match(message, /kb_draft_write with that exact spaceId/)
  assert.match(message, /never invent, guess, or reuse an unlisted spaceId/)
  assert.doesNotMatch(message, /poll .* until .*terminal/i)
})

test('DeepWater handoff keeps supported Ledger depth and unrestricted recency', () => {
  const message = buildDeepWaterLaunchMessage({
    artifactDestination: 'chat_only',
    chapterDepth: 'standard',
    depth: 'deep',
    outputLanguage: 'en',
    outputTier: 'summary',
    query: 'Synthesize the evidence.',
    recency: 'any',
    searchQuality: 'standard',
    searchesPerPillar: 4,
    sections: 8,
  })

  assert.match(message, /Depth: deep/)
  assert.match(message, /Recency: any/)
  assert.doesNotMatch(message, /kb_list/)
  assert.doesNotMatch(message, /kb_draft_write/)
})
