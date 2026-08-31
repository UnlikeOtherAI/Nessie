import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { MockLlmEngine, parseScenario } from '@nessie/mock-llm'
import type { AuthorizedActionContext } from '@nessie/schemas'
import test from 'node:test'

import { validateWorkflowGraphSteps } from '../../../api/src/services/workflow-validation.js'
import { generalizeDemonstration } from '../../src/control/demonstration-generalize.js'
import { runDatabaseTest } from './support.js'

const scriptedGeneralization = (outputs: string[]) => {
  const engine = new MockLlmEngine(parseScenario({
    name: 'demonstration-generalization',
    turns: outputs.map((text) => ({ latencyMs: 0, text, toolCalls: [], usage: {} })),
  }))
  let calls = 0
  return async () => {
    const outcome = await engine.next(calls++ === 0 ? [] : [{ content: 'retry', role: 'assistant' }])
    assert.equal(outcome.kind, 'completion')
    return outcome.text
  }
}

runDatabaseTest('a captured demonstration generalizes through the mock-LLM into a validator-safe learned Workflow draft', async (t) => {
  const prisma = new PrismaClient()
  const organization = await prisma.organization.create({ data: { name: `generalize-${randomUUID()}` } })
  const user = await prisma.user.create({
    data: { displayName: 'Demonstrator', email: `generalize-${randomUUID()}@example.test` },
  })
  await prisma.organizationMember.create({ data: { organizationId: organization.id, userId: user.id } })
  const project = await prisma.project.create({ data: { name: 'Generalize', organizationId: organization.id } })
  const team = await prisma.team.create({ data: { name: 'Generalize', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: `generalize-${randomUUID()}`,
      organizationId: organization.id,
      projectId: project.id,
      slug: `generalize-${randomUUID()}`,
      teamId: team.id,
      visibility: 'private',
    },
  })
  await prisma.channelMember.create({ data: { channelId: channel.id, userId: user.id } })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const agent = await prisma.agent.create({
    data: { name: 'Demonstrator agent', organizationId: organization.id, projectId: project.id, teamId: team.id },
  })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: channel.id } })
  const demonstration = await prisma.demonstration.create({
    data: {
      agentId: agent.id,
      capturedAt: new Date(),
      channelId: channel.id,
      expiresAt: new Date(Date.now() + 60_000),
      organizationId: organization.id,
      startedByUserId: user.id,
      status: 'captured',
      threadId: thread.id,
    },
  })
  await prisma.demonstrationStep.create({
    data: {
      agentId: agent.id,
      argumentsJson: { url: 'https://example.test/release-notes' },
      demonstrationId: demonstration.id,
      durationMs: 1,
      endedAt: new Date(),
      sequence: 1,
      startedAt: new Date(),
      success: true,
      toolName: 'executor.browser.open',
    },
  })
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: organization.id } })
    await prisma.user.deleteMany({ where: { id: user.id } })
    await prisma.$disconnect()
  })

  const model = scriptedGeneralization([
    JSON.stringify({
      name: 'Release notes routine',
      steps: [{ expression: '[', type: 'transform' }],
    }),
    JSON.stringify({
      name: 'Release notes routine',
      steps: [{ instruction: 'Review the release notes and explain the changes.', type: 'executor.browser.open' }],
      variableSchema: { releaseUrl: { type: 'string' } },
    }),
  ])
  await generalizeDemonstration(prisma, { demonstrationId: demonstration.id }, model)

  const template = await prisma.workflowTemplate.findUniqueOrThrow({
    where: { demonstrationId: demonstration.id },
  })
  assert.equal(template.source, 'demonstration')
  assert.ok(template.adoptedAt)
  assert.equal((template.graphJson as { steps: Array<{ type: string }> }).steps[0]?.type, 'agent_task')
  const context: AuthorizedActionContext = {
    actionContext: { requestId: randomUUID() },
    actor: { actorId: user.id, actorType: 'user', roles: ['member'] },
    tenant: { organizationId: organization.id },
  }
  await validateWorkflowGraphSteps(prisma, context, template.graphJson as {
    steps: Array<{ id: string; input?: Record<string, unknown>; title?: string; type: string }>
  })
  const updated = await prisma.demonstration.findUniqueOrThrow({ where: { id: demonstration.id } })
  assert.equal(updated.status, 'generalized')

  const proposed = await prisma.demonstration.create({
    data: {
      agentId: agent.id,
      capturedAt: new Date(),
      channelId: channel.id,
      expiresAt: new Date(Date.now() + 60_000),
      organizationId: organization.id,
      startedByUserId: user.id,
      status: 'captured',
      threadId: thread.id,
    },
  })
  await prisma.demonstrationStep.create({
    data: {
      agentId: agent.id,
      argumentsJson: { recipient: 'Operations' },
      demonstrationId: proposed.id,
      durationMs: 1,
      endedAt: new Date(),
      sequence: 1,
      startedAt: new Date(),
      success: true,
      toolName: 'message_send',
    },
  })
  await generalizeDemonstration(prisma, { agentProposed: true, demonstrationId: proposed.id },
    scriptedGeneralization([JSON.stringify({
      name: 'Notify operations',
      steps: [{ instruction: 'Notify the operations team about the demonstrated result.', type: 'agent_task' }],
    })]),
  )
  const proposedTemplate = await prisma.workflowTemplate.findUniqueOrThrow({
    where: { demonstrationId: proposed.id },
  })
  assert.equal(proposedTemplate.adoptedAt, null)
  assert.equal(proposedTemplate.createdByActorId, agent.id)
  assert.equal(proposedTemplate.createdByActorType, 'agent')
  assert.equal(await prisma.approvalRequest.count({
    where: { action: 'workflow.template.adopt', context: { path: ['workflowTemplateId'], equals: proposedTemplate.id } },
  }), 1)
})
