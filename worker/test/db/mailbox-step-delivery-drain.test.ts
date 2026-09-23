import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient } from '@prisma/client'
import { AuthorizedActionContextSchema, type RunExecuteJobPayload } from '@nessie/schemas'

import { maybeContinueParentWorkflow } from '../../src/run/execute/parent-workflow.js'
import { claimThreadRunOrPend, drainPendingThreadMessages } from '../../src/run/thread-serialization.js'
import { markWorkflowStepRunQueued } from '../../src/run/workflows.js'
import { assertGlobalQueuesQuiet, runDatabaseTest } from './support.js'
import { cleanup, dispatchSeededMail, seedTeam, type Seed } from './mailbox-serialization-fixture.js'

// Mailbox deliveries sent for a plan step or a workflow step. When the target
// agent is busy the delivery pends, and whichever path finally starts its run
// owes the step what the mailbox dispatcher's direct claim gives it: a payload
// naming the step (completion, failure and cancellation finish the step and
// continue the workflow only through those fields), and a step that records
// the run working it. A delivery's hidden body is its whole prompt, so it also
// drains alone rather than being folded into a batch behind a later message.

type QueuedRunPayload = RunExecuteJobPayload & { batchMessageIds?: string[] }

const seedWorkflowStep = async (prisma: PrismaClient, seed: Seed) => {
  const template = await prisma.workflowTemplate.create({ data: {
    createdByActorId: seed.requesterId, createdByActorType: 'user', graphJson: { steps: [{ id: 'ask', type: 'agent_task' }] },
    name: `wf ${randomUUID()}`, organizationId: seed.organizationId,
  } })
  const installation = await prisma.workflowInstallation.create({ data: {
    createdByActorId: seed.requesterId, createdByActorType: 'user', organizationId: seed.organizationId,
    workflowTemplateId: template.id, workflowTemplateVersion: 1,
  } })
  const run = await prisma.workflowRun.create({ data: {
    installationId: installation.id, organizationId: seed.organizationId, startedAt: new Date(),
    startedByActorId: seed.requesterId, startedByActorType: 'user', status: 'running',
  } })
  const step = await prisma.workflowStepRun.create({ data: {
    sequence: 0, status: 'pending', stepKey: 'ask', stepType: 'agent_task', title: 'ask', workflowRunId: run.id,
  } })
  return { runId: run.id, stepRunId: step.id }
}

const seedPlanStep = async (prisma: PrismaClient, seed: Seed) => {
  const plan = await prisma.plan.create({ data: {
    createdByActorId: seed.requesterId, createdByActorType: 'user', goal: 'Ship the report', organizationId: seed.organizationId,
    status: 'active',
  } })
  const step = await prisma.planStep.create({ data: {
    assignedAgentId: seed.toAgentId, planId: plan.id, sequence: 0, title: 'Draft it', type: 'delegate',
  } })
  return { planId: plan.id, planStepId: step.id }
}

// The two producers, as they write their rows: the workflow engine's agent_task
// step (`worker/src/control/workflows.ts`) and `POST /api/mailbox` with plan ids.
const queueStepMail = (prisma: PrismaClient, seed: Seed, body: string, link: {
  planId?: string; planStepId?: string; workflowRunId?: string; workflowStepRunId?: string
}) => prisma.agentMailboxMessage.create({ data: {
  actorId: seed.requesterId, actorType: 'user', body, channelId: seed.channelId, correlationId: randomUUID(),
  organizationId: seed.organizationId, subject: body, threadId: seed.threadId, toAgentId: seed.toAgentId,
  visibleAt: new Date(Date.now() - 60_000), ...link,
} })

const cleanupSteps = async (prisma: PrismaClient, seed: Seed, workflowRunIds: string[], planStepIds: string[]) => {
  await prisma.$executeRaw(Prisma.sql`DELETE FROM queue_jobs WHERE payload->>'workflowRunId' IN (${Prisma.join(workflowRunIds)})
    OR payload->'payload'->>'workflowRunId' IN (${Prisma.join(workflowRunIds)})`)
  await prisma.planStep.deleteMany({ where: { id: { in: planStepIds } } })
  await cleanup(prisma, seed)
}

const drainNext = async (prisma: PrismaClient, seed: Seed, predecessorId: string) => {
  await prisma.run.update({ where: { id: predecessorId }, data: { finishedAt: new Date(), status: 'completed' } })
  const runId = await drainPendingThreadMessages(prisma, { agentId: seed.toAgentId, threadId: seed.threadId })
  assert.ok(runId, 'each terminal drain starts exactly one follow-up')
  const job = await prisma.queueJob.findFirstOrThrow({ where: { idempotencyKey: `run:batch:${runId}` } })
  const run = await prisma.run.findUniqueOrThrow({ where: { id: runId }, select: { triggerMessageId: true } })
  const task = await prisma.task.findFirstOrThrow({ where: { runId }, select: { id: true } })
  return { payload: job.payload as QueuedRunPayload, run, runId, taskId: task.id }
}

runDatabaseTest('a lone pended workflow step delivery runs linked to its step, and its completion closes the step', async (t) => {
  const prisma = new PrismaClient()
  await assertGlobalQueuesQuiet(prisma)
  const seed = await seedTeam(prisma)
  const workflow = await seedWorkflowStep(prisma, seed)
  t.after(async () => {
    await cleanupSteps(prisma, seed, [workflow.runId], [])
    await prisma.$disconnect()
  })

  const busy = await prisma.run.create({ data: { agentId: seed.toAgentId, status: 'running', threadId: seed.threadId } })
  const mail = await queueStepMail(prisma, seed, 'Workflow: collect the numbers', {
    workflowRunId: workflow.runId, workflowStepRunId: workflow.stepRunId,
  })
  await markWorkflowStepRunQueued(prisma, {
    input: {}, output: { mailboxMessageId: mail.id, targetAgentId: seed.toAgentId },
    workflowRunId: workflow.runId, workflowStepRunId: workflow.stepRunId,
  })
  await dispatchSeededMail(prisma, mail)

  // Nothing else is pending, so there is no batch: only the step linkage is
  // under test here.
  const drained = await drainNext(prisma, seed, busy.id)
  assert.equal(drained.payload.parentWorkflowRunId, workflow.runId)
  assert.equal(drained.payload.parentWorkflowStepRunId, workflow.stepRunId)
  const step = await prisma.workflowStepRun.findUniqueOrThrow({ where: { id: workflow.stepRunId } })
  assert.equal((step.output as { childRunId?: string }).childRunId, drained.runId)

  // The run's own completion closes the step and the workflow. Without the
  // linkage this is a no-op, and the step waits for the deadline reaper to
  // fail it — however well the agent did the work.
  await maybeContinueParentWorkflow({ prisma }, drained.payload, {
    output: { responseText: 'Numbers collected.', runId: drained.runId }, success: true,
  })
  assert.equal((await prisma.workflowStepRun.findUniqueOrThrow({ where: { id: workflow.stepRunId } })).status, 'completed')
  assert.equal((await prisma.workflowRun.findUniqueOrThrow({ where: { id: workflow.runId } })).status, 'completed')
})

runDatabaseTest('pended workflow and plan step deliveries each run alone, linked to their own step', async (t) => {
  const prisma = new PrismaClient()
  await assertGlobalQueuesQuiet(prisma)
  const seed = await seedTeam(prisma)
  const workflow = await seedWorkflowStep(prisma, seed)
  const plan = await seedPlanStep(prisma, seed)
  t.after(async () => {
    await cleanupSteps(prisma, seed, [workflow.runId], [plan.planStepId])
    await prisma.$disconnect()
  })

  const busy = await prisma.run.create({ data: { agentId: seed.toAgentId, status: 'running', threadId: seed.threadId } })

  // The workflow engine writes the mail, then marks its step waiting on it.
  const workflowMail = await queueStepMail(prisma, seed, 'Workflow: collect the numbers', {
    workflowRunId: workflow.runId, workflowStepRunId: workflow.stepRunId,
  })
  await markWorkflowStepRunQueued(prisma, {
    input: {}, output: { mailboxMessageId: workflowMail.id, targetAgentId: seed.toAgentId },
    workflowRunId: workflow.runId, workflowStepRunId: workflow.stepRunId,
  })
  await dispatchSeededMail(prisma, workflowMail)

  const chat = await prisma.message.create({ data: {
    content: 'kannst du das kurz zusammenfassen?', role: 'user', threadId: seed.threadId, userId: seed.secondRequesterId,
  } })
  assert.equal(await prisma.$transaction((tx) => claimThreadRunOrPend(tx, {
    agentId: seed.toAgentId, threadId: seed.threadId,
    pending: {
      actorContext: AuthorizedActionContextSchema.parse({
        actor: { actorId: seed.secondRequesterId, actorType: 'user', roles: ['member'] },
        tenant: { organizationId: seed.organizationId, projectId: seed.projectId, teamId: seed.teamId },
        actionContext: { requestId: randomUUID() },
      }),
      channelId: seed.channelId, interactive: true, messageId: chat.id,
    },
  })), 'pended')

  const planMail = await queueStepMail(prisma, seed, 'Plan: draft the report', plan)
  await dispatchSeededMail(prisma, planMail)
  assert.equal(await prisma.run.count({ where: { agentId: seed.toAgentId, threadId: seed.threadId } }), 1)

  const pendings = await prisma.runThreadPendingMessage.findMany({
    where: { agentId: seed.toAgentId, threadId: seed.threadId }, orderBy: { seq: 'asc' },
  })
  assert.equal(pendings.length, 3)
  const [workflowPrompt, , planPrompt] = pendings.map((pending) => pending.messageId)
  // `messages.created_at` is `timestamp(3)`: state the arrival order.
  const base = Date.now()
  for (const [index, id] of [workflowPrompt!, chat.id, planPrompt!].entries()) {
    await prisma.message.update({ where: { id }, data: { createdAt: new Date(base + index * 1_000) } })
  }

  // 1. The workflow step's delivery, alone, naming its step.
  const first = await drainNext(prisma, seed, busy.id)
  assert.equal(first.run.triggerMessageId, workflowPrompt)
  assert.deepEqual(first.payload.batchMessageIds, [workflowPrompt])
  assert.equal(first.payload.parentWorkflowRunId, workflow.runId)
  assert.equal(first.payload.parentWorkflowStepRunId, workflow.stepRunId)
  assert.equal(first.payload.parentPlanStepId, undefined)
  const workflowStep = await prisma.workflowStepRun.findUniqueOrThrow({ where: { id: workflow.stepRunId } })
  assert.equal(workflowStep.status, 'running')
  assert.deepEqual(workflowStep.output, {
    childRunId: first.runId, mailboxMessageId: workflowMail.id, targetAgentId: seed.toAgentId, taskId: first.taskId,
  })

  // 2. The person's message, alone, with no step.
  const second = await drainNext(prisma, seed, first.runId)
  assert.equal(second.run.triggerMessageId, chat.id)
  assert.deepEqual(second.payload.batchMessageIds, [chat.id])
  assert.equal(second.payload.parentWorkflowRunId, undefined)
  assert.equal(second.payload.parentPlanStepId, undefined)
  assert.equal(second.payload.actorContext.actor.actorId, seed.secondRequesterId)

  // 3. The plan step's delivery, alone, naming its step.
  const third = await drainNext(prisma, seed, second.runId)
  assert.equal(third.run.triggerMessageId, planPrompt)
  assert.deepEqual(third.payload.batchMessageIds, [planPrompt])
  assert.equal(third.payload.parentPlanId, plan.planId)
  assert.equal(third.payload.parentPlanStepId, plan.planStepId)
  const planStep = await prisma.planStep.findUniqueOrThrow({ where: { id: plan.planStepId } })
  assert.equal(planStep.status, 'running')
  assert.deepEqual(planStep.artifacts, {
    childRunId: third.runId, mailboxMessageId: planMail.id, targetAgentId: seed.toAgentId,
  })
  assert.equal((await prisma.plan.findUniqueOrThrow({ where: { id: plan.planId } })).status, 'waiting')
})

runDatabaseTest('a delivery drained after its workflow and plan were cancelled does not revive either', async (t) => {
  const prisma = new PrismaClient()
  await assertGlobalQueuesQuiet(prisma)
  const seed = await seedTeam(prisma)
  const workflow = await seedWorkflowStep(prisma, seed)
  const plan = await seedPlanStep(prisma, seed)
  t.after(async () => {
    await cleanupSteps(prisma, seed, [workflow.runId], [plan.planStepId])
    await prisma.$disconnect()
  })

  const busy = await prisma.run.create({ data: { agentId: seed.toAgentId, status: 'running', threadId: seed.threadId } })
  const workflowMail = await queueStepMail(prisma, seed, 'Workflow: collect the numbers', {
    workflowRunId: workflow.runId, workflowStepRunId: workflow.stepRunId,
  })
  await markWorkflowStepRunQueued(prisma, {
    input: {}, output: { mailboxMessageId: workflowMail.id, targetAgentId: seed.toAgentId },
    workflowRunId: workflow.runId, workflowStepRunId: workflow.stepRunId,
  })
  await dispatchSeededMail(prisma, workflowMail)
  const planMail = await queueStepMail(prisma, seed, 'Plan: draft the report', plan)
  await dispatchSeededMail(prisma, planMail)

  // Both are cancelled while the deliveries wait behind the busy run.
  await prisma.workflowRun.update({ where: { id: workflow.runId }, data: { finishedAt: new Date(), status: 'cancelled' } })
  await prisma.workflowStepRun.update({ where: { id: workflow.stepRunId }, data: { status: 'skipped' } })
  await prisma.plan.update({ where: { id: plan.planId }, data: { status: 'cancelled' } })
  await prisma.planStep.update({ where: { id: plan.planStepId }, data: { status: 'skipped' } })

  const first = await drainNext(prisma, seed, busy.id)
  await drainNext(prisma, seed, first.runId)

  assert.equal((await prisma.workflowRun.findUniqueOrThrow({ where: { id: workflow.runId } })).status, 'cancelled')
  const workflowStep = await prisma.workflowStepRun.findUniqueOrThrow({ where: { id: workflow.stepRunId } })
  assert.equal(workflowStep.status, 'skipped')
  assert.equal((workflowStep.output as { childRunId?: string }).childRunId, undefined)
  assert.equal((await prisma.plan.findUniqueOrThrow({ where: { id: plan.planId } })).status, 'cancelled')
  const planStep = await prisma.planStep.findUniqueOrThrow({ where: { id: plan.planStepId } })
  assert.equal(planStep.status, 'skipped')
  assert.deepEqual(planStep.artifacts, {})
})

runDatabaseTest('a step delivery that claims a free thread links its run the same way', async (t) => {
  const prisma = new PrismaClient()
  await assertGlobalQueuesQuiet(prisma)
  const seed = await seedTeam(prisma)
  const workflow = await seedWorkflowStep(prisma, seed)
  const plan = await seedPlanStep(prisma, seed)
  t.after(async () => {
    await cleanupSteps(prisma, seed, [workflow.runId], [plan.planStepId])
    await prisma.$disconnect()
  })

  // A step with its own timeout: the engine's deadline must survive the claim.
  const workflowMail = await queueStepMail(prisma, seed, 'Workflow: collect the numbers', {
    workflowRunId: workflow.runId, workflowStepRunId: workflow.stepRunId,
  })
  await markWorkflowStepRunQueued(prisma, {
    input: { timeoutMs: 600_000 }, output: { mailboxMessageId: workflowMail.id, targetAgentId: seed.toAgentId },
    workflowRunId: workflow.runId, workflowStepRunId: workflow.stepRunId,
  })
  const engineMarked = await prisma.workflowStepRun.findUniqueOrThrow({ where: { id: workflow.stepRunId } })
  await dispatchSeededMail(prisma, workflowMail)

  const workflowJob = await prisma.queueJob.findFirstOrThrow({ where: { idempotencyKey: `mailbox:${workflowMail.id}` } })
  const workflowPayload = workflowJob.payload as QueuedRunPayload
  assert.equal(workflowPayload.parentWorkflowRunId, workflow.runId)
  assert.equal(workflowPayload.parentWorkflowStepRunId, workflow.stepRunId)
  const workflowStep = await prisma.workflowStepRun.findUniqueOrThrow({ where: { id: workflow.stepRunId } })
  assert.equal(workflowStep.status, 'running')
  assert.deepEqual(workflowStep.deadlineAt, engineMarked.deadlineAt)
  assert.deepEqual(workflowStep.startedAt, engineMarked.startedAt)
  assert.deepEqual(workflowStep.output, {
    childRunId: workflowPayload.runId, mailboxMessageId: workflowMail.id, targetAgentId: seed.toAgentId,
    taskId: workflowPayload.taskId,
  })

  // The claimed run finishes; the plan step's mail then claims the free slot.
  await prisma.run.update({ where: { id: workflowPayload.runId }, data: { finishedAt: new Date(), status: 'completed' } })
  const planMail = await queueStepMail(prisma, seed, 'Plan: draft the report', plan)
  await dispatchSeededMail(prisma, planMail)
  const planJob = await prisma.queueJob.findFirstOrThrow({ where: { idempotencyKey: `mailbox:${planMail.id}` } })
  const planPayload = planJob.payload as QueuedRunPayload
  assert.equal(planPayload.parentPlanId, plan.planId)
  assert.equal(planPayload.parentPlanStepId, plan.planStepId)
  const planStep = await prisma.planStep.findUniqueOrThrow({ where: { id: plan.planStepId } })
  assert.equal(planStep.status, 'running')
  assert.deepEqual(planStep.artifacts, {
    childRunId: planPayload.runId, mailboxMessageId: planMail.id, targetAgentId: seed.toAgentId,
  })
  assert.equal((await prisma.plan.findUniqueOrThrow({ where: { id: plan.planId } })).status, 'waiting')
})
