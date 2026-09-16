import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  parseOrganizationId,
  parseTeamId,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import { buildVisibleAgentWhere } from '@nessie/db'

import { deleteAgent } from '../src/services/agent-delete.js'

/**
 * Deleting an agent, against a real database.
 *
 * The soft delete itself is one column. Everything that matters is the
 * revocation around it: **a row that still exists is a row that still works**,
 * so a delete that only stamps `deletedAt` leaves an agent that keeps waking in
 * channels, keeps firing triggers and keeps authorising tools. Each case below
 * asserts a capability is GONE rather than that the timestamp is set.
 *
 * A Prisma fake could not hold any of this: the cascade behaviour, the
 * `onDelete: NoAction` knowledge-space foreign key and the `@unique` mailbox
 * constraint are all database facts.
 */

const suite = 'd7b2'
const orgId = `00000000-0000-4000-8000-${suite}00000001`
const projectId = `00000000-0000-4000-8000-${suite}00000002`
const teamId = `00000000-0000-4000-8000-${suite}00000003`
const channelId = `00000000-0000-4000-8000-${suite}00000004`

const agentId = `00000000-0000-4000-8000-${suite}00000010`
const systemAgentId = `00000000-0000-4000-8000-${suite}00000011`
const privateAgentId = `00000000-0000-4000-8000-${suite}00000012`

const stewardUserId = `00000000-0000-4000-8000-${suite}00000020`
const memberUserId = `00000000-0000-4000-8000-${suite}00000021`
const adminUserId = `00000000-0000-4000-8000-${suite}00000022`

const userIds = [stewardUserId, memberUserId, adminUserId]

const dbTest = process.env.DATABASE_URL ? test : test.skip

const actorFor = (userId: string, role = 'member'): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: userId, roles: [role] },
  tenant: { organizationId: parseOrganizationId(orgId), teamId: parseTeamId(teamId) },
  actionContext: { requestId: `req-agent-delete-${userId}`, teamId: parseTeamId(teamId) },
})

const seed = async (prisma: PrismaClient) => {
  await prisma.organization.create({ data: { id: orgId, name: `agent-delete-${suite}` } })
  await prisma.user.createMany({
    data: userIds.map((id, index) => ({
      displayName: `Agent delete ${index}`,
      email: `agent-delete-${suite}-${index}@test.local`,
      id,
    })),
  })
  await prisma.organizationMember.createMany({
    data: userIds.map((userId) => ({
      organizationId: orgId,
      role: userId === adminUserId ? 'admin' : 'member',
      userId,
    })),
  })
  await prisma.project.create({ data: { id: projectId, name: `p-${suite}`, organizationId: orgId } })
  await prisma.team.create({ data: { id: teamId, name: `t-${suite}`, projectId } })
  await prisma.channel.create({
    data: {
      id: channelId,
      label: `room-${suite}`,
      organizationId: orgId,
      projectId,
      slug: `room-${suite}`,
      teamId,
      visibility: 'public',
    },
  })

  await prisma.agent.createMany({
    data: [
      { id: agentId, name: `Researcher ${suite}`, organizationId: orgId, ownerUserId: stewardUserId },
      {
        id: systemAgentId,
        name: `System ${suite}`,
        organizationId: orgId,
        systemManaged: true,
      },
      {
        id: privateAgentId,
        name: `Private ${suite}`,
        organizationId: orgId,
        ownerUserId: stewardUserId,
        visibility: 'private',
      },
    ],
  })

  // The live capabilities the delete has to revoke.
  await prisma.agentBinding.create({ data: { agentId, channelId } })
  await prisma.agentTrigger.create({
    data: { agentId, name: `trigger-${suite}`, type: 'scheduled' },
  })
  await prisma.knowledgeSpace.create({
    data: {
      id: `00000000-0000-4000-8000-${suite}00000030`,
      name: `Researcher ${suite} — Documents`,
      organizationId: orgId,
      ownerAgentId: agentId,
      projectId,
      createdBy: stewardUserId,
      // `knowledge_spaces_owner_agent_private_chk`: an agent-owned space must be
      // `private`. Detaching the owner on delete is therefore the only move —
      // the space stays valid with a null owner, while flipping its visibility
      // instead would widen who can read the agent's documents.
      visibility: 'private',
    },
  })
}

const cleanup = async (prisma: PrismaClient) => {
  await prisma.knowledgeSpace.updateMany({
    where: { organizationId: orgId },
    data: { ownerAgentId: null },
  })
  await prisma.knowledgeSpace.deleteMany({ where: { organizationId: orgId } })
  await prisma.agentTrigger.deleteMany({ where: { agent: { organizationId: orgId } } })
  await prisma.agentBinding.deleteMany({ where: { channel: { organizationId: orgId } } })
  await prisma.agent.deleteMany({ where: { organizationId: orgId } })
  await prisma.channelMember.deleteMany({ where: { channel: { organizationId: orgId } } })
  await prisma.thread.deleteMany({ where: { channel: { organizationId: orgId } } })
  await prisma.channel.deleteMany({ where: { organizationId: orgId } })
  await prisma.team.deleteMany({ where: { id: teamId } })
  await prisma.project.deleteMany({ where: { organizationId: orgId } })
  await prisma.organizationMember.deleteMany({ where: { organizationId: orgId } })
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

dbTest('the delete revokes every live capability and keeps the row', async () => {
  await withDb(async (prisma) => {
    const outcome = await deleteAgent(prisma, actorFor(stewardUserId), agentId)
    assert.equal(outcome.kind, 'deleted')

    // The row survives — this is what makes the audit history readable.
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
    assert.notEqual(row.deletedAt, null)

    // …and every live capability is gone.
    assert.equal(await prisma.agentBinding.count({ where: { agentId } }), 0, 'bindings')
    assert.equal(await prisma.agentTrigger.count({ where: { agentId } }), 0, 'triggers')

    // The auto-created documents space is DETACHED, not deleted: its pages are
    // the project's work, and its foreign key is `onDelete: NoAction`.
    const space = await prisma.knowledgeSpace.findFirstOrThrow({
      where: { organizationId: orgId },
    })
    assert.equal(space.ownerAgentId, null, 'the space is detached, not removed')
  })
})

/**
 * The filter that actually makes the agent disappear. `buildVisibleAgentWhere`
 * is the single predicate every agent list composes, so this is the one place
 * the exclusion has to hold.
 */
dbTest('a soft-deleted agent is gone from every entitled read', async () => {
  await withDb(async (prisma) => {
    const visible = async () =>
      (await prisma.agent.findMany({
        where: buildVisibleAgentWhere({ organizationId: orgId, userId: stewardUserId }),
        select: { id: true },
      })).map((agent) => agent.id)

    assert.ok((await visible()).includes(agentId), 'listed while live')
    await deleteAgent(prisma, actorFor(stewardUserId), agentId)
    assert.ok(!(await visible()).includes(agentId), 'and gone once deleted')
  })
})

dbTest('deleting twice is not found the second time, and discloses nothing', async () => {
  await withDb(async (prisma) => {
    assert.equal((await deleteAgent(prisma, actorFor(stewardUserId), agentId)).kind, 'deleted')
    assert.equal((await deleteAgent(prisma, actorFor(stewardUserId), agentId)).kind, 'not_found')
  })
})

dbTest('a system-managed agent is refused with its own code, never merely hidden', async () => {
  await withDb(async (prisma) => {
    const outcome = await deleteAgent(prisma, actorFor(adminUserId, 'admin'), systemAgentId)
    assert.equal(outcome.kind, 'refused')
    assert.equal(outcome.kind === 'refused' && outcome.code, 'SYSTEM_AGENT_IMMUTABLE')
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: systemAgentId } })
    assert.equal(row.deletedAt, null, 'and it is still there')
  })
})

dbTest('an ordinary member cannot delete somebody else\'s person-owned agent', async () => {
  await withDb(async (prisma) => {
    const outcome = await deleteAgent(prisma, actorFor(memberUserId), agentId)
    assert.equal(outcome.kind, 'refused')
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
    assert.equal(row.deletedAt, null)
  })
})

/**
 * The widening, and its limit. An organisation admin deletes a person-owned
 * agent they did not create; a PRIVATE agent stays its live owner's alone,
 * because an admin cannot even see it.
 */
dbTest('an organisation admin deletes a person-owned agent but never a private one', async () => {
  await withDb(async (prisma) => {
    assert.equal(
      (await deleteAgent(prisma, actorFor(adminUserId, 'admin'), agentId)).kind,
      'deleted',
    )

    const refusal = await deleteAgent(prisma, actorFor(adminUserId, 'admin'), privateAgentId)
    assert.equal(refusal.kind, 'refused')
    assert.equal(
      refusal.kind === 'refused' && refusal.code,
      'AGENT_EDIT_PRIVATE_OWNER_ONLY',
    )
    const kept = await prisma.agent.findUniqueOrThrow({ where: { id: privateAgentId } })
    assert.equal(kept.deletedAt, null)
  })
})

dbTest('an agent in another organisation is not found', async () => {
  await withDb(async (prisma) => {
    const stranger: AuthorizedActionContext = {
      ...actorFor(adminUserId, 'admin'),
      tenant: { organizationId: parseOrganizationId(projectId), teamId: parseTeamId(teamId) },
    }
    assert.equal((await deleteAgent(prisma, stranger, agentId)).kind, 'not_found')
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
    assert.equal(row.deletedAt, null)
  })
})
