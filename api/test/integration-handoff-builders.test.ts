import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDeepWaterLaunchMessage,
  buildDeepWaterLaunchMetadata,
} from '../src/routes/integrations/handoff-builders.js'

test('DeepWater handoff maps legacy launcher controls to Ledger MCP contract', () => {
  const runId = '018f8b91-7c5a-7e6d-8f90-123456789abc'
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
  }, { runId })

  assert.match(message, /approved Ledger MCP connector/)
  assert.match(message, /exact full UUID for every deep_water_run_update call/)
  assert.match(message, new RegExp(runId))
  assert.match(message, /runId set to the exact full Nessie durable research run id above/)
  assert.match(message, /Depth: heavy/)
  assert.match(message, /Recency: recent/)
  assert.match(message, /mcp_research_start/)
  assert.match(message, /Do not use delegate/)
  assert.match(message, /binds the first mcp_research_start tool-call id and exact arguments/)
  assert.match(message, /permits only that logical start/)
  assert.match(message, /validated Ledger-local invalid-request, permission, or budget rejection is recorded failed automatically/)
  assert.match(message, /successful response without matching usable Ledger id, job_id, and supported status fields is ambiguous/)
  assert.match(message, /do not retry it yourself or call dependent tools/)
  assert.match(message, /retries with the exact saved id and arguments/)
  assert.match(message, /moves exhausted ambiguity to needs_setup/)
  assert.match(message, /replay an already-persisted Ledger ticket/)
  assert.match(message, /with its exact status/)
  assert.match(message, /If status is complete, failed, cancelled, or timed_out/)
  assert.match(message, /never overwrite it with running/)
  assert.match(message, /including after a terminal replay/)
  assert.match(message, /research was rejected/)
  assert.match(
    message,
    /stop without calling deep_water_run_update, status, report, or Knowledge tools/,
  )
  assert.match(message, /mcp_research_status/)
  assert.match(message, /mcp_research_report/)
  assert.match(message, /validates and records the matching report_url from the authenticated mcp_research_start response/)
  assert.match(message, /source count from the authenticated mcp_research_report references array/)
  assert.match(message, /Do not pass, invent, infer, or replace either value/)
  assert.doesNotMatch(message, /mcp_research_create/)
  assert.doesNotMatch(message, /mcp_research_get/)
  assert.match(message, /context string \(not as extra top-level tool arguments\)/)
  assert.match(message, /Do not pass a cost, price, charge, tariff, or currency/)
  assert.match(message, /Ledger exposes raw metering only/)
  assert.match(message, /UOA is the sole source for commercial amounts/)
  assert.doesNotMatch(message, /totalCost/)
  assert.doesNotMatch(message, /rate-card/)
  assert.match(message, /Do not call Deep Water directly/)
  assert.match(message, /Do not busy-poll/)
  assert.match(message, /end this turn/)
  assert.match(message, /call kb_list with no arguments/)
  assert.match(message, /accessible writable spaceId returned by that call/)
  assert.match(message, /kb_draft_write with that exact spaceId/)
  assert.match(message, /never invent, guess, or reuse an unlisted spaceId/)
  assert.match(message, /terminal status/)
  assert.match(message, /mandatory and must succeed before any optional Knowledge drafting/)
  assert.match(message, /concise completed-report summary/)
  assert.match(message, /instead of copying an unbounded report/)
  assert.match(message, /deep_water_run_update again/)
  assert.ok(
    message.indexOf('Nessie durably binds')
      < message.indexOf('After mcp_research_start returns'),
  )
  assert.doesNotMatch(message, /do not retry it in this turn/)
  assert.ok(
    message.indexOf('mandatory and must succeed') < message.indexOf('Only after the terminal run update succeeds'),
  )
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
  }, { runId: '018f8b91-7c5a-7e6d-8f90-abcdef012345' })

  assert.match(message, /Depth: deep/)
  assert.match(message, /Recency: any/)
  assert.doesNotMatch(message, /kb_list/)
  assert.doesNotMatch(message, /kb_draft_write/)
})

test('DeepWater handoff offers a bounded reviewable chat launcher preset', () => {
  const metadata = buildDeepWaterLaunchMetadata({
    artifactDestination: 'chat_only',
    chapterDepth: 'detailed',
    depth: 'deep',
    outputLanguage: 'de',
    outputTier: 'full',
    query: 'Compare heat-pump adoption across the DACH region.',
    recency: 'year',
    searchQuality: 'premium',
    searchesPerPillar: 6,
    sections: 10,
    title: 'DACH heat-pump research',
  }, {
    channelId: '018f8b91-7c5a-7e6d-8f90-abcdef012345',
    connectorId: '018f8b91-7c5a-7e6d-8f90-abcdef012346',
    productSlug: 'deep-water',
    runId: '018f8b91-7c5a-7e6d-8f90-abcdef012347',
  })
  const cards = metadata.uiCards as Array<{
    actions: Array<{ preset?: { outputLanguage?: string; sections?: number }; type: string }>
  }>
  const action = cards[0]?.actions.find((candidate) =>
    candidate.type === 'open_deep_water_research_launcher',
  )

  assert.equal(action?.preset?.outputLanguage, 'de')
  assert.equal(action?.preset?.sections, 10)
})
