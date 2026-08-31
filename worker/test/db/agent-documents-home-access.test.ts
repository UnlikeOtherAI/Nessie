import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { createNativeKnowledgeProvider, ensureAgentDocsSpace } from '@nessie/knowledge'

import { runKbPageReadTool, runKbSearchTool } from '../../src/run/pa-tools/knowledge.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { runDatabaseTest } from './support.js'

runDatabaseTest('a subtask child reads and searches the production-shaped parent documents home', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: `agent-home-${suffix}` } })
  const project = await prisma.project.create({
    data: { name: `agent-home-project-${suffix}`, organizationId: organization.id },
  })
  const parent = await prisma.agent.create({
    data: { name: `Parent ${suffix}`, organizationId: organization.id, role: 'researcher' },
  })
  const child = await prisma.agent.create({
    data: {
      name: `Child ${suffix}`,
      organizationId: organization.id,
      parentAgentId: parent.id,
      role: 'researcher',
    },
  })
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: organization.id } })
    await prisma.$disconnect()
  })

  const home = await ensureAgentDocsSpace(prisma, {
    agentId: parent.id,
    agentName: parent.name,
    organizationId: organization.id,
    projectId: project.id,
  })
  const page = await createNativeKnowledgeProvider(prisma).createPage({
    authorId: parent.id,
    authorType: 'agent',
    body: 'The comet checklist says to verify the navigation beacon.',
    createdBy: parent.id,
    organizationId: organization.id,
    projectId: project.id,
    spaceId: home.spaceId,
    title: 'Comet checklist',
  })

  const context = {
    agentId: child.id,
    agentKind: 'shared',
    actorContext: {
      actor: { actorId: child.id, actorType: 'agent', roles: [] },
      actionContext: {},
      tenant: { organizationId: organization.id },
    },
    channel: { id: randomUUID(), organizationId: organization.id, systemChannelType: null },
    prisma,
    realtimeTransport: {},
    run: { id: randomUUID(), messageId: randomUUID(), threadId: randomUUID() },
  } as unknown as BuiltinToolRuntimeContext

  const [read, search] = await Promise.all([
    runKbPageReadTool(context, { pageId: page.id }),
    runKbSearchTool(context, { query: 'navigation beacon', spaceId: home.spaceId }),
  ])

  assert.match(read.outputPreview, /verify the navigation beacon/)
  assert.match(search.outputPreview, /Comet checklist/)
})
