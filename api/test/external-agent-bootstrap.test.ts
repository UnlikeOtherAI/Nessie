import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  EXTERNAL_AGENT_PRODUCTS,
  ensureExternalAgentBootstrap,
} from '../src/services/external-agent.js'
import { asPrisma, makeExternalAgentPrismaFake } from './helpers/external-agent-prisma-fake.js'

test('external-agent bootstrap is idempotent across repeated calls', async () => {
  const seed = {
    organizationId: randomUUID(),
    projectId: randomUUID(),
    teamId: randomUUID(),
  }
  const userId = randomUUID()
  const fake = makeExternalAgentPrismaFake(seed)
  const prisma = asPrisma(fake)
  const product = EXTERNAL_AGENT_PRODUCTS.deepsignal!

  const first = await ensureExternalAgentBootstrap(prisma, {
    organizationId: seed.organizationId,
    product,
    userId,
    externalTeamId: 'uoa-team',
  })
  const second = await ensureExternalAgentBootstrap(prisma, {
    organizationId: seed.organizationId,
    product,
    userId,
    externalTeamId: 'uoa-team',
  })

  assert.equal(first.agentId, second.agentId)
  assert.equal(first.channelId, second.channelId)
  assert.equal(first.threadId, second.threadId)

  // Exactly one of each row, and the agent carries the external-agent shape.
  assert.equal(fake.agents.length, 1)
  assert.equal(fake.agents[0]?.executionMode, 'external_mcp')
  assert.equal(fake.agents[0]?.agentKind, 'shared')
  assert.equal(fake.agents[0]?.surfacePolicy, 'dm_only')
  assert.equal(fake.agents[0]?.delegationMode, 'act_as_requesting_user')
  assert.equal(fake.agents[0]?.name, 'DeepSignal')
  assert.equal(fake.channelsById.size, 1)
  assert.equal(fake.threads.length, 1)
  assert.equal(fake.agentBindings.length, 1)

  // A system-managed host team was created under the organisation's channel
  // root — beside the root's own team, never under the seed team's project,
  // which a person could delete; the channel has exactly one member.
  const host = [...fake.teams.values()].find(
    (t) => t.systemManaged && t.name === 'External Agent System',
  )
  assert.ok(host)
  assert.equal(host.projectId, fake.rootProjects.get(seed.organizationId))
  assert.notEqual(host.projectId, seed.projectId)
  assert.equal(fake.channelMembers.length, 1)
  assert.equal(fake.channelMembers[0]?.userId, userId)
  assert.equal(fake.channelMembers[0]?.role, 'owner')
  const [channel] = [...fake.channelsById.values()]
  assert.equal(channel?.systemChannelType, 'external_agent')
})

test('different UOA teams use distinct channels and conversations', async () => {
  const seed = {
    organizationId: randomUUID(),
    projectId: randomUUID(),
    teamId: randomUUID(),
  }
  const userId = randomUUID()
  const fake = makeExternalAgentPrismaFake(seed)
  const prisma = asPrisma(fake)
  const product = EXTERNAL_AGENT_PRODUCTS.deepsignal!

  const first = await ensureExternalAgentBootstrap(prisma, {
    organizationId: seed.organizationId,
    product,
    userId,
    externalTeamId: 'uoa-team-a',
  })
  const second = await ensureExternalAgentBootstrap(prisma, {
    organizationId: seed.organizationId,
    product,
    userId,
    externalTeamId: 'uoa-team-b',
  })

  assert.notEqual(first.channelId, second.channelId)
  assert.notEqual(first.threadId, second.threadId)
  assert.equal(first.agentId, second.agentId)
  assert.equal(fake.channelsById.size, 2)
  assert.equal(fake.threads.length, 2)
})
