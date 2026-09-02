import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  bindAgentToChannel,
  canManageChannel,
  createAgentTrigger,
  listAgentsForUser,
} from '@nessie/workspace-admin'

import {
  AGENT_DESIGNER_BLUEPRINT,
  ensureGlobalAgentBootstrap,
  ensureGlobalAgentsForUser,
  globalAgentHomeDmKey,
} from '../src/services/global-agents.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

/**
 * The global-agent foundation against a real database.
 *
 * A cast Prisma fake cannot see the CHECKs and the deferred membership trigger
 * that carry most of this design — the external-agent bootstrap shipped broken
 * for exactly that reason — so everything here drives the real services against
 * Postgres. Cleanup is scoped to each test's own seeded organisation: the
 * database is shared with every other suite, so no global delete and no global
 * count assertion appears below.
 */

type Seed = {
  organizationId: string
  otherUserId: string
  prisma: PrismaClient
  projectId: string
  teamId: string
  userId: string
}

const seed = async (label: string): Promise<Seed> => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userId = randomUUID()
  const otherUserId = randomUUID()

  await prisma.organization.create({
    data: { id: organizationId, name: `${label}-${organizationId}` },
  })
  await prisma.user.createMany({
    data: [
      { id: userId, email: `${userId}@test.local`, displayName: 'Designer user' },
      { id: otherUserId, email: `${otherUserId}@test.local`, displayName: 'Other user' },
    ],
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId, userId, role: 'owner' },
      { organizationId, userId: otherUserId, role: 'member' },
    ],
  })
  const project = await prisma.project.create({
    data: { name: `${label} project`, organizationId },
  })
  const team = await prisma.team.create({
    data: { name: `${label} team`, projectId: project.id },
  })

  return {
    organizationId,
    otherUserId,
    prisma,
    projectId: project.id,
    teamId: team.id,
    userId,
  }
}

const teardown = async (context: Seed): Promise<void> => {
  await context.prisma.organization.deleteMany({ where: { id: context.organizationId } })
  await context.prisma.user.deleteMany({
    where: { id: { in: [context.userId, context.otherUserId] } },
  })
  await context.prisma.$disconnect()
}

dbTest('bootstrap is idempotent and writes the sanctioned system tuple', async () => {
  const context = await seed('global-agent-bootstrap')
  const { organizationId, prisma, teamId, userId } = context

  try {
    const first = await ensureGlobalAgentBootstrap(prisma, {
      blueprint: AGENT_DESIGNER_BLUEPRINT,
      organizationId,
      teamId,
      userId,
    })
    const second = await ensureGlobalAgentBootstrap(prisma, {
      blueprint: AGENT_DESIGNER_BLUEPRINT,
      organizationId,
      teamId,
      userId,
    })

    assert.equal(second.agentId, first.agentId)
    assert.equal(second.channelId, first.channelId)
    assert.equal(second.threadId, first.threadId)

    // One row per organisation per slug — asserted inside this seed's own
    // tenant, never as a global count.
    const agentCount = await prisma.agent.count({
      where: { organizationId, systemSlug: AGENT_DESIGNER_BLUEPRINT.slug },
    })
    assert.equal(agentCount, 1)

    const agent = await prisma.agent.findUniqueOrThrow({
      where: { id: first.agentId },
      select: {
        agentKind: true,
        delegationMode: true,
        effort: true,
        name: true,
        surfacePolicy: true,
        systemManaged: true,
        systemSlug: true,
        toolPolicy: true,
      },
    })
    // The tuple migration 20260902170000 sanctioned; this phase adds no CHECK.
    assert.equal(agent.systemManaged, true)
    assert.equal(agent.agentKind, 'shared')
    assert.equal(agent.surfacePolicy, 'dm_only')
    assert.equal(agent.delegationMode, 'act_as_requesting_user')
    assert.equal(agent.systemSlug, 'agent-designer')
    assert.equal(agent.name, 'Agent Designer')
    assert.deepEqual(agent.toolPolicy, AGENT_DESIGNER_BLUEPRINT.toolPolicy)
    // The identity-delegated set is stated on the row (phase 2, D3). Deny-mode
    // means the `true`s change nothing on their own — the worker's gate arm is
    // what admits them — but the stored policy must state the intent, and every
    // id must be one the blueprint actually declares.
    for (const toolId of AGENT_DESIGNER_BLUEPRINT.identityToolIds) {
      assert.equal(
        (agent.toolPolicy as Record<string, boolean>)[toolId],
        true,
        `${toolId} must be enabled in the stored policy`,
      )
    }

    const channel = await prisma.channel.findUniqueOrThrow({
      where: { id: first.channelId },
      select: {
        archivedAt: true,
        dmKey: true,
        members: { select: { userId: true } },
        systemChannelType: true,
        type: true,
        visibility: true,
      },
    })
    assert.equal(channel.systemChannelType, 'system_agent')
    assert.equal(channel.type, 'dm')
    assert.equal(channel.visibility, 'private')
    assert.equal(channel.archivedAt, null)
    assert.equal(
      channel.dmKey,
      globalAgentHomeDmKey({ organizationId, slug: 'agent-designer', userId }),
    )
    assert.deepEqual(channel.members.map((member) => member.userId), [userId])

    const bindings = await prisma.agentBinding.findMany({
      where: { channelId: first.channelId },
      select: { agentId: true },
    })
    assert.deepEqual(bindings.map((binding) => binding.agentId), [first.agentId])
  } finally {
    await teardown(context)
  }
})

dbTest('each person gets their own home DM off one shared agent row', async () => {
  const context = await seed('global-agent-homes')
  const { organizationId, otherUserId, prisma, teamId, userId } = context

  try {
    const [mine] = await ensureGlobalAgentsForUser(prisma, {
      organizationId,
      teamId,
      userId,
    })
    const [theirs] = await ensureGlobalAgentsForUser(prisma, {
      organizationId,
      teamId,
      userId: otherUserId,
    })

    assert.ok(mine && theirs)
    assert.equal(mine.agentId, theirs.agentId)
    assert.notEqual(mine.channelId, theirs.channelId)

    const theirChannel = await prisma.channel.findUniqueOrThrow({
      where: { id: theirs.channelId },
      select: { members: { select: { userId: true } } },
    })
    assert.deepEqual(theirChannel.members.map((member) => member.userId), [otherUserId])
  } finally {
    await teardown(context)
  }
})

dbTest('re-applying the blueprint never clobbers a targeted grant', async () => {
  const context = await seed('global-agent-policy-merge')
  const { organizationId, prisma, teamId, userId } = context

  try {
    const first = await ensureGlobalAgentBootstrap(prisma, {
      blueprint: AGENT_DESIGNER_BLUEPRINT,
      organizationId,
      teamId,
      userId,
    })

    // A targeted explicit grant committed between deploys. `deep_water_run_update`
    // is a protected key: the merge must carry it through untouched even though
    // the blueprint's own policy never mentions it (and could not set it).
    await prisma.agent.update({
      where: { id: first.agentId },
      data: {
        toolPolicy: {
          ...AGENT_DESIGNER_BLUEPRINT.toolPolicy,
          deep_water_run_update: true,
        },
      },
    })

    await ensureGlobalAgentBootstrap(prisma, {
      blueprint: AGENT_DESIGNER_BLUEPRINT,
      organizationId,
      teamId,
      userId,
    })

    const agent = await prisma.agent.findUniqueOrThrow({
      where: { id: first.agentId },
      select: { toolPolicy: true },
    })
    assert.deepEqual(agent.toolPolicy, {
      ...AGENT_DESIGNER_BLUEPRINT.toolPolicy,
      deep_water_run_update: true,
    })
  } finally {
    await teardown(context)
  }
})

dbTest('the database refuses an unsanctioned slug or home shape', async () => {
  const context = await seed('global-agent-invariants')
  const { organizationId, prisma, projectId, teamId, userId } = context

  try {
    // A slug only ever sits on a system-managed row.
    await assert.rejects(
      prisma.agent.create({
        data: {
          name: 'Not system managed',
          organizationId,
          systemManaged: false,
          systemSlug: 'agent-designer',
        },
      }),
      /agents_system_slug_scope_chk/,
    )

    // ...and only ever on a row that has an organisation, so a cross-org global
    // agent is impossible rather than merely unconventional.
    await assert.rejects(
      prisma.agent.create({
        data: {
          agentKind: 'shared',
          delegationMode: 'act_as_requesting_user',
          name: 'Org-less global agent',
          surfacePolicy: 'dm_only',
          systemManaged: true,
          systemSlug: 'agent-designer',
        },
      }),
      /agents_system_slug_scope_chk/,
    )

    // A `gagent:` key is a private DM under its own system-channel type.
    await assert.rejects(
      prisma.channel.create({
        data: {
          dmKey: globalAgentHomeDmKey({ organizationId, slug: 'agent-designer', userId }),
          label: 'Illegal designer surface',
          organizationId,
          projectId,
          slug: `illegal-gagent-${organizationId}`,
          systemChannelType: 'system_agent',
          teamId,
          type: 'standard',
          visibility: 'public',
        },
      }),
      /channels_personal_assistant_surface_chk/,
    )

    const bootstrap = await ensureGlobalAgentBootstrap(prisma, {
      blueprint: AGENT_DESIGNER_BLUEPRINT,
      organizationId,
      teamId,
      userId,
    })

    // Sole membership is an identity fact (`effectiveUserId = poster`), so it
    // has to hold at rest — a second member cannot commit.
    await assert.rejects(
      prisma.channelMember.create({
        data: { channelId: bootstrap.channelId, userId: context.otherUserId },
      }),
      /must contain exactly its owner/,
    )
  } finally {
    await teardown(context)
  }
})

dbTest('no second agent may bind into a global agent home DM', async () => {
  const context = await seed('global-agent-binding')
  const { organizationId, prisma, teamId, userId } = context

  try {
    const bootstrap = await ensureGlobalAgentBootstrap(prisma, {
      blueprint: AGENT_DESIGNER_BLUEPRINT,
      organizationId,
      teamId,
      userId,
    })
    const intruder = await prisma.agent.create({
      data: { name: 'Intruder', organizationId },
    })

    const bound = await bindAgentToChannel(prisma, {
      agentId: intruder.id,
      channelId: bootstrap.channelId,
      organizationId,
      userId,
    })
    assert.equal(bound, null)

    const bindings = await prisma.agentBinding.findMany({
      where: { channelId: bootstrap.channelId },
      select: { agentId: true },
    })
    assert.deepEqual(bindings.map((binding) => binding.agentId), [bootstrap.agentId])

    // And the surface is lifecycle-protected: nobody renames or archives it,
    // not even the organisation owner who seeded it.
    assert.equal(
      await canManageChannel(prisma, {
        channelId: bootstrap.channelId,
        organizationId,
        userId,
      }),
      null,
    )
  } finally {
    await teardown(context)
  }
})

dbTest('a global agent cannot own a trigger', async () => {
  const context = await seed('global-agent-trigger')
  const { organizationId, prisma, teamId, userId } = context

  try {
    const bootstrap = await ensureGlobalAgentBootstrap(prisma, {
      blueprint: AGENT_DESIGNER_BLUEPRINT,
      organizationId,
      teamId,
      userId,
    })

    const refused = await createAgentTrigger(prisma, bootstrap.agentId, {
      name: 'Nightly design sweep',
      type: 'manual',
    })
    assert.equal(refused, null)

    const triggerCount = await prisma.agentTrigger.count({
      where: { agentId: bootstrap.agentId },
    })
    assert.equal(triggerCount, 0)
  } finally {
    await teardown(context)
  }
})

dbTest('an unbound global agent is still listed on the Global tab', async () => {
  const context = await seed('global-agent-list')
  const { organizationId, otherUserId, prisma, teamId, userId } = context

  try {
    const bootstrap = await ensureGlobalAgentBootstrap(prisma, {
      blueprint: AGENT_DESIGNER_BLUEPRINT,
      organizationId,
      teamId,
      userId,
    })

    // The second member has no home DM yet — the state every member is in until
    // their next login. The channel-gated list arm made the agent invisible to
    // them, which is the unreachable-capability defect this phase fixes.
    const withoutSystem = await listAgentsForUser(prisma, otherUserId, organizationId, false)
    assert.equal(
      withoutSystem.some((agent) => agent.id === bootstrap.agentId),
      false,
      'the default list still excludes system agents',
    )

    const withSystem = await listAgentsForUser(prisma, otherUserId, organizationId, false, true)
    const designer = withSystem.find((agent) => agent.id === bootstrap.agentId)
    assert.ok(designer, 'scope=all lists the Agent Designer for a member with no home DM')
    assert.equal(designer.systemManaged, true)
    assert.equal(designer.name, 'Agent Designer')
  } finally {
    await teardown(context)
  }
})
