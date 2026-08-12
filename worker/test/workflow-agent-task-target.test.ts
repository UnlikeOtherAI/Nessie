import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { parseOrganizationId } from '@nessie/schemas'

import { executeWorkflowRun } from '../src/control/workflows.js'

// W28: the agent_task target check runs inside the mailbox transaction and
// fails org-generically — the step error must not confirm or deny whether a
// channel/binding exists in another organization, and a target deleted
// between check and insert cannot produce an orphaned mailbox row.
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const seedBase = async (prisma: PrismaClient) => {
  const org = await prisma.organization.create({
    data: { name: `wf-w28 ${randomUUID()}` },
  })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'c',
      slug: `c-${randomUUID()}`,
      organizationId: org.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const agent = await prisma.agent.create({ data: { name: 'A', organizationId: org.id } })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: channel.id } })
  const template = await prisma.workflowTemplate.create({
    data: {
      createdByActorId: 'seed',
      createdByActorType: 'service',
      graphJson: {
        steps: [{ id: 's', title: 's', type: 'tool', input: { key: 'k', toolName: 'state_get' } }],
      },
      name: 'wf',
      organizationId: org.id,
    },
  })
  const installation = await prisma.workflowInstallation.create({
    data: {
      channelId: channel.id,
      createdByActorId: 'seed',
      createdByActorType: 'service',
      organizationId: org.id,
      status: 'active',
      workflowTemplateId: template.id,
      workflowTemplateVersion: 1,
    },
  })
  return { agentId: agent.id, channelId: channel.id, installation, organizationId: org.id }
}

const createAgentTaskRun = async (
  prisma: PrismaClient,
  base: Awaited<ReturnType<typeof seedBase>>,
  target: { agentId: string; channelId: string },
) => {
  const graph = {
    steps: [
      {
        id: 'ask',
        input: { agentId: target.agentId, channelId: target.channelId, prompt: 'hi' },
        title: 'Ask',
        type: 'agent_task',
      },
    ],
  }
  const run = await prisma.workflowRun.create({
    data: {
      graphSnapshot: graph,
      installationId: base.installation.id,
      organizationId: base.organizationId,
      startedByActorId: randomUUID(),
      startedByActorType: 'service',
    },
  })
  await prisma.workflowStepRun.create({
    data: {
      sequence: 0,
      stepKey: 'ask',
      stepType: 'agent_task',
      title: 'Ask',
      workflowRunId: run.id,
    },
  })
  return run
}

// The executor re-derives its context from the run's durable origin; the
// caller must carry the same actor/scope to pass the mismatch guard.
const executionContext = (organizationId: string, actorId: string) => ({
  actorContext: {
    actor: { actorId, actorType: 'service' as const, roles: ['system'] },
    actionContext: { purpose: 'test', requestId: randomUUID() },
    tenant: { organizationId: parseOrganizationId(organizationId) },
  },
  ledgerIdentity: null,
})

runDatabaseTest('W28: cross-org target fails with an org-generic message and no mailbox row', async (t) => {
  const prisma = new PrismaClient()
  const base = await seedBase(prisma)
  // A second org with a VALID channel the target check must not leak about.
  const foreign = await seedBase(prisma)
  t.after(async () => {
    await prisma.organization.deleteMany({
      where: { id: { in: [base.organizationId, foreign.organizationId] } },
    })
    await prisma.$disconnect()
  })

  const run = await createAgentTaskRun(prisma, base, {
    agentId: foreign.agentId,
    channelId: foreign.channelId,
  })

  await executeWorkflowRun({
    prisma,
    workflowRunId: run.id,
    ...executionContext(base.organizationId, run.startedByActorId),
  })

  const stepRun = await prisma.workflowStepRun.findFirstOrThrow({
    where: { workflowRunId: run.id },
  })
  assert.equal(stepRun.status, 'failed')
  // Org-generic: names neither the channel, the binding, nor "not found".
  assert.equal(stepRun.errorMessage, 'Agent task target is unavailable for this workflow run.')
  assert.ok(!/channel|binding|thread|NOT_FOUND/i.test(stepRun.errorMessage ?? ''))
  // Nothing was queued for the foreign agent.
  assert.equal(
    await prisma.agentMailboxMessage.count({ where: { workflowRunId: run.id } }),
    0,
  )

  const refreshedRun = await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })
  assert.equal(refreshedRun.status, 'failed')
})

runDatabaseTest('W28: a valid in-org target still dispatches through the same transaction', async (t) => {
  const prisma = new PrismaClient()
  const base = await seedBase(prisma)
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: base.organizationId } })
    await prisma.$disconnect()
  })

  const run = await createAgentTaskRun(prisma, base, {
    agentId: base.agentId,
    channelId: base.channelId,
  })

  await executeWorkflowRun({
    prisma,
    workflowRunId: run.id,
    ...executionContext(base.organizationId, run.startedByActorId),
  })

  const mailbox = await prisma.agentMailboxMessage.findFirst({
    where: { workflowRunId: run.id },
  })
  assert.ok(mailbox)
  assert.equal(mailbox.toAgentId, base.agentId)

  const stepRun = await prisma.workflowStepRun.findFirstOrThrow({
    where: { workflowRunId: run.id },
  })
  assert.equal(stepRun.status, 'running')

  const refreshedRun = await prisma.workflowRun.findUniqueOrThrow({
    where: { id: run.id },
  })
  assert.equal(refreshedRun.status, 'running')
})
