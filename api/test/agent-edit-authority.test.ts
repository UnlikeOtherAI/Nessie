import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  AGENT_EDIT_AUTHORITY_ERROR_CODES,
  AGENT_MANAGEMENT_ERROR_CODES,
  AgentEditAuthorityError,
  AgentManagementError,
  canEditAgent,
  createAgentRecord,
  resolveAgentEditAuthority,
  updateAgentAvatar,
} from '@nessie/team-admin'
import { AgentToolPolicyError } from '../src/services/agent-tool-policy.js'
import { updateAgentRecord } from '../src/services/agent-management.js'

/**
 * Who may rewrite an agent, exercised against a real database because every arm
 * of the predicate is a database fact: the live `OrganizationMember` row, the
 * stewardship pointer, and the channel-binding join that decides entitlement to
 * a team-owned agent. A cast Prisma fake would assert the shape of the query
 * rather than that the rule bites.
 *
 * Seed-scoped throughout: this database is shared with the other suites and
 * they run concurrently, so nothing here deletes or counts globally.
 */

const suite = 'e17a'
const orgId = `00000000-0000-4000-8000-${suite}00000001`
const projectId = `00000000-0000-4000-8000-${suite}00000002`
const teamId = `00000000-0000-4000-8000-${suite}00000003`
const publicChannelId = `00000000-0000-4000-8000-${suite}00000004`
const privateChannelId = `00000000-0000-4000-8000-${suite}00000005`

const stewardUserId = `00000000-0000-4000-8000-${suite}00000010`
const otherMemberUserId = `00000000-0000-4000-8000-${suite}00000011`
const orgOwnerUserId = `00000000-0000-4000-8000-${suite}00000012`
const outsiderUserId = `00000000-0000-4000-8000-${suite}00000013`
const departedUserId = `00000000-0000-4000-8000-${suite}00000014`

const userIds = [
  stewardUserId,
  otherMemberUserId,
  orgOwnerUserId,
  outsiderUserId,
  departedUserId,
]

const dbTest = process.env.DATABASE_URL ? test : test.skip

const actor = (userId: string) => ({ organizationId: orgId, userId })

const seed = async (prisma: PrismaClient) => {
  await prisma.organization.create({ data: { id: orgId, name: `edit-authority-${suite}` } })
  await prisma.user.createMany({
    data: userIds.map((id, index) => ({
      displayName: `Edit authority ${index}`,
      email: `edit-authority-${suite}-${index}@test.local`,
      id,
    })),
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: orgId, role: 'member', userId: stewardUserId },
      { organizationId: orgId, role: 'member', userId: otherMemberUserId },
      { organizationId: orgId, role: 'owner', userId: orgOwnerUserId },
      // Retained but deactivated: the composite FK is satisfied, the predicate
      // must still refuse.
      {
        deactivatedAt: new Date('2026-01-01T00:00:00.000Z'),
        organizationId: orgId,
        role: 'member',
        userId: departedUserId,
      },
      // `outsiderUserId` deliberately has NO membership row at all.
    ],
  })
  await prisma.project.create({ data: { id: projectId, name: `p-${suite}`, organizationId: orgId } })
  await prisma.team.create({ data: { id: teamId, name: `t-${suite}`, projectId } })
  await prisma.channel.createMany({
    data: [
      {
        id: publicChannelId,
        label: `pub-${suite}`,
        organizationId: orgId,
        projectId,
        slug: `pub-${suite}`,
        teamId,
        visibility: 'public',
      },
      {
        id: privateChannelId,
        label: `priv-${suite}`,
        organizationId: orgId,
        projectId,
        slug: `priv-${suite}`,
        teamId,
        visibility: 'private',
      },
    ],
  })
}

const cleanup = async (prisma: PrismaClient) => {
  await prisma.agent.deleteMany({ where: { organizationId: orgId } })
  await prisma.channel.deleteMany({ where: { id: { in: [publicChannelId, privateChannelId] } } })
  await prisma.team.deleteMany({ where: { id: teamId } })
  await prisma.project.deleteMany({ where: { id: projectId } })
  await prisma.organizationMember.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
}

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

const createPrivateAgent = (prisma: PrismaClient) =>
  createAgentRecord(prisma, {
    name: `private-${suite}`,
    organizationId: orgId,
    ownerUserId: stewardUserId,
    role: 'assistant',
    teamId,
    visibility: 'private',
  })

const createPersonOwnedAgent = (prisma: PrismaClient) =>
  createAgentRecord(prisma, {
    name: `person-owned-${suite}`,
    organizationId: orgId,
    ownerUserId: stewardUserId,
    projectId,
    role: 'assistant',
    teamId,
  })

/** No `ownerUserId`: the pre-stewardship shape, now read as "team-owned". */
const createTeamOwnedAgent = async (prisma: PrismaClient, channelId: string) => {
  const agent = await createAgentRecord(prisma, {
    name: `team-owned-${suite}`,
    organizationId: orgId,
    projectId,
    role: 'assistant',
    teamId,
  })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId } })
  return agent
}

const rowFor = (prisma: PrismaClient, agentId: string) =>
  prisma.agent.findUniqueOrThrow({
    select: {
      id: true,
      organizationId: true,
      ownerUserId: true,
      systemManaged: true,
      todosEnabled: true,
      visibility: true,
    },
    where: { id: agentId },
  })

dbTest('a private agent is editable by its live owner and by nobody else', async () => {
  await withDb(async (prisma) => {
    const agent = await createPrivateAgent(prisma)
    const row = await rowFor(prisma, agent.id)

    assert.equal(await canEditAgent(prisma, actor(stewardUserId), row), true)

    // The headline fix: an ordinary member edits the private agent they own.
    const renamed = await updateAgentRecord(prisma, agent.id, actor(stewardUserId), {
      name: `private-renamed-${suite}`,
      organizationId: orgId,
    })
    assert.equal(renamed?.name, `private-renamed-${suite}`)

    // Private beats organization-owner omniscience: an org owner cannot see
    // this agent at all, so there is nothing here for them to edit.
    for (const userId of [orgOwnerUserId, otherMemberUserId]) {
      const authority = await resolveAgentEditAuthority(prisma, actor(userId), row)
      assert.equal(authority.canEdit, false)
      assert.equal(
        authority.refusal?.code,
        AGENT_EDIT_AUTHORITY_ERROR_CODES.PRIVATE_OWNER_ONLY,
      )
      await assert.rejects(
        () => updateAgentRecord(prisma, agent.id, actor(userId), {
          name: 'taken over',
          organizationId: orgId,
        }),
        (error: unknown) => error instanceof AgentEditAuthorityError
          && error.code === AGENT_EDIT_AUTHORITY_ERROR_CODES.PRIVATE_OWNER_ONLY,
      )
    }

    const unchanged = await prisma.agent.findUniqueOrThrow({
      select: { name: true },
      where: { id: agent.id },
    })
    assert.equal(unchanged.name, `private-renamed-${suite}`)
  })
})

dbTest('a person-owned team agent refuses another member and admits an org owner', async () => {
  await withDb(async (prisma) => {
    const agent = await createPersonOwnedAgent(prisma)
    await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: publicChannelId } })
    const row = await rowFor(prisma, agent.id)

    // Entitled to SEE it (public channel binding) but not to rewrite it, and
    // the refusal names the person to ask.
    const authority = await resolveAgentEditAuthority(prisma, actor(otherMemberUserId), row)
    assert.equal(authority.canEdit, false)
    assert.equal(authority.refusal?.code, AGENT_EDIT_AUTHORITY_ERROR_CODES.OWNER_ONLY)
    assert.match(authority.refusal?.message ?? '', /Edit authority 0/)

    await assert.rejects(
      () => updateAgentRecord(prisma, agent.id, actor(otherMemberUserId), {
        organizationId: orgId,
        systemPrompt: 'rewritten by a stranger',
      }),
      (error: unknown) => error instanceof AgentEditAuthorityError
        && error.code === AGENT_EDIT_AUTHORITY_ERROR_CODES.OWNER_ONLY,
    )

    // The steward edits; the governance override lets an org owner edit too.
    assert.equal(await canEditAgent(prisma, actor(stewardUserId), row), true)
    assert.equal(await canEditAgent(prisma, actor(orgOwnerUserId), row), true)
    const updated = await updateAgentRecord(prisma, agent.id, actor(orgOwnerUserId), {
      organizationId: orgId,
      systemPrompt: 'rewritten by the org owner',
    })
    assert.equal(updated?.systemPrompt, 'rewritten by the org owner')
  })
})

dbTest('a team-owned agent is editable by any entitled member, and not by others', async () => {
  await withDb(async (prisma) => {
    const agent = await createTeamOwnedAgent(prisma, publicChannelId)
    const row = await rowFor(prisma, agent.id)

    // The deliberate widening: seeing a team-owned agent through a channel you
    // can read IS the edit entitlement.
    assert.equal(await canEditAgent(prisma, actor(otherMemberUserId), row), true)
    const updated = await updateAgentRecord(prisma, agent.id, actor(otherMemberUserId), {
      organizationId: orgId,
      systemPrompt: 'improved in place by a team-mate',
    })
    assert.equal(updated?.systemPrompt, 'improved in place by a team-mate')

    // A deactivated membership row satisfies the composite foreign key but is
    // not entitlement — owner-ness is re-derived live on every call.
    const departed = await resolveAgentEditAuthority(prisma, actor(departedUserId), row)
    assert.equal(departed.canEdit, false)
    assert.equal(
      departed.refusal?.code,
      AGENT_EDIT_AUTHORITY_ERROR_CODES.MEMBERSHIP_INACTIVE,
    )
    // Somebody with no membership row at all is refused the same way.
    assert.equal(await canEditAgent(prisma, actor(outsiderUserId), row), false)
  })
})

dbTest('a team-owned agent reachable through no visible channel is not editable', async () => {
  await withDb(async (prisma) => {
    // Bound only into a private channel this member does not belong to.
    const agent = await createTeamOwnedAgent(prisma, privateChannelId)
    const row = await rowFor(prisma, agent.id)

    const authority = await resolveAgentEditAuthority(prisma, actor(otherMemberUserId), row)
    assert.equal(authority.canEdit, false)
    assert.equal(authority.refusal?.code, AGENT_EDIT_AUTHORITY_ERROR_CODES.NOT_ENTITLED)

    // An org owner still reaches every team agent.
    assert.equal(await canEditAgent(prisma, actor(orgOwnerUserId), row), true)
  })
})

dbTest('transfer, claim and todosEnabled are narrower than editing', async () => {
  await withDb(async (prisma) => {
    const teamOwned = await createTeamOwnedAgent(prisma, publicChannelId)

    // A mere editor may improve the agent but may not claim it — an edit helps
    // everyone, a claim locks everyone else out.
    await assert.rejects(
      () => updateAgentRecord(prisma, teamOwned.id, actor(otherMemberUserId), {
        organizationId: orgId,
        ownerUserId: otherMemberUserId,
      }),
      (error: unknown) => error instanceof AgentEditAuthorityError
        && error.code === AGENT_EDIT_AUTHORITY_ERROR_CODES.OWNERSHIP_FORBIDDEN,
    )
    // …nor switch on the owner-gated to-do capability.
    await assert.rejects(
      () => updateAgentRecord(prisma, teamOwned.id, actor(otherMemberUserId), {
        organizationId: orgId,
        todosEnabled: true,
      }),
      (error: unknown) => error instanceof AgentEditAuthorityError
        && error.code === AGENT_EDIT_AUTHORITY_ERROR_CODES.TODOS_OWNER_REQUIRED,
    )
    // Echoing the stored value back is not an attempt to toggle it, so an
    // ordinary edit that carries the field still goes through.
    const echoed = await updateAgentRecord(prisma, teamOwned.id, actor(otherMemberUserId), {
      organizationId: orgId,
      role: 'analyst',
      todosEnabled: false,
    })
    assert.equal(echoed?.role, 'analyst')

    // An org owner may claim a team-owned agent.
    const claimed = await updateAgentRecord(prisma, teamOwned.id, actor(orgOwnerUserId), {
      organizationId: orgId,
      ownerUserId: stewardUserId,
    })
    assert.equal(claimed?.ownerUserId, stewardUserId)

    // …and the steward may release it back to the team.
    const released = await updateAgentRecord(prisma, teamOwned.id, actor(stewardUserId), {
      organizationId: orgId,
      ownerUserId: null,
    })
    assert.equal(released?.ownerUserId ?? null, null)
  })
})

dbTest('a private agent still refuses transfer, for its owner too', async () => {
  await withDb(async (prisma) => {
    const agent = await createPrivateAgent(prisma)
    await assert.rejects(
      () => updateAgentRecord(prisma, agent.id, actor(stewardUserId), {
        organizationId: orgId,
        ownerUserId: null,
      }),
      (error: unknown) => error instanceof AgentManagementError
        && error.code === AGENT_MANAGEMENT_ERROR_CODES.PRIVATE_TRANSFER_UNSUPPORTED,
    )
  })
})

dbTest('a system-managed agent is refused in the service, org owner included', async () => {
  await withDb(async (prisma) => {
    const agent = await createTeamOwnedAgent(prisma, publicChannelId)
    await prisma.agent.update({ data: { systemManaged: true }, where: { id: agent.id } })
    const row = await rowFor(prisma, agent.id)

    assert.equal(await canEditAgent(prisma, actor(orgOwnerUserId), row), false)
    for (const service of [
      () => updateAgentRecord(prisma, agent.id, actor(orgOwnerUserId), {
        organizationId: orgId,
        systemPrompt: 'rewriting the blueprint',
      }),
      () => updateAgentAvatar(prisma, agent.id, actor(orgOwnerUserId), null),
    ]) {
      await assert.rejects(
        service,
        (error: unknown) => error instanceof AgentEditAuthorityError
          && error.code === AGENT_EDIT_AUTHORITY_ERROR_CODES.SYSTEM_IMMUTABLE,
      )
    }
  })
})

dbTest('an explicit-grant tool-policy key stays refused for every editor', async () => {
  await withDb(async (prisma) => {
    const protectedEntry = await prisma.toolRegistryEntry.create({
      data: {
        description: 'Starts a managed research job.',
        handlerKind: 'mcp',
        inputSchema: { type: 'object' },
        label: 'Research start',
        metadata: { requiresExplicitGrant: true },
        overview: 'Starts a managed research job.',
        scopeKey: `edit-authority-${suite}`,
        toolId: `mcp:deep-water:research_start:${suite}`,
      },
    })
    try {
      const agent = await createTeamOwnedAgent(prisma, publicChannelId)
      // The widened edit authority does not widen what may be written: the
      // protected-key gate is the law for an org owner and a team-mate alike.
      for (const userId of [otherMemberUserId, orgOwnerUserId]) {
        await assert.rejects(
          () => updateAgentRecord(prisma, agent.id, actor(userId), {
            organizationId: orgId,
            toolPolicy: { [protectedEntry.id]: true },
          }),
          (error: unknown) => error instanceof AgentToolPolicyError,
        )
      }
    } finally {
      await prisma.toolRegistryEntry.deleteMany({ where: { id: protectedEntry.id } })
    }
  })
})

dbTest('the avatar service follows the same rule as the rest of the configuration', async () => {
  await withDb(async (prisma) => {
    const agent = await createPersonOwnedAgent(prisma)
    await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: publicChannelId } })

    await assert.rejects(
      () => updateAgentAvatar(prisma, agent.id, actor(otherMemberUserId), null, '#F8D7DA'),
      (error: unknown) => error instanceof AgentEditAuthorityError
        && error.code === AGENT_EDIT_AUTHORITY_ERROR_CODES.OWNER_ONLY,
    )

    const updated = await updateAgentAvatar(prisma, agent.id, actor(stewardUserId), null, '#F8D7DA')
    assert.equal(updated?.avatarBackgroundColor, '#F8D7DA')
  })
})
