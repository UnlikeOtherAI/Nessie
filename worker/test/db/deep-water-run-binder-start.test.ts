import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import { cancelUnopenedDeepWaterBrief } from '@nessie/runtime'
import { LedgerScopeResultSchema, deepWaterScopeStartLedgerArgs } from '@nessie/schemas'

import { watchDeepWaterRun } from '../../src/control/deepwater-watch.js'
import { withBinderFixture } from './deep-water-run-binder-fixture.js'
import { researchId, wireScope } from './deep-water-watch-fixture.js'

/**
 * An agent's `research_scope_start` once it has left for Ledger (Water plan
 * amendments N1.5): whatever happens to its answer here, the agent is told the
 * brief may have started and must not start it again — the run stays queued
 * and the watch's replay of the same call attaches it. The call leaves built
 * from what the brief stored, exactly as the watch replays it. A brief
 * cancelled before DeepWater named it is never sent again.
 */

const scopeArgs = { topic: 'Heat pumps in older houses', settings: { depth: 'light' } }

const agentRuns = (fixture: { prisma: PrismaClient; ids: { organization: string } }) =>
  fixture.prisma.productIntegrationRun.findMany({
    where: { organizationId: fixture.ids.organization, productSlug: 'deep-water', originKind: 'agent' },
  })

withBinderFixture('a start Ledger accepted but Nessie could not record still says not to start again', async (fixture) => {
  // Another run already holds the research id Ledger answers with, so recording it fails.
  const holder = await fixture.insert('person')
  const rs = researchId()
  await fixture.attach(holder.id, LedgerScopeResultSchema.parse(wireScope({ id: rs, revision: 0 })))
  fixture.answer(wireScope({ id: rs, revision: 0, turn: { id: randomUUID(), seq: 1, status: 'pending', author_kind: 'agent' } }))

  const bound = await fixture.binder.dispatch('research_scope_start', 'call_unrecorded', scopeArgs, fixture.send)

  assert.equal(bound.transportInvoked, true)
  assert.match(bound.result.output, /may have started/)
  assert.match(bound.result.output, /Do not call mcp_research_scope_start again/)
  assert.doesNotMatch(bound.result.output, /MCP dispatch error/)
  const [run] = await agentRuns(fixture)
  assert.equal(run?.status, 'queued', 'left for the watch to replay and attach')
  assert.equal(run?.externalRunId, null)
})

withBinderFixture('a brief cancelled before DeepWater named it is never sent again', async (fixture) => {
  fixture.answer(new Error('socket hang up'))
  await fixture.binder.dispatch('research_scope_start', 'call_cancelled', scopeArgs, fixture.send)
  const [run] = await agentRuns(fixture)
  assert.ok(run)
  // The agent's run has ended and no watch replay is in flight, so it is cancelled here.
  const cancelled = await fixture.prisma.$transaction((tx) => cancelUnopenedDeepWaterBrief(tx, {
    organizationId: fixture.ids.organization,
    runId: run.id,
    actionId: randomUUID(),
  }))
  assert.equal(cancelled, 'cancelled')

  const sent = fixture.sent.length
  fixture.answer(wireScope({ id: researchId(), revision: 0 }))
  const retried = await fixture.binder.dispatch('research_scope_start', 'call_cancelled', scopeArgs, fixture.send)
  assert.equal(retried.transportInvoked, false)
  assert.match(retried.result.output, /^DEEP_WATER_BRIEF_CANCELLED/)
  assert.equal(fixture.sent.length, sent, 'nothing reaches Ledger')
  assert.equal((await fixture.read(run.id)).status, 'cancelled')
})

withBinderFixture('the opening call and the watch\'s replay of it send the same bytes, built from the stored brief', async (fixture) => {
  // Ledger fingerprints a scope start by its normalised arguments and answers a
  // replay that differs with `conflict`. The agent's own arguments normalise
  // differently from what they say: a padded topic, a blank background and an
  // empty settings object are all dropped or trimmed when the brief is stored.
  fixture.answer(new Error('socket hang up'))
  const padded = { topic: '  Heat pumps in older houses  ', context: '  \n  ', settings: {} }
  const bound = await fixture.binder.dispatch('research_scope_start', 'call_padded', padded, fixture.send)
  assert.equal(bound.transportInvoked, true)

  const [claimed] = await agentRuns(fixture)
  assert.ok(claimed)
  const stored = (await fixture.read(claimed.id)).input
  assert.ok(stored)
  assert.deepEqual(
    { topic: stored.topic, context: stored.context, pillars: stored.pillars, settings: stored.settings },
    { topic: 'Heat pumps in older houses', context: null, pillars: null, settings: null },
  )
  const [opening] = fixture.sent
  assert.deepEqual(opening?.args, { topic: 'Heat pumps in older houses' })
  assert.deepEqual(opening?.args, deepWaterScopeStartLedgerArgs(stored))

  // Its answer was lost, so the watch replays the very same call.
  fixture.ledger.answer('research_scope_start', wireScope({
    id: researchId(),
    turn: { id: randomUUID(), seq: 1, status: 'pending', author_kind: 'agent' },
  }))
  await watchDeepWaterRun(fixture.deps, await fixture.read(claimed.id))
  const [replay] = fixture.ledger.calls
  assert.equal(replay?.toolName, 'research_scope_start')
  assert.equal(replay?.toolCallId, 'call_padded')
  assert.equal(JSON.stringify(replay?.args), JSON.stringify(opening?.args))
  assert.equal((await fixture.read(claimed.id)).status, 'drafting')
})

withBinderFixture('a retried call sends the arguments the brief was first stored with', async (fixture) => {
  fixture.answer(new Error('socket hang up'))
  await fixture.binder.dispatch('research_scope_start', 'call_retried', scopeArgs, fixture.send)
  // The same provider call id again, with arguments the agent reworded: the
  // brief it claimed is the one sent, so Ledger sees one request.
  await fixture.binder.dispatch('research_scope_start', 'call_retried', { topic: 'Something else entirely' }, fixture.send)
  assert.equal(fixture.sent.length, 2)
  assert.deepEqual(fixture.sent[1]?.args, fixture.sent[0]?.args)
  assert.deepEqual(fixture.sent[0]?.args, { topic: 'Heat pumps in older houses', settings: { depth: 'light' } })
  assert.equal((await agentRuns(fixture)).length, 1)
})
