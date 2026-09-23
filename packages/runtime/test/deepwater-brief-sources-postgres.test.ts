import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'

import { readDeepWaterBriefRun } from '../src/deepwater-brief-run-record.js'
import { deepWaterPersonOriginSources, unionDeepWaterRunSources } from '../src/deepwater-brief-sources.js'
import { agentOrigin, insertBrief, seedBriefFixture, type BriefFixture } from './deepwater-brief-fixture.js'

/**
 * A research's sources only grow (Water plan amendments N6): every
 * content-bearing call unions what its run consumed into the product run under
 * the row lock, so a later read or delivery can never disclose the research
 * more widely than the least-shared thing it was built from.
 */

const runIfDatabase = process.env.DATABASE_URL ? test : test.skip

const withFixture = (name: string, body: (fixture: BriefFixture) => Promise<void>): void => {
  runIfDatabase(name, async () => {
    const fixture = await seedBriefFixture()
    try {
      await body(fixture)
    } finally {
      await fixture.cleanup()
    }
  })
}

test('a person brief seeds its room\'s sources only when the room is not public', () => {
  const room = { channelId: 'c-1', requesterUserId: 'u-1' }
  assert.deepEqual(
    deepWaterPersonOriginSources({ ...room, channelVisibility: 'public', systemChannelType: null }),
    { sourceScopes: [], disclosureSources: [] },
  )
  const seeded = {
    sourceScopes: [{ scopeType: 'channel', scopeId: 'c-1' }],
    disclosureSources: [{ sourceChannelId: 'c-1', sourceAuthorUserId: 'u-1' }],
  }
  assert.deepEqual(deepWaterPersonOriginSources({ ...room, channelVisibility: 'private', systemChannelType: null }), seeded)
  assert.deepEqual(deepWaterPersonOriginSources({ ...room, channelVisibility: 'protected', systemChannelType: null }), seeded)
  // A Personal Assistant DM is the person's own room whatever its visibility says.
  assert.deepEqual(
    deepWaterPersonOriginSources({ ...room, channelVisibility: 'public', systemChannelType: 'personal_assistant' }),
    seeded,
  )
})

withFixture('content-bearing calls only ever add to a run\'s sources, and concurrent ones converge', async (fixture) => {
  const { run } = await insertBrief(fixture, agentOrigin(fixture))
  const target = { organizationId: fixture.ids.organization, runId: run.id }
  const channelScope = { scopeType: 'channel', scopeId: fixture.ids.channel }
  const lineage = { sourceChannelId: fixture.ids.channel, sourceAuthorUserId: fixture.ids.requester }

  // What the run already carries is not new.
  const same = await fixture.prisma.$transaction((tx) => unionDeepWaterRunSources(tx, {
    ...target, sourceScopes: [channelScope], disclosureSources: [lineage],
  }))
  assert.equal(same?.grew, false)

  const projectP = { scopeType: 'project', scopeId: fixture.ids.project }
  const projectQ = { scopeType: 'project', scopeId: randomUUID() }
  const unknownAuthor = { sourceChannelId: fixture.ids.channel, sourceAuthorUserId: null }
  await Promise.all([
    fixture.prisma.$transaction((tx) => unionDeepWaterRunSources(tx, {
      ...target, sourceScopes: [projectP], disclosureSources: [unknownAuthor],
    })),
    fixture.prisma.$transaction((tx) => unionDeepWaterRunSources(tx, {
      ...target, sourceScopes: [projectQ, projectP], disclosureSources: [],
    })),
  ])
  const stored = await readDeepWaterBriefRun(fixture.prisma, target)
  assert.equal(stored?.sourceScopes[0]?.scopeId, fixture.ids.channel, 'existing entries keep their place')
  assert.deepEqual(
    [...(stored?.sourceScopes ?? [])].map((scope) => scope.scopeId).sort(),
    [fixture.ids.channel, fixture.ids.project, projectQ.scopeId].sort(),
  )
  // An unknown author is kept beside the known one: it is not covered by them.
  assert.deepEqual(stored?.disclosureSources, [lineage, unknownAuthor])

  assert.equal(
    await fixture.prisma.$transaction((tx) => unionDeepWaterRunSources(tx, {
      organizationId: randomUUID(), runId: run.id, sourceScopes: [projectP], disclosureSources: [],
    })),
    null,
    'another organisation\'s run is not found',
  )
})
