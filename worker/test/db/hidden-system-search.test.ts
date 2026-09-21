import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { createPgPool } from '@nessie/runtime'
import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import { runAuthoredMessageSearchTool, runTeamSearchTool } from '../../src/run/pa-tools/conversation-search.js'
import { runMessageSearchTool } from '../../src/run/pa-tools/agent-messages.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { runDatabaseTest } from './support.js'

runDatabaseTest('PA conversation searches exclude internal system prompts even without basis rows', async (t) => {
  const prisma = new PrismaClient()
  const pool = createPgPool(process.env.DATABASE_URL!, { max: 2, min: 0 })
  const organizationId = randomUUID()
  const userId = randomUUID()
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.$disconnect()
    await pool.end()
  })
  await prisma.organization.create({ data: { id: organizationId, name: 'Hidden search test' } })
  await prisma.user.create({ data: { id: userId, displayName: 'Reader', email: `${userId}@example.test` } })
  await prisma.organizationMember.create({ data: { organizationId, userId, role: 'member' } })
  const project = await prisma.project.create({ data: { organizationId, name: 'Project' } })
  const team = await prisma.team.create({ data: { projectId: project.id, name: 'Team' } })
  const channel = await prisma.channel.create({ data: {
    organizationId, projectId: project.id, teamId: team.id, label: 'Conversation', slug: 'conversation',
    visibility: 'protected', members: { create: { userId } },
  } })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const visible = await prisma.message.create({ data: {
    threadId: thread.id, role: 'user', userId, content: 'reportneedle visible conversation',
  } })
  // Legacy kickoffs may carry an attributed user, so authored search must also
  // exclude their role rather than treating the user id as proof of visibility.
  const hidden = await prisma.message.create({ data: {
    threadId: thread.id, role: 'system', userId, content: 'reportneedle hidden internal instructions',
  } })
  const context = {
    actorContext: {
      actor: { actorType: 'user', actorId: userId }, tenant: { organizationId },
      actionContext: { effectiveUserId: userId, requestId: randomUUID() },
    },
    agentKind: 'personal_assistant', agentId: randomUUID(),
    channel, consumedSources: createConsumedSourceSink(), memoryCaptureConfig: { pool }, prisma,
  } as unknown as BuiltinToolRuntimeContext
  const results = await Promise.all([
    runTeamSearchTool(context, 'reportneedle'),
    runAuthoredMessageSearchTool(context, 'reportneedle'),
    runMessageSearchTool(context, { query: 'reportneedle' }),
  ])
  for (const result of results) {
    assert.ok(result.outputPreview?.includes(visible.id))
    assert.ok(result.outputPreview?.includes('visible conversation'))
    assert.ok(!result.outputPreview?.includes(hidden.id))
    assert.ok(!result.outputPreview?.includes('hidden internal instructions'))
  }
})
