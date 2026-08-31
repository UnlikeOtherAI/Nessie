import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  AGENT_BINDING_ERROR_CODES,
  AgentBindingError,
  AGENT_MANAGEMENT_ERROR_CODES,
  AgentManagementError,
  bindAgentToChannel,
  createAgentRecord,
  isAgentAccessibleToActor,
  listAgentsForUser,
  isAgentVisibleToUser,
  resolveLocalUserIdsByUoaSub,
} from '@nessie/workspace-admin'
import { listChannelsForUser } from '../src/services/channels.js'
import { updateAgentRecord } from '../src/services/agent-management.js'

/**
 * Agent stewardship, exercised against a real database because every guarantee
 * here is a database guarantee: a composite foreign key, a CHECK constraint,
 * and predicates that join across membership. A stubbed client would assert the
 * shape of the query rather than that the constraint bites.
 *
 * Seed-scoped throughout: each row is created under ids unique to this suite and
 * removed in the same order, because these suites share one database and run
 * concurrently (AGENTS.md → Workflow).
 */

const suite = 'a9e0'
const orgId = `00000000-0000-4000-8000-${suite}00000001`
const otherOrgId = `00000000-0000-4000-8000-${suite}00000002`
const projectId = `00000000-0000-4000-8000-${suite}00000003`
const teamId = `00000000-0000-4000-8000-${suite}00000004`
const ownerUserId = `00000000-0000-4000-8000-${suite}00000005`
const strangerUserId = `00000000-0000-4000-8000-${suite}00000006`
const memberUserId = `00000000-0000-4000-8000-${suite}00000007`
const adminUserId = `00000000-0000-4000-8000-${suite}00000008`
const orgOwnerUserId = `00000000-0000-4000-8000-${suite}00000009`
const channelId = `00000000-0000-4000-8000-${suite}0000000a`

const dbTest = process.env.DATABASE_URL ? test : test.skip

const seed = async (prisma: PrismaClient) => {
  await prisma.organization.createMany({
    data: [
      { id: orgId, name: `steward-${suite}` },
      { id: otherOrgId, name: `steward-other-${suite}` },
    ],
    skipDuplicates: true,
  })
  await prisma.user.createMany({
    data: [
      { displayName: 'Owner', email: `owner-${suite}@test.local`, id: ownerUserId },
      { displayName: 'Stranger', email: `stranger-${suite}@test.local`, id: strangerUserId },
      { displayName: 'Member', email: `member-${suite}@test.local`, id: memberUserId },
      { displayName: 'Admin', email: `admin-${suite}@test.local`, id: adminUserId },
      { displayName: 'Org owner', email: `org-owner-${suite}@test.local`, id: orgOwnerUserId },
    ],
    skipDuplicates: true,
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: orgId, role: 'member', userId: ownerUserId },
      { organizationId: orgId, role: 'member', userId: memberUserId },
      { organizationId: orgId, role: 'admin', userId: adminUserId },
      { organizationId: orgId, role: 'owner', userId: orgOwnerUserId },
      // A member of the OTHER organization only — the cross-tenant candidate.
      { organizationId: otherOrgId, role: 'member', userId: strangerUserId },
    ],
    skipDuplicates: true,
  })
  await prisma.project.createMany({
    data: [{ id: projectId, name: `p-${suite}`, organizationId: orgId }],
    skipDuplicates: true,
  })
  await prisma.team.createMany({
    data: [{ id: teamId, name: `t-${suite}`, projectId }],
    skipDuplicates: true,
  })
  await prisma.channel.createMany({
    data: [{
      id: channelId,
      label: `c-${suite}`,
      organizationId: orgId,
      projectId,
      slug: `c-${suite}`,
      teamId,
      visibility: 'public',
    }],
    skipDuplicates: true,
  })
}

const cleanup = async (prisma: PrismaClient) => {
  await prisma.agent.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId] } } })
  await prisma.channel.deleteMany({ where: { id: channelId } })
  await prisma.team.deleteMany({ where: { id: teamId } })
  await prisma.project.deleteMany({ where: { id: projectId } })
  await prisma.organizationMember.deleteMany({
    where: {
      userId: {
        in: [ownerUserId, strangerUserId, memberUserId, adminUserId, orgOwnerUserId],
      },
    },
  })
  await prisma.user.deleteMany({
    where: {
      id: {
        in: [ownerUserId, strangerUserId, memberUserId, adminUserId, orgOwnerUserId],
      },
    },
  })
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } })
}

const actorFor = (
  userId: string,
  role: 'admin' | 'member' | 'owner',
): AuthorizedActionContext => ({
  actionContext: { requestId: `agent-visibility-${role}` },
  actor: { actorId: userId, actorType: 'user', roles: [role] },
  tenant: { organizationId: orgId },
}) as AuthorizedActionContext

const withDb = async (run: (prisma: PrismaClient) => Promise<void>) => {
  const prisma = new PrismaClient()
  try {
    await cleanup(prisma)
    await seed(prisma)
    await run(prisma)
  } finally {
    await cleanup(prisma)
    await prisma.$disconnect()
  }
}

dbTest('a workspace agent stays visible to its steward and a member through a public channel', async () => {
  await withDb(async (prisma) => {
    const agent = await createAgentRecord(prisma, {
      name: `steward-${suite}`,
      organizationId: orgId,
      ownerUserId,
      role: 'assistant',
    })

    assert.equal(agent.ownerUserId, ownerUserId)
    assert.equal(agent.visibility, 'workspace')
    assert.equal(agent.owner?.ownerState, 'active')
    assert.equal(agent.owner?.displayName, 'Owner')

    // `includeUnbound` is false: this is the ordinary member path, which before
    // stewardship could not see an agent that was not bound to a channel yet.
    const visible = await listAgentsForUser(prisma, ownerUserId, orgId, false)
    assert.ok(
      visible.some((entry) => entry.id === agent.id),
      'a member should see the unbound agent they own',
    )
    assert.equal(await isAgentVisibleToUser(prisma, ownerUserId, orgId, agent.id), true)

    await prisma.agentBinding.create({ data: { agentId: agent.id, channelId } })
    const memberVisible = await listAgentsForUser(prisma, memberUserId, orgId, false)
    assert.equal(memberVisible.some((entry) => entry.id === agent.id), true)
    assert.equal(await isAgentVisibleToUser(prisma, memberUserId, orgId, agent.id), true)
  })
})

dbTest('private visibility beats member, admin, and org-owner entitlement', async () => {
  await withDb(async (prisma) => {
    const agent = await createAgentRecord(prisma, {
      name: `private-${suite}`,
      organizationId: orgId,
      ownerUserId,
      role: 'assistant',
      teamId,
      visibility: 'private',
    })

    assert.equal(agent.visibility, 'private')
    assert.ok(agent.homeChannelId)
    const home = await prisma.channel.findUniqueOrThrow({
      where: { id: agent.homeChannelId },
      include: {
        agentBindings: true,
        members: true,
        threads: true,
      },
    })
    assert.equal(home.dmKey, `agent:${orgId}:${ownerUserId}:${agent.id}`)
    assert.equal(home.type, 'dm')
    assert.equal(home.visibility, 'private')
    assert.equal(home.systemChannelType, null)
    assert.deepEqual(home.members.map((member) => member.userId), [ownerUserId])
    assert.equal(home.threads.length, 1)
    assert.deepEqual(home.agentBindings.map((binding) => binding.agentId), [agent.id])

    const ownerChannels = await listChannelsForUser(prisma, ownerUserId, orgId)
    const otherChannels = await listChannelsForUser(prisma, memberUserId, orgId)
    assert.equal(ownerChannels.some((channel) => channel.id === agent.homeChannelId), true)
    assert.equal(otherChannels.some((channel) => channel.id === agent.homeChannelId), false)

    await assert.rejects(
      () => prisma.channelMember.create({
        data: { channelId: agent.homeChannelId!, userId: memberUserId },
      }),
      /must contain exactly its owner/,
    )
    for (const viewer of [
      { includeUnbound: false, role: 'member' as const, userId: memberUserId },
      { includeUnbound: false, role: 'admin' as const, userId: adminUserId },
      { includeUnbound: true, role: 'owner' as const, userId: orgOwnerUserId },
    ]) {
      const visible = await listAgentsForUser(
        prisma,
        viewer.userId,
        orgId,
        viewer.includeUnbound,
      )
      assert.equal(visible.some((entry) => entry.id === agent.id), false)
      assert.equal(
        await isAgentVisibleToUser(prisma, viewer.userId, orgId, agent.id),
        false,
      )
      assert.equal(
        await isAgentAccessibleToActor(
          prisma,
          actorFor(viewer.userId, viewer.role),
          agent.id,
        ),
        false,
      )
    }

    const ownerVisible = await listAgentsForUser(prisma, ownerUserId, orgId, false)
    assert.equal(ownerVisible.some((entry) => entry.id === agent.id), true)
    assert.equal(await isAgentVisibleToUser(prisma, ownerUserId, orgId, agent.id), true)
    assert.equal(
      await isAgentAccessibleToActor(
        prisma,
        actorFor(ownerUserId, 'member'),
        agent.id,
      ),
      true,
    )
  })
})

dbTest('private agent transfer is refused before its owner-only home can break', async () => {
  await withDb(async (prisma) => {
    const privateAgent = await createAgentRecord(prisma, {
      name: `private-transfer-${suite}`,
      organizationId: orgId,
      ownerUserId,
      role: 'assistant',
      teamId,
      visibility: 'private',
    })

    for (const ownerUserId of [memberUserId, null]) {
      await assert.rejects(
        () => updateAgentRecord(prisma, privateAgent.id, { organizationId: orgId, ownerUserId }),
        (error: unknown) =>
          error instanceof AgentManagementError
          && error.code === AGENT_MANAGEMENT_ERROR_CODES.PRIVATE_TRANSFER_UNSUPPORTED,
      )
    }

    const unchanged = await prisma.agent.findUniqueOrThrow({
      where: { id: privateAgent.id },
      select: { ownerUserId: true },
    })
    assert.equal(unchanged.ownerUserId, ownerUserId)
  })
})

dbTest('deactivating the owner withdraws the ownership-only visibility', async () => {
  await withDb(async (prisma) => {
    const agent = await createAgentRecord(prisma, {
      name: `steward-deact-${suite}`,
      organizationId: orgId,
      ownerUserId,
      role: 'assistant',
      teamId,
      visibility: 'private',
    })

    await prisma.organizationMember.updateMany({
      data: { deactivatedAt: new Date() },
      where: { organizationId: orgId, userId: ownerUserId },
    })

    // The stored pointer is unchanged; only the live membership moved. If the
    // visibility branch trusted the pointer alone this would still be visible.
    const visible = await listAgentsForUser(prisma, ownerUserId, orgId, false)
    assert.equal(
      visible.some((entry) => entry.id === agent.id),
      false,
      'a deactivated member must not keep ownership-derived visibility',
    )
    assert.equal(await isAgentVisibleToUser(prisma, ownerUserId, orgId, agent.id), false)
    assert.equal(
      await isAgentAccessibleToActor(
        prisma,
        actorFor(ownerUserId, 'member'),
        agent.id,
      ),
      false,
    )
  })
})

dbTest('private agents are refused by the binding service and database trigger', async () => {
  await withDb(async (prisma) => {
    const agent = await createAgentRecord(prisma, {
      name: `private-bind-${suite}`,
      organizationId: orgId,
      ownerUserId,
      role: 'assistant',
      teamId,
      visibility: 'private',
    })

    assert.equal(
      await bindAgentToChannel(prisma, {
        agentId: agent.id,
        channelId,
        organizationId: orgId,
        userId: orgOwnerUserId,
      }),
      null,
      'another org owner gets the same not-found result as an unknown agent',
    )

    await assert.rejects(
      () => bindAgentToChannel(prisma, {
        agentId: agent.id,
        channelId,
        organizationId: orgId,
        userId: ownerUserId,
      }),
      (error: unknown) =>
        error instanceof AgentBindingError
        && error.code === AGENT_BINDING_ERROR_CODES.PRIVATE_VISIBILITY,
    )

    await assert.rejects(
      () => prisma.agentBinding.create({
        data: { agentId: agent.id, channelId },
      }),
      /Private agents can only be bound to their owner home DM/,
    )

    const otherAgent = await createAgentRecord(prisma, {
      name: `private-bind-other-${suite}`,
      organizationId: orgId,
      ownerUserId: memberUserId,
      role: 'assistant',
      teamId,
      visibility: 'private',
    })
    assert.ok(otherAgent.homeChannelId)
    await assert.rejects(
      () => prisma.agentBinding.create({
        data: { agentId: agent.id, channelId: otherAgent.homeChannelId! },
      }),
      /Private agents can only be bound to their owner home DM/,
    )
  })
})

dbTest('private creation requires an owner in the service and storage', async () => {
  await withDb(async (prisma) => {
    await assert.rejects(
      () => createAgentRecord(prisma, {
        name: `private-ownerless-${suite}`,
        organizationId: orgId,
        role: 'assistant',
        visibility: 'private',
      }),
      (error: unknown) =>
        error instanceof AgentManagementError
        && error.code === AGENT_MANAGEMENT_ERROR_CODES.PRIVATE_OWNER_REQUIRED,
    )

    await assert.rejects(
      () => prisma.agent.create({
        data: {
          name: `private-ownerless-raw-${suite}`,
          organizationId: orgId,
          visibility: 'private',
        },
      }),
    )
  })
})

dbTest('a spawned subtask child never enters its owner\'s agent list', async () => {
  await withDb(async (prisma) => {
    const parent = await createAgentRecord(prisma, {
      name: `steward-parent-${suite}`,
      organizationId: orgId,
      ownerUserId,
      role: 'assistant',
    })

    // Exactly what `spawn_subtask` writes: a permanent row inheriting the
    // parent's owner, distinguished only by `parentAgentId`.
    const child = await prisma.agent.create({
      data: {
        name: `steward-child-${suite}`,
        organizationId: orgId,
        ownerUserId,
        parentAgentId: parent.id,
        role: 'researcher',
      },
      select: { id: true },
    })

    const visible = await listAgentsForUser(prisma, ownerUserId, orgId, false)
    assert.equal(
      visible.some((entry) => entry.id === child.id),
      false,
      'subtask children are run workers, not staff, and must stay out of the list',
    )
    assert.equal(await isAgentVisibleToUser(prisma, ownerUserId, orgId, child.id), false)
  })
})

dbTest('an owner from another organization is refused', async () => {
  await withDb(async (prisma) => {
    await assert.rejects(
      () =>
        createAgentRecord(prisma, {
          name: `steward-cross-${suite}`,
          organizationId: orgId,
          ownerUserId: strangerUserId,
          role: 'assistant',
        }),
      (error: unknown) =>
        error instanceof AgentManagementError
        && error.code === AGENT_MANAGEMENT_ERROR_CODES.OWNER_NOT_A_MEMBER,
      'a user with no membership in this organization cannot steward its agents',
    )
  })
})

dbTest('the database refuses cross-tenant stewardship even without the service check', async () => {
  await withDb(async (prisma) => {
    // Bypass the service entirely: the composite foreign key is the guarantee,
    // because one writer (spawn_subtask) creates agents outside the chokepoint.
    await assert.rejects(
      () =>
        prisma.agent.create({
          data: {
            name: `steward-raw-${suite}`,
            organizationId: orgId,
            ownerUserId: strangerUserId,
            role: 'assistant',
          },
        }),
      'the composite FK must reject an owner who is not a member of this org',
    )
  })
})

dbTest('uoaSub resolution is scoped to the calling organization', async () => {
  await withDb(async (prisma) => {
    const sub = `uoa-sub-${suite}`
    // The stranger belongs to the OTHER organization and carries the subject.
    await prisma.user.update({ data: { uoaSub: sub }, where: { id: strangerUserId } })

    const inCallerOrg = await resolveLocalUserIdsByUoaSub(prisma, orgId, [sub])
    assert.equal(
      inCallerOrg.get(sub),
      undefined,
      'a subject whose only membership is elsewhere must not resolve here',
    )

    const inOwnOrg = await resolveLocalUserIdsByUoaSub(prisma, otherOrgId, [sub])
    assert.equal(inOwnOrg.get(sub), strangerUserId)
  })
})
