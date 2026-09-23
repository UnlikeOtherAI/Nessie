import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import { cancelUnopenedDeepWaterBrief } from '@nessie/runtime'
import { LedgerScopeResultSchema } from '@nessie/schemas'

import { withBinderFixture } from './deep-water-run-binder-fixture.js'
import { researchId, wireScope } from './deep-water-watch-fixture.js'

/**
 * An agent's `research_scope_start` once it has left for Ledger (Water plan
 * amendments N1.5): whatever happens to its answer here, the agent is told the
 * brief may have started and must not start it again — the run stays queued
 * and the watch's replay of the same call attaches it. A brief cancelled
 * before DeepWater named it is never sent again.
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
