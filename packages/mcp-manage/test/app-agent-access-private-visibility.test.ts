import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { createAgentRecord } from '@nessie/team-admin'

import { listAgentsWithAppAccess } from '../src/apps/app-agent-access.js'

const databaseTest = process.env.DATABASE_URL ? test : test.skip

databaseTest('an org owner never receives another member’s private agent on the app surface', async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const privateOwnerId = randomUUID()
  const orgOwnerId = randomUUID()

  try {
    await prisma.organization.create({ data: { id: organizationId, name: `app-access-${organizationId}` } })
    await prisma.user.createMany({
      data: [
        { displayName: 'Private owner', email: `${privateOwnerId}@test.local`, id: privateOwnerId },
        { displayName: 'Org owner', email: `${orgOwnerId}@test.local`, id: orgOwnerId },
      ],
    })
    await prisma.organizationMember.createMany({
      data: [
        { organizationId, role: 'member', userId: privateOwnerId },
        { organizationId, role: 'owner', userId: orgOwnerId },
      ],
    })
    const project = await prisma.project.create({ data: { name: 'App access', organizationId } })
    const team = await prisma.team.create({ data: { name: 'App access', projectId: project.id } })
    const privateAgent = await createAgentRecord(prisma, {
      name: 'Salary model — do not share',
      organizationId,
      ownerUserId: privateOwnerId,
      role: 'assistant',
      teamId: team.id,
      visibility: 'private',
    })
    const teamAgent = await createAgentRecord(prisma, {
      name: 'Team helper',
      organizationId,
      ownerUserId: privateOwnerId,
      role: 'assistant',
      teamId: team.id,
    })

    const actorContext = {
      actionContext: { requestId: `app-access-${organizationId}` },
      actor: { actorId: orgOwnerId, actorType: 'user', roles: ['owner'] },
      tenant: { organizationId },
    } as unknown as AuthorizedActionContext
    const instanceId = randomUUID()
    const agents = await listAgentsWithAppAccess(
      prisma,
      actorContext,
      [{ id: instanceId, scopeId: organizationId, scopeType: 'organization' }],
      [{ enabled: true, id: randomUUID(), mcpInstanceId: instanceId, metadata: {}, status: 'active' }],
    )

    assert.deepEqual(agents.map((agent) => agent.agentId), [teamAgent.id])
    assert.equal(agents.some((agent) => agent.agentId === privateAgent.id), false)
  } finally {
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: [privateOwnerId, orgOwnerId] } } })
    await prisma.$disconnect()
  }
})
