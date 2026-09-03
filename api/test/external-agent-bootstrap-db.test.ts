import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  EXTERNAL_AGENT_PRODUCTS,
  ensureExternalAgentBootstrap,
} from '../src/services/external-agent.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

/**
 * The cast-fake sibling suite (`external-agent-bootstrap.test.ts`) proves the
 * shape of the rows but cannot see a database CHECK. Two of them rejected this
 * bootstrap until migration 20260902170000_external_agent_surface_invariants:
 * `agents_system_managed_invariants_chk` sanctioned only three agent tuples,
 * and `channels_personal_assistant_surface_chk` knew only the PA's `pa:` DM
 * key. Both failed against a real database while the fake stayed green. This
 * suite drives the real service against Postgres.
 */
dbTest('external-agent bootstrap writes its system-managed tuple to Postgres', async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userId = randomUUID()
  const product = EXTERNAL_AGENT_PRODUCTS.deepsignal!

  try {
    await prisma.organization.create({
      data: { id: organizationId, name: `extagent-bootstrap-${organizationId}` },
    })
    await prisma.user.create({
      data: { id: userId, email: `${userId}@test.local`, displayName: 'External agent user' },
    })
    await prisma.organizationMember.create({
      data: { organizationId, userId, role: 'owner' },
    })
    const project = await prisma.project.create({
      data: { name: 'External agent project', organizationId },
    })
    const team = await prisma.team.create({
      data: { name: 'External agent team', projectId: project.id },
    })

    const first = await ensureExternalAgentBootstrap(prisma, {
      organizationId,
      product,
      teamId: team.id,
      userId,
      externalTeamId: 'uoa-team',
    })

    const agent = await prisma.agent.findUniqueOrThrow({
      where: { id: first.agentId },
      select: {
        agentKind: true,
        delegationMode: true,
        executionMode: true,
        surfacePolicy: true,
        systemManaged: true,
      },
    })
    // The exact tuple the CHECK used to reject.
    assert.equal(agent.systemManaged, true)
    assert.equal(agent.agentKind, 'shared')
    assert.equal(agent.surfacePolicy, 'dm_only')
    assert.equal(agent.delegationMode, 'act_as_requesting_user')
    assert.equal(agent.executionMode, 'external_mcp')

    // The channel surface CHECK had to learn the `extagent:` DM key as well.
    const channel = await prisma.channel.findUniqueOrThrow({
      where: { id: first.channelId },
      select: { dmKey: true, systemChannelType: true, type: true, visibility: true },
    })
    assert.equal(channel.systemChannelType, 'external_agent')
    assert.equal(channel.type, 'dm')
    assert.equal(channel.visibility, 'private')
    assert.ok(channel.dmKey?.startsWith('extagent:deepsignal:'))

    // The update branch rewrites the same tuple, so it must pass the CHECK too.
    const second = await ensureExternalAgentBootstrap(prisma, {
      organizationId,
      product,
      teamId: team.id,
      userId,
      externalTeamId: 'uoa-team',
    })
    assert.equal(second.agentId, first.agentId)
    assert.equal(second.channelId, first.channelId)
    assert.equal(second.threadId, first.threadId)

    const agentCount = await prisma.agent.count({ where: { organizationId } })
    assert.equal(agentCount, 1)
  } finally {
    // Scoped to this suite's own seed only — the database is shared.
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.$disconnect()
  }
})

dbTest('the widened invariants still refuse an unsanctioned shape', async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()

  try {
    await prisma.organization.create({
      data: { id: organizationId, name: `extagent-illegal-${organizationId}` },
    })
    const project = await prisma.project.create({
      data: { name: 'Illegal shape project', organizationId },
    })
    const team = await prisma.team.create({
      data: { name: 'Illegal shape team', projectId: project.id },
    })

    await assert.rejects(
      prisma.agent.create({
        data: {
          agentKind: 'personal_assistant',
          delegationMode: 'none',
          name: 'Illegal system agent',
          organizationId,
          role: 'assistant',
          surfacePolicy: 'shared',
          systemManaged: true,
        },
      }),
      /agents_system_managed_invariants_chk/,
    )

    // An external-agent channel is still only ever a private DM under its key.
    await assert.rejects(
      prisma.channel.create({
        data: {
          dmKey: `extagent:deepsignal:${organizationId}:public`,
          label: 'Illegal external agent surface',
          organizationId,
          projectId: project.id,
          slug: `illegal-extagent-${organizationId}`,
          systemChannelType: 'external_agent',
          teamId: team.id,
          type: 'standard',
          visibility: 'public',
        },
      }),
      /channels_personal_assistant_surface_chk/,
    )
  } finally {
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.$disconnect()
  }
})
