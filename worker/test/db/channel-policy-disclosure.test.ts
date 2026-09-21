import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { DEFAULT_CHANNEL_DECISION_POLICY } from '@nessie/schemas'
import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import { runChannelUpdateTool } from '../../src/run/pa-tools/channels.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { runDatabaseTest } from './support.js'

runDatabaseTest('PA decision policies cannot publish restricted context into a wider channel', async (t) => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userId = randomUUID()
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.$disconnect()
  })
  await prisma.organization.create({ data: { id: organizationId, name: 'Policy disclosure test' } })
  await prisma.user.create({ data: { id: userId, displayName: 'Policy author', email: `${userId}@example.test` } })
  await prisma.organizationMember.create({ data: { organizationId, userId, role: 'owner' } })
  const project = await prisma.project.create({ data: { organizationId, name: 'Project' } })
  const team = await prisma.team.create({ data: { projectId: project.id, name: 'Team' } })
  const channel = (slug: string, visibility: 'public' | 'protected') => prisma.channel.create({ data: {
    organizationId, projectId: project.id, teamId: team.id, label: slug, slug, visibility,
    members: { create: { userId } },
  } })
  const source = await channel('private-source', 'protected')
  const destination = await channel('public-destination', 'public')
  const consumedSources = createConsumedSourceSink()
  consumedSources.addPrivateConversationSource({ sourceAuthorUserId: userId, sourceChannelId: source.id })
  const context = {
    actorContext: {
      actionContext: { effectiveUserId: userId, requestId: randomUUID() },
      actor: { actorId: userId, actorType: 'user', roles: ['owner'] },
      tenant: { organizationId, projectId: project.id, teamId: team.id },
    },
    agentId: randomUUID(), agentKind: 'personal_assistant',
    channel: { id: source.id, organizationId, projectId: project.id, teamId: team.id },
    consumedSources, prisma,
  } as unknown as BuiltinToolRuntimeContext
  const policy = { ...DEFAULT_CHANNEL_DECISION_POLICY, instructions: 'Restricted decision details.' }

  await assert.rejects(
    runChannelUpdateTool(context, { channelId: destination.id, decisionPolicy: policy, topic: 'Must not be written' }),
    /cannot copy restricted information/,
  )
  const unchanged = await prisma.channel.findUniqueOrThrow({ where: { id: destination.id } })
  assert.equal(unchanged.decisionPolicy, null)
  assert.equal(unchanged.topic, null)
  assert.equal(await prisma.auditLog.count({ where: { organizationId, resourceId: destination.id } }), 0)

  // The channel already implies its own source, so editing its policy is safe.
  await runChannelUpdateTool(context, { channelId: source.id, decisionPolicy: policy })
  assert.deepEqual((await prisma.channel.findUniqueOrThrow({ where: { id: source.id } })).decisionPolicy, policy)

  // A personal document is narrower even than this private channel.
  consumedSources.add({ scopeType: 'user', scopeId: userId })
  await assert.rejects(runChannelUpdateTool(context, { channelId: source.id, decisionPolicy: policy }),
    /cannot copy restricted information/)

  // Removing instructions introduces no source material and remains available.
  await runChannelUpdateTool(context, { channelId: source.id, decisionPolicy: null })
  assert.equal((await prisma.channel.findUniqueOrThrow({ where: { id: source.id } })).decisionPolicy, null)

  context.consumedSources = undefined
  await assert.rejects(runChannelUpdateTool(context, { channelId: destination.id, decisionPolicy: policy }),
    /without a disclosure provenance sink/)
  context.consumedSources = createConsumedSourceSink()
  await runChannelUpdateTool(context, { channelId: destination.id, decisionPolicy: policy })
  assert.deepEqual((await prisma.channel.findUniqueOrThrow({ where: { id: destination.id } })).decisionPolicy, policy)
})
