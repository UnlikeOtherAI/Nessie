import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { cancelWorkflowRun } from '../src/services/workflow-run-controls.js'

// W2: cancelling a workflow run must propagate to its children, not just flip
// the rows. Assertions are scoped to this suite's own organization seed; the
// only shared state written is queue_jobs, cleaned up by the seed's exact ids.

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  agentId: string
  channelId: string
  instanceId: string
  organizationId: string
  projectId: string
  teamId: string
  templateId: string
  threadId: string
  userId: string
  workflowRunId: string
  steps: {
    agent: { id: string }
    environment: { id: string }
    pending: { id: string }
    tool: { id: string }
  }
  childRunId: string
  mailboxMessageId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `wf-cancel ${randomUUID()}` } })
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
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const user = await prisma.user.create({
    data: { displayName: 'Owner', email: `wf-cancel-${randomUUID()}@example.com` },
  })
  const agent = await prisma.agent.create({ data: { name: 'Child', organizationId: org.id } })

  const template = await prisma.workflowTemplate.create({
    data: {
      createdByActorId: user.id,
      createdByActorType: 'user',
      graphJson: {
        steps: [
          { id: 'agent-step', type: 'agent' },
          { id: 'env-step', type: 'environment_launch' },
          { id: 'tool-step', type: 'tool' },
          { id: 'pending-step', type: 'tool' },
        ],
      },
      name: `wf ${randomUUID()}`,
      organizationId: org.id,
    },
  })
  const installation = await prisma.workflowInstallation.create({
    data: {
      createdByActorId: user.id,
      createdByActorType: 'user',
      organizationId: org.id,
      workflowTemplateId: template.id,
      workflowTemplateVersion: 1,
    },
  })
  const workflowRun = await prisma.workflowRun.create({
    data: {
      installationId: installation.id,
      organizationId: org.id,
      startedByActorId: user.id,
      startedByActorType: 'user',
      status: 'running',
      startedAt: new Date(),
    },
  })

  const childRun = await prisma.run.create({
    data: { agentId: agent.id, status: 'running', threadId: thread.id },
  })

  const createStep = (input: {
    sequence: number
    status: 'pending' | 'running'
    stepKey: string
    stepType: string
    agentRunId?: string
  }) =>
    prisma.workflowStepRun.create({
      data: {
        agentRunId: input.agentRunId,
        sequence: input.sequence,
        status: input.status,
        stepKey: input.stepKey,
        stepType: input.stepType,
        title: input.stepKey,
        workflowRunId: workflowRun.id,
      },
    })

  const agentStep = await createStep({
    agentRunId: childRun.id,
    sequence: 0,
    status: 'running',
    stepKey: 'agent-step',
    stepType: 'agent',
  })
  const environmentStep = await createStep({
    sequence: 1,
    status: 'running',
    stepKey: 'env-step',
    stepType: 'environment_launch',
  })
  const toolStep = await createStep({
    sequence: 2,
    status: 'running',
    stepKey: 'tool-step',
    stepType: 'tool',
  })
  const pendingStep = await createStep({
    sequence: 3,
    status: 'pending',
    stepKey: 'pending-step',
    stepType: 'tool',
  })

  const environmentTemplate = await prisma.executionEnvironmentTemplate.create({
    data: {
      createdByActorId: user.id,
      createdByActorType: 'user',
      mode: 'container',
      name: 'tpl',
      organizationId: org.id,
      provider: 'docker',
    },
  })
  const instance = await prisma.executionEnvironmentInstance.create({
    data: {
      launchedByActorId: user.id,
      launchedByActorType: 'user',
      organizationId: org.id,
      status: 'ready',
      templateId: environmentTemplate.id,
      workflowRunId: workflowRun.id,
      workflowStepRunId: environmentStep.id,
    },
  })

  const mailboxMessage = await prisma.agentMailboxMessage.create({
    data: {
      actorId: user.id,
      actorType: 'user',
      body: 'do the thing',
      channelId: channel.id,
      correlationId: `workflow-step:${agentStep.id}`,
      organizationId: org.id,
      toAgentId: agent.id,
      workflowRunId: workflowRun.id,
      workflowStepRunId: agentStep.id,
    },
  })

  return {
    agentId: agent.id,
    channelId: channel.id,
    instanceId: instance.id,
    organizationId: org.id,
    projectId: project.id,
    teamId: team.id,
    templateId: template.id,
    threadId: thread.id,
    userId: user.id,
    workflowRunId: workflowRun.id,
    steps: {
      agent: { id: agentStep.id },
      environment: { id: environmentStep.id },
      pending: { id: pendingStep.id },
      tool: { id: toolStep.id },
    },
    childRunId: childRun.id,
    mailboxMessageId: mailboxMessage.id,
  }
}

const cleanup = async (prisma: PrismaClient, seedValue: Seed) => {
  await prisma.$executeRaw`
    DELETE FROM queue_jobs
    WHERE topic = 'execution.environment.terminate'
      AND payload->>'instanceId' = ${seedValue.instanceId}
  `.catch(() => undefined)
  await prisma.organization.deleteMany({ where: { id: seedValue.organizationId } })
  await prisma.user.deleteMany({ where: { id: seedValue.userId } })
}

runDatabaseTest('cancelWorkflowRun propagates to the child run, instance, and tool step', async (t) => {
  const prisma = new PrismaClient()
  const seedValue = await seed(prisma)
  t.after(async () => {
    await cleanup(prisma, seedValue)
    await prisma.$disconnect()
  })

  const actorContext: AuthorizedActionContext = {
    actor: { actorId: seedValue.userId, actorType: 'user', roles: ['owner'] },
    actionContext: { requestId: 'wf-cancel-test' },
    tenant: { organizationId: seedValue.organizationId },
  }

  const record = await cancelWorkflowRun(prisma, actorContext, seedValue.workflowRunId, {
    reason: 'stop it',
  })

  assert.ok(record)
  assert.equal(record.status, 'cancelled')

  // The run row itself.
  const run = await prisma.workflowRun.findUniqueOrThrow({
    where: { id: seedValue.workflowRunId },
  })
  assert.equal(run.status, 'cancelled')
  assert.equal(run.errorMessage, 'stop it')

  // All non-terminal steps are skipped, stamped with the reason.
  const steps = await prisma.workflowStepRun.findMany({
    where: { workflowRunId: seedValue.workflowRunId },
    orderBy: { sequence: 'asc' },
  })
  for (const step of steps) {
    assert.equal(step.status, 'skipped', `step ${step.stepKey}`)
    assert.ok(step.errorMessage?.startsWith('stop it'), `step ${step.stepKey}`)
    assert.ok(step.finishedAt, `step ${step.stepKey}`)
  }

  // The suspended child agent run got the cooperative cancel flag — not a
  // silent orphan that outlives the workflow.
  const childRun = await prisma.run.findUniqueOrThrow({
    where: { id: seedValue.childRunId },
  })
  assert.equal(childRun.status, 'running')
  assert.ok(childRun.cancelRequestedAt)
  assert.equal(childRun.cancelRequestedByUserId, seedValue.userId)

  // The environment instance got a terminate job on the shared queue.
  const terminateJobs = await prisma.$queryRaw<
    Array<{ payload: { instanceId?: string } }>
  >`
    SELECT payload
    FROM queue_jobs
    WHERE topic = 'execution.environment.terminate'
      AND payload->>'instanceId' = ${seedValue.instanceId}
  `
  assert.equal(terminateJobs.length, 1)

  // The in-flight tool step records abandoned-but-possibly-executing instead
  // of staying silent about a side effect that may still land.
  const toolStep = steps.find((step) => step.id === seedValue.steps.tool.id)
  assert.match(toolStep?.errorMessage ?? '', /may still execute/)
  const toolOutput = toolStep?.output as Record<string, unknown> | null
  assert.equal(typeof toolOutput?.['cancelAbandonedAt'], 'string')

  // The agent step names the undelivered mailbox message.
  const agentStep = steps.find((step) => step.id === seedValue.steps.agent.id)
  const agentOutput = agentStep?.output as Record<string, unknown> | null
  assert.equal(agentOutput?.['cancelAbandonedMessageId'], seedValue.mailboxMessageId)
})
