import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { GLOBAL_AGENT_BLUEPRINTS, listAgentsForUser } from '@nessie/team-admin'

import {
  AGENT_DESIGNER_BLUEPRINT,
  ensureGlobalAgentsForUser,
  globalAgentHomeDmKey,
} from '../src/services/global-agents.js'
import { ensurePersonalAssistantBootstrap } from '../src/services/personal-assistant.js'
import { resolveSystemAgentConversation } from '../src/services/system-agent-conversations.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

/**
 * Addressing a DM-homed system agent from "New message", against real rows.
 *
 * The gate this proves is the one a fake cannot see: the branch has to return
 * *this* person's pre-provisioned home DM — the same channel the sidebar shows
 * — rather than create anything, and it has to do it for an ordinary member,
 * because opening your own home DM is not the placement the owner gate exists
 * for. Cleanup is scoped to each test's own seeded organisation: no global
 * delete and no global count assertion.
 */

type Seed = {
  memberUserId: string
  organizationId: string
  ownerUserId: string
  prisma: PrismaClient
  teamId: string
}

const seed = async (label: string): Promise<Seed> => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const ownerUserId = randomUUID()
  const memberUserId = randomUUID()

  await prisma.organization.create({
    data: { id: organizationId, name: `${label}-${organizationId}` },
  })
  await prisma.user.createMany({
    data: [
      { id: ownerUserId, email: `${ownerUserId}@test.local`, displayName: 'Owner' },
      { id: memberUserId, email: `${memberUserId}@test.local`, displayName: 'Member' },
    ],
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId, userId: ownerUserId, role: 'owner' },
      { organizationId, userId: memberUserId, role: 'member' },
    ],
  })
  const project = await prisma.project.create({
    data: { name: `${label} project`, organizationId },
  })
  const team = await prisma.team.create({
    data: { name: `${label} team`, projectId: project.id },
  })

  return { memberUserId, organizationId, ownerUserId, prisma, teamId: team.id }
}

const teardown = async (context: Seed): Promise<void> => {
  await context.prisma.organization.deleteMany({ where: { id: context.organizationId } })
  await context.prisma.user.deleteMany({
    where: { id: { in: [context.ownerUserId, context.memberUserId] } },
  })
  await context.prisma.$disconnect()
}

dbTest('a member addressing a global agent lands in their own home DM', async () => {
  const context = await seed('system-agent-address-member')
  const { memberUserId, organizationId, ownerUserId, prisma, teamId } = context

  try {
    const [designerHome] = await ensureGlobalAgentsForUser(prisma, {
      organizationId,
      teamId,
      userId: memberUserId,
    })
    assert.ok(designerHome)

    const outcome = await resolveSystemAgentConversation(prisma, {
      agentIds: [designerHome.agentId],
      organizationId,
      teamId,
      userId: memberUserId,
      userIds: [],
    })

    assert.equal(outcome.kind, 'channel')
    assert.ok(outcome.kind === 'channel')
    assert.equal(outcome.channel.id, designerHome.channelId)
    // The compose page sends into `channel.defaultThreadId`, so the resolved
    // channel has to carry one.
    assert.equal(outcome.channel.defaultThreadId, designerHome.threadId)

    const channel = await prisma.channel.findUniqueOrThrow({
      where: { id: outcome.channel.id },
      select: { dmKey: true, members: { select: { userId: true } } },
    })
    assert.equal(
      channel.dmKey,
      globalAgentHomeDmKey({
        organizationId,
        slug: AGENT_DESIGNER_BLUEPRINT.slug,
        userId: memberUserId,
      }),
    )
    // Never somebody else's: the owner's home DM is a different channel and
    // this one holds exactly the member.
    assert.deepEqual(channel.members.map((member) => member.userId), [memberUserId])

    const ownerOutcome = await resolveSystemAgentConversation(prisma, {
      agentIds: [designerHome.agentId],
      organizationId,
      teamId,
      userId: ownerUserId,
      userIds: [],
    })
    assert.ok(ownerOutcome.kind === 'channel')
    assert.notEqual(ownerOutcome.channel.id, outcome.channel.id)
  } finally {
    await teardown(context)
  }
})

dbTest('addressing provisions the home DM and is idempotent', async () => {
  const context = await seed('system-agent-address-idempotent')
  const { memberUserId, organizationId, prisma, teamId } = context

  try {
    // Deliberately bootstrapped for somebody else first: the agent row exists,
    // this person's home DM does not. Login-time provisioning is best-effort,
    // so the branch must ensure rather than assume.
    const [ownerHome] = await ensureGlobalAgentsForUser(prisma, {
      organizationId,
      teamId,
      userId: context.ownerUserId,
    })
    assert.ok(ownerHome)

    const first = await resolveSystemAgentConversation(prisma, {
      agentIds: [ownerHome.agentId],
      organizationId,
      teamId,
      userId: memberUserId,
      userIds: [],
    })
    const second = await resolveSystemAgentConversation(prisma, {
      agentIds: [ownerHome.agentId],
      organizationId,
      teamId,
      userId: memberUserId,
      userIds: [],
    })

    assert.ok(first.kind === 'channel' && second.kind === 'channel')
    assert.equal(second.channel.id, first.channel.id)

    const homes = await prisma.channel.count({
      where: {
        organizationId,
        dmKey: globalAgentHomeDmKey({
          organizationId,
          slug: AGENT_DESIGNER_BLUEPRINT.slug,
          userId: memberUserId,
        }),
      },
    })
    assert.equal(homes, 1)
  } finally {
    await teardown(context)
  }
})

dbTest('a global agent cannot be added to a group conversation', async () => {
  const context = await seed('system-agent-address-exclusive')
  const { memberUserId, organizationId, ownerUserId, prisma, teamId } = context

  try {
    const [home] = await ensureGlobalAgentsForUser(prisma, {
      organizationId,
      teamId,
      userId: memberUserId,
    })
    assert.ok(home)

    const withPerson = await resolveSystemAgentConversation(prisma, {
      agentIds: [home.agentId],
      organizationId,
      teamId,
      userId: memberUserId,
      userIds: [ownerUserId],
    })
    assert.equal(withPerson.kind, 'exclusive')
    assert.ok(withPerson.kind === 'exclusive')
    assert.equal(withPerson.agentName, AGENT_DESIGNER_BLUEPRINT.name)

    const ordinaryAgent = await prisma.agent.create({
      data: { name: 'Ordinary', organizationId, role: 'assistant' },
      select: { id: true },
    })
    const withAgent = await resolveSystemAgentConversation(prisma, {
      agentIds: [home.agentId, ordinaryAgent.id],
      organizationId,
      teamId,
      userId: memberUserId,
      userIds: [],
    })
    assert.equal(withAgent.kind, 'exclusive')

    // Addressing only yourself alongside it is not a group.
    const withSelf = await resolveSystemAgentConversation(prisma, {
      agentIds: [home.agentId],
      organizationId,
      teamId,
      userId: memberUserId,
      userIds: [memberUserId],
    })
    assert.equal(withSelf.kind, 'channel')
  } finally {
    await teardown(context)
  }
})

dbTest('an ordinary agent still falls through to the owner gate', async () => {
  const context = await seed('system-agent-address-ordinary')
  const { memberUserId, organizationId, prisma, teamId } = context

  try {
    const ordinaryAgent = await prisma.agent.create({
      data: { name: 'Ordinary', organizationId, role: 'assistant' },
      select: { id: true },
    })

    const outcome = await resolveSystemAgentConversation(prisma, {
      agentIds: [ordinaryAgent.id],
      organizationId,
      teamId,
      userId: memberUserId,
      userIds: [],
    })
    // `none` is what sends the route on to `requireOwner` and
    // `findOrCreatePrivateConversationChannel` — the branch changes nothing for
    // an ordinary recipient.
    assert.equal(outcome.kind, 'none')
  } finally {
    await teardown(context)
  }
})

dbTest('a system agent from another organisation is not addressable', async () => {
  const context = await seed('system-agent-address-tenancy')
  const other = await seed('system-agent-address-tenancy-other')

  try {
    const [foreignHome] = await ensureGlobalAgentsForUser(other.prisma, {
      organizationId: other.organizationId,
      teamId: other.teamId,
      userId: other.memberUserId,
    })
    assert.ok(foreignHome)

    const outcome = await resolveSystemAgentConversation(context.prisma, {
      agentIds: [foreignHome.agentId],
      organizationId: context.organizationId,
      teamId: context.teamId,
      userId: context.memberUserId,
      userIds: [],
    })
    assert.equal(outcome.kind, 'none')
  } finally {
    await teardown(other)
    await teardown(context)
  }
})

dbTest('the Personal Assistant resolves to its own DM, and built-ins are listed as addressable', async () => {
  const context = await seed('system-agent-address-pa')
  const { memberUserId, organizationId, prisma, teamId } = context

  try {
    const pa = await ensurePersonalAssistantBootstrap(prisma, {
      organizationId,
      teamId,
      userId: memberUserId,
    })
    await ensureGlobalAgentsForUser(prisma, { organizationId, teamId, userId: memberUserId })

    const outcome = await resolveSystemAgentConversation(prisma, {
      agentIds: [pa.agentId],
      organizationId,
      teamId,
      userId: memberUserId,
      userIds: [],
    })
    assert.ok(outcome.kind === 'channel')
    assert.equal(outcome.channel.id, pa.channelId)
    assert.equal(outcome.channel.defaultThreadId, pa.threadId)

    // The address book reads `dmAddressable` off the same list the picker
    // fetches (`GET /api/agents?scope=all`), for a plain member.
    const listed = await listAgentsForUser(prisma, memberUserId, organizationId, false, true)
    const addressable = listed.filter((agent) => agent.dmAddressable === true)
    // Derived from the registry rather than hard-coded, so adding a global
    // blueprint (every one is per_user_dm-homed, hence addressable) extends
    // this list instead of breaking main's CI — which is exactly how Dashboard
    // Designer turned this test red for a day. The assertion still bites both
    // ways: an ordinary agent leaking into the address book, or a blueprint
    // failing to be addressable, each fails it.
    assert.deepEqual(
      addressable.map((agent) => agent.name).sort(),
      [
        ...[...GLOBAL_AGENT_BLUEPRINTS.values()].map((blueprint) => blueprint.name),
        'Personal Assistant',
      ].sort(),
    )

    const ordinaryAgent = await prisma.agent.create({
      data: { name: 'Ordinary', organizationId, role: 'assistant' },
      select: { id: true },
    })
    const ordinaryListed = await listAgentsForUser(
      prisma,
      context.ownerUserId,
      organizationId,
      true,
      true,
    )
    assert.equal(
      ordinaryListed.find((agent) => agent.id === ordinaryAgent.id)?.dmAddressable,
      undefined,
      'an ordinary agent carries no addressability claim',
    )
  } finally {
    await teardown(context)
  }
})
