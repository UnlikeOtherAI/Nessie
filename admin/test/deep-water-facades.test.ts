import assert from 'node:assert/strict'
import test from 'node:test'

import { QueryClient } from '@tanstack/react-query'

import { copyText, researchArtifactPath } from '../src/facades/deep-water/artifacts.js'
import {
  INTEGRATION_RUN_UPDATED_EVENT,
  invalidateResearchRun,
  researchRunIdFromFrame,
} from '../src/facades/deep-water/events.js'
import { deepWaterKeys, type DeepWaterViewerScope } from '../src/facades/deep-water/keys.js'
import {
  KNOWLEDGE_RESEARCH_VIEW_PATH,
  readResearchBriefPrefill,
  researchBriefHref,
  researchBriefPrefillState,
} from '../src/facades/deep-water/navigation.js'
import { readResearchRunRef } from '../src/components/features/deep-water/ResearchRunCard.js'

/**
 * The DeepWater facades: the realtime decision, the cache keys it
 * invalidates, how a brief is addressed, and the clipboard fallback. Each is
 * pure or runs against a real QueryClient, so no socket or DOM is needed.
 */

const RUN = '11111111-1111-4111-8111-111111111111'
const OTHER_RUN = '22222222-2222-4222-8222-222222222222'
const scope: DeepWaterViewerScope = { organizationId: 'org', teamId: 'team', userId: 'user' }

const frame = (data: unknown, event = INTEGRATION_RUN_UPDATED_EVENT) => ({
  data: typeof data === 'string' ? data : JSON.stringify(data),
  event,
  id: '42',
})

test('integration.run.updated names a DeepWater run and nothing else', () => {
  assert.equal(researchRunIdFromFrame(frame({ data: { productSlug: 'deep-water', runId: RUN } })), RUN)
  // The bare payload, without the stream's envelope, reads the same.
  assert.equal(researchRunIdFromFrame(frame({ productSlug: 'deep-water', runId: RUN })), RUN)
  assert.equal(researchRunIdFromFrame(frame({ data: { productSlug: 'deeptest', runId: RUN } })), null)
  assert.equal(researchRunIdFromFrame(frame({ data: { productSlug: 'deep-water', runId: RUN } }, 'message.new')), null)
})

test('a malformed or content-bearing frame is ignored, never trusted', () => {
  const quiet = console.error
  console.error = () => undefined
  try {
    assert.equal(researchRunIdFromFrame(frame('{not json')), null)
    assert.equal(researchRunIdFromFrame(frame({ data: { productSlug: 'deep-water', runId: 'nope' } })), null)
    // Strict: a topic riding along is refused rather than read.
    assert.equal(
      researchRunIdFromFrame(frame({ data: { productSlug: 'deep-water', runId: RUN, topic: 'secret' } })),
      null,
    )
    assert.equal(researchRunIdFromFrame({ event: INTEGRATION_RUN_UPDATED_EVENT }), null)
  } finally {
    console.error = quiet
  }
})

test('one event refetches that run for every viewer scope and every list, and nothing else', async () => {
  const client = new QueryClient()
  const keys = [
    deepWaterKeys.view(RUN, scope),
    deepWaterKeys.brief(RUN, scope),
    deepWaterKeys.view(RUN, { ...scope, userId: 'someone-else' }),
    [...deepWaterKeys.list(scope), '{}', null, null, 25],
    deepWaterKeys.view(OTHER_RUN, scope),
  ]
  for (const key of keys) client.setQueryData(key, { cached: true })
  invalidateResearchRun(client, RUN)
  await Promise.resolve()
  const stale = keys.map((key) => client.getQueryState(key)?.isInvalidated)
  assert.deepEqual(stale, [true, true, true, true, false])
})

test('every research key starts with its run, so a run\'s keys are one prefix', () => {
  const run = deepWaterKeys.run(RUN)
  for (const key of [deepWaterKeys.view(RUN, scope), deepWaterKeys.brief(RUN, scope)]) {
    assert.deepEqual(key.slice(0, run.length), [...run])
  }
  assert.deepEqual(deepWaterKeys.list(scope).slice(0, deepWaterKeys.lists.length), [...deepWaterKeys.lists])
  assert.deepEqual(deepWaterKeys.lists.slice(0, deepWaterKeys.all.length), [...deepWaterKeys.all])
})

test('a brief opens over the conversation it belongs to, else over Knowledge › Research', () => {
  assert.equal(
    researchBriefHref({ id: RUN, origin: { channelId: 'c/1' } }),
    `/channels/c%2F1?research=${RUN}`,
  )
  assert.equal(researchBriefHref({ id: RUN, origin: { channelId: null } }), `${KNOWLEDGE_RESEARCH_VIEW_PATH}?research=${RUN}`)
})

test('a question handed to a new brief travels in router state, never in the address', () => {
  const state = researchBriefPrefillState('Heat pumps')
  assert.deepEqual(readResearchBriefPrefill(state), { topic: 'Heat pumps' })
  assert.deepEqual(readResearchBriefPrefill(researchBriefPrefillState(undefined)), { topic: '' })
  assert.equal(readResearchBriefPrefill(null), null)
  assert.equal(readResearchBriefPrefill({ somethingElse: true }), null)
  assert.deepEqual(readResearchBriefPrefill({ deepWaterResearchBrief: { topic: 7 } }), { topic: '' })
})

test('a card renders only from a server-written, well-formed pointer', () => {
  assert.equal(readResearchRunRef({ researchRunRef: { runId: RUN, schemaVersion: 1 } }), RUN)
  assert.equal(readResearchRunRef({ researchRunRef: { runId: RUN, schemaVersion: 2 } }), null)
  assert.equal(readResearchRunRef({ researchRunRef: { runId: RUN, schemaVersion: 1, topic: 'x' } }), null)
  assert.equal(readResearchRunRef(undefined), null)
})

test('the stored artifacts are read by the run\'s own paths', () => {
  assert.equal(
    researchArtifactPath(RUN, 'report'),
    `/api/integrations/products/deep-water/research-runs/${RUN}/artifacts/report.md`,
  )
  assert.equal(
    researchArtifactPath(RUN, 'sources'),
    `/api/integrations/products/deep-water/research-runs/${RUN}/artifacts/sources.csv`,
  )
})

test('Copy markdown copies, or says the person has to copy it themselves', async () => {
  const written: string[] = []
  assert.equal(await copyText('# Report', { writeText: async (text) => { written.push(text) } }), 'copied')
  assert.deepEqual(written, ['# Report'])
  assert.equal(await copyText('# Report', undefined), 'manual', 'no Clipboard API over plain HTTP')
  assert.equal(await copyText('# Report', {}), 'manual')
  const quiet = console.warn
  console.warn = () => undefined
  try {
    const refused = { writeText: async () => { throw new Error('NotAllowedError') } }
    assert.equal(await copyText('# Report', refused), 'manual', 'a refused copy is never claimed')
  } finally {
    console.warn = quiet
  }
})
