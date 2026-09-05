import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  AGENT_BINDING_ERROR_CODES,
  AGENT_DESIGNER_BLUEPRINT,
  AgentBindingError,
  bindAgentToChannel,
  canManageChannel,
  checkPolicy,
  createAgentTrigger,
  ensureGlobalAgentBootstrap,
  ensureGlobalAgentsForUser,
  getChannelIfMember,
  globalAgentHomeDmKey,
  listAgentsForUser,
  unbindAgentFromChannel,
} from '@nessie/team-admin'

import { seedDefaultPolicies } from '../src/services/policy-seed.js'

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
    // The fifth tuple, sanctioned by 20260902230000. `surfacePolicy` is the
    // storage-level statement "this agent lives only in a per-user private DM",
    // and a global agent is placeable in ordinary channels, so it must not say
    // `dm_only` — that is the PA's and an external product's shape.
    // `delegationMode` is unchanged: *where* the delegation is exercised is the
    // surface predicate's call, never this column's.
    assert.equal(agent.systemManaged, true)
    assert.equal(agent.agentKind, 'shared')
    assert.equal(agent.surfacePolicy, 'shared')
    assert.equal(agent.delegationMode, 'act_as_requesting_user')
    assert.equal(agent.systemSlug, 'agent-designer')
    assert.equal(agent.name, 'Agent Designer')
    // The blueprint's policy, byte for byte: the deny-mode narrowing plus the
    // Designer's own configuration verbs. The identity-delegated set is stated
    // on the row (phase 2, D3) — deny-mode means the `true`s change nothing on
    // their own, the worker's gate arm is what admits them, but the stored
    // policy must state the intent and every id must be one the blueprint
    // actually declares.
    assert.deepEqual(agent.toolPolicy, AGENT_DESIGNER_BLUEPRINT.toolPolicy)
    assert.equal(
      (agent.toolPolicy as Record<string, boolean>)['delegate'],
      false,
      'a design conversation still fans out to nothing',
    )
    for (const toolId of AGENT_DESIGNER_BLUEPRINT.identityToolIds) {
      assert.equal(
        (agent.toolPolicy as Record<string, boolean>)[toolId],
        true,
        `${toolId} is declared on the stored row`,
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

/**
 * The reachability half: a global agent is placeable in ordinary channels.
 *
 * Each case drives the *route's* gate chain in the route's own order —
 * `getChannelIfMember`, the system-channel refusal, owner, `checkPolicy`, then
 * `bindAgentToChannel` — against a real database, because the refusals that
 * matter here are a CHECK, a partial unique and a deferred trigger.
 */
const ordinaryChannel = async (context: Seed, label: string): Promise<string> => {
  const channel = await context.prisma.channel.create({
    data: {
      label,
      organizationId: context.organizationId,
      projectId: context.projectId,
      slug: `${label}-${randomUUID().slice(0, 8)}`,
      teamId: context.teamId,
      type: 'standard',
      visibility: 'private',
      members: { create: [{ userId: context.userId }] },
    },
    select: { id: true },
  })
  return channel.id
}

const actorContextFor = (
  context: Seed,
  role: 'owner' | 'member',
): AuthorizedActionContext => ({
  actionContext: { requestId: `bind-${context.organizationId}-${role}` },
  actor: {
    actorId: role === 'owner' ? context.userId : context.otherUserId,
    actorType: 'user',
    roles: [role],
  },
  tenant: {
    organizationId: context.organizationId,
    projectId: context.projectId,
    teamId: context.teamId,
  },
}) as AuthorizedActionContext

dbTest('a global agent binds to an ordinary channel through the route gates', async () => {
  const context = await seed('global-agent-bind')
  const { organizationId, prisma, teamId, userId } = context

  try {
    const bootstrap = await ensureGlobalAgentBootstrap(prisma, {
      blueprint: AGENT_DESIGNER_BLUEPRINT,
      organizationId,
      teamId,
      userId,
    })
    const channelId = await ordinaryChannel(context, 'design-room')
    await seedDefaultPolicies(prisma, organizationId, userId)

    // Gate 1: channel membership. Gate 2: the system-channel refusal — this
    // channel is ordinary, which is exactly what makes it bindable.
    const channel = await getChannelIfMember(prisma, userId, organizationId, channelId)
    assert.ok(channel, 'the owner is a member of the channel')
    assert.equal(channel.systemChannelType, undefined)

    // Gate 3 is `requireOwner`. Gate 4: policy, on the scope chain the route
    // builds. Both are asserted from the deny side too — a gate that admits
    // everybody would make the allow above meaningless.
    const decision = await checkPolicy(
      prisma,
      actorContextFor(context, 'owner'),
      'agent',
      'bind',
      { agentId: bootstrap.agentId, channelId },
    )
    assert.equal(decision.allowed, true)
    const memberDecision = await checkPolicy(
      prisma,
      actorContextFor(context, 'member'),
      'agent',
      'bind',
      { agentId: bootstrap.agentId, channelId },
    )
    assert.equal(
      memberDecision.allowed,
      false,
      'a plain member is still refused by the bind policy',
    )

    const bound = await bindAgentToChannel(prisma, {
      agentId: bootstrap.agentId,
      channelId,
      organizationId,
      userId,
    })
    assert.ok(bound, 'the Agent Designer is no longer refused by the chokepoint')
    assert.equal(bound.systemManaged, true)
    assert.ok(
      bound.channelIds.includes(channelId),
      'the returned record names the channel it was placed in',
    )

    // And it is one of that channel's agents, which is what makes both the run
    // placement arm and the channel roster true.
    const channelAgents = await prisma.agentBinding.findMany({
      where: { channelId },
      select: { agentId: true },
    })
    assert.deepEqual(channelAgents.map((row) => row.agentId), [bootstrap.agentId])

    // Removal must be at least as wide as placement, or it is permanent.
    await unbindAgentFromChannel(prisma, {
      agentId: bootstrap.agentId,
      channelId,
      organizationId,
    })
    assert.equal(
      await prisma.agentBinding.count({ where: { channelId } }),
      0,
      'unbind no longer filters systemManaged: false',
    )

    // Its own home DM binding is untouched by that removal.
    assert.equal(
      await prisma.agentBinding.count({
        where: { agentId: bootstrap.agentId, channelId: bootstrap.channelId },
      }),
      1,
    )
  } finally {
    await teardown(context)
  }
})

dbTest('the Personal Assistant is never placed by this path', async () => {
  const context = await seed('global-agent-bind-pa')
  const { organizationId, prisma, userId } = context

  try {
    const channelId = await ordinaryChannel(context, 'pa-room')
    // The PA's sanctioned tuple: it keeps its own presence route, which writes
    // a per-user `principalUserId` row this chokepoint cannot produce.
    const pa = await prisma.agent.create({
      data: {
        agentKind: 'personal_assistant',
        delegationMode: 'act_as_requesting_user',
        name: 'Personal Assistant',
        organizationId,
        surfacePolicy: 'dm_only',
        systemManaged: true,
      },
      select: { id: true },
    })

    assert.equal(
      await bindAgentToChannel(prisma, {
        agentId: pa.id,
        channelId,
        organizationId,
        userId,
      }),
      null,
    )
    assert.equal(await prisma.agentBinding.count({ where: { channelId } }), 0)
  } finally {
    await teardown(context)
  }
})

dbTest('a private agent is still refused, and its owner is told why', async () => {
  const context = await seed('global-agent-bind-private')
  const { organizationId, prisma, userId } = context

  try {
    const channelId = await ordinaryChannel(context, 'private-room')
    const priv = await prisma.agent.create({
      data: {
        name: 'Private agent',
        organizationId,
        ownerUserId: userId,
        visibility: 'private',
      },
      select: { id: true },
    })

    await assert.rejects(
      bindAgentToChannel(prisma, {
        agentId: priv.id,
        channelId,
        organizationId,
        userId,
      }),
      (error: unknown) =>
        error instanceof AgentBindingError
        && error.code === AGENT_BINDING_ERROR_CODES.PRIVATE_VISIBILITY,
    )
    assert.equal(await prisma.agentBinding.count({ where: { channelId } }), 0)
  } finally {
    await teardown(context)
  }
})
