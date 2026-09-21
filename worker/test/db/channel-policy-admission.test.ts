import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { RunExecuteJobPayloadSchema } from '@nessie/schemas'
import { ChannelDecisionPolicyError } from '@nessie/team-admin'
import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import { revalidateChannelPolicyRun } from '../../src/run/execute/channel-policy-admission.js'
import type { RunContext } from '../../src/run/execute/types.js'
import { runDatabaseTest } from './support.js'

runDatabaseTest('queued policy admission refreshes authority and refuses newly unreadable saved context', async (t) => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userId = randomUUID()
  const agentId = randomUUID()
  t.after(async () => {
    await prisma.agent.deleteMany({ where: { id: agentId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.$disconnect()
  })
  await prisma.organization.create({ data: { id: organizationId, name: 'Policy admission test' } })
  await prisma.user.create({ data: { id: userId, displayName: 'Author', email: `${userId}@example.test` } })
  await prisma.organizationMember.create({ data: { organizationId, userId, role: 'admin' } })
  const project = await prisma.project.create({ data: { organizationId, name: 'Project' } })
  const team = await prisma.team.create({ data: { projectId: project.id, name: 'Team' } })
  const channel = await prisma.channel.create({ data: {
    organizationId, projectId: project.id, teamId: team.id, slug: 'admission', label: 'Admission', visibility: 'public',
  } })
  await prisma.agent.create({ data: { id: agentId, organizationId, name: 'Policy agent' } })
  await prisma.agentBinding.create({ data: { agentId, channelId: channel.id } })
  const payload = RunExecuteJobPayloadSchema.parse({
    actorContext: {
      actor: { actorId: userId, actorType: 'user', roles: ['owner'] },
      tenant: { organizationId, projectId: project.id, teamId: team.id },
      actionContext: {
        channelId: channel.id, effectiveUserId: userId, requestId: randomUUID(), purpose: 'channel.policy',
      },
    },
    agentId, interactive: false, messageId: randomUUID(), runId: randomUUID(),
    taskId: randomUUID(), threadId: randomUUID(),
  })
  const consumedSources = createConsumedSourceSink()
  const context = { channel, consumedSources } as unknown as Pick<RunContext, 'channel' | 'consumedSources'>
  const admitted = await revalidateChannelPolicyRun(prisma, payload, context)
  assert.deepEqual(admitted.actorContext.actor.roles, ['admin'])
  assert.equal(admitted.runId, payload.runId)

  consumedSources.add({ scopeType: 'user', scopeId: randomUUID() })
  await assert.rejects(revalidateChannelPolicyRun(prisma, payload, context), /can no longer read its saved context/)

  await prisma.organizationMember.update({
    where: { organizationId_userId: { organizationId, userId } }, data: { deactivatedAt: new Date() },
  })
  await assert.rejects(revalidateChannelPolicyRun(prisma, payload, {
    ...context, consumedSources: createConsumedSourceSink(),
  }), (error: unknown) => error instanceof ChannelDecisionPolicyError && /has lost access/.test(error.message))
})
