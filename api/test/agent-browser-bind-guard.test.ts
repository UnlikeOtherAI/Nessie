import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { AGENT_BINDING_ERROR_CODES, bindAgentToChannel } from '@nessie/workspace-admin'

/**
 * Binding widens who can reach an agent, and its browser's sign-ins are shared
 * with exactly that audience. The bind is therefore the moment to confront
 * them — a person should never discover afterwards that adding an agent to a
 * channel handed its members somebody's mailbox.
 */
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const seed = async (prisma: PrismaClient) => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: `bind ${suffix}` } })
  const user = await prisma.user.create({
    data: { displayName: 'Owner', email: `bind-${suffix}@example.com` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, userId: user.id, role: 'owner' },
  })
  const project = await prisma.project.create({
    data: { name: `p-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: `t-${suffix}`, projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: `c-${suffix}`,
      slug: `c-${suffix.slice(0, 8)}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const agent = await prisma.agent.create({
    data: {
      name: `a-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const connection = await prisma.cloudBrowserConnection.create({
    data: {
      organizationId: organization.id,
      scope: 'organization',
      projectId: 'company',
      apiKeyRef: 'secret_browserbase_x',
      createdByUserId: user.id,
    },
  })
  const browser = await prisma.agentBrowser.create({
    data: {
      organizationId: organization.id,
      agentId: agent.id,
      connectionId: connection.id,
      browserbaseContextId: `ctx-${suffix}`,
    },
  })
  return {
    agentId: agent.id,
    browserId: browser.id,
    channelId: channel.id,
    organizationId: organization.id,
    userId: user.id,
    cleanup: async () => {
      await prisma.organization.delete({ where: { id: organization.id } })
      await prisma.user.delete({ where: { id: user.id } })
    },
  }
}

runDatabaseTest('binding an agent whose browser holds sign-ins is refused until confirmed', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    await prisma.agentBrowserLogin.create({
      data: {
        organizationId: s.organizationId,
        agentBrowserId: s.browserId,
        userId: s.userId,
        serviceHint: 'Google — owner@example.com',
      },
    })

    await assert.rejects(
      bindAgentToChannel(prisma, {
        agentId: s.agentId,
        channelId: s.channelId,
        organizationId: s.organizationId,
        userId: s.userId,
      }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, AGENT_BINDING_ERROR_CODES.BROWSER_LOGINS_PRESENT)
        // The refusal names what would be inherited, or it is not a decision
        // anybody can make.
        assert.match(error.message, /Google — owner@example\.com/)
        return true
      },
    )
    assert.equal(
      await prisma.agentBinding.count({ where: { agentId: s.agentId } }),
      0,
      'nothing may be bound while the question is unanswered',
    )

    const bound = await bindAgentToChannel(prisma, {
      agentId: s.agentId,
      channelId: s.channelId,
      confirmBrowserSharing: true,
      organizationId: s.organizationId,
      userId: s.userId,
    })
    assert.ok(bound)
    assert.equal(await prisma.agentBinding.count({ where: { agentId: s.agentId } }), 1)
  } finally {
    await s.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('an agent whose browser holds no sign-ins binds without a prompt', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    // A browser exists but nobody has signed it into anything: there is
    // nothing to inherit, so asking would be noise.
    const bound = await bindAgentToChannel(prisma, {
      agentId: s.agentId,
      channelId: s.channelId,
      organizationId: s.organizationId,
      userId: s.userId,
    })
    assert.ok(bound)
  } finally {
    await s.cleanup()
    await prisma.$disconnect()
  }
})
