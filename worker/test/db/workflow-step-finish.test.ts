import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import {
  markWorkflowRunFinished,
  markWorkflowStepRunFinished,
} from '../../src/run/workflows.js'
import { finishWorkflowStepRun } from '../../src/run/workflow-step-finish.js'
import { runDatabaseTest } from './support.js'

// Database suites for the guarded terminal transition (W1/W7) and the async
// terminal-event seam (W3). These functions take an explicit workflowRunId and
// never poll globally, so they are safe to run concurrently with other suites
// as long as every assertion is scoped to this file's own seed. (They live in
// test/db/ anyway, where files run one at a time.)

type Seed = {
  installationId: string
  organizationId: string
  templateId: string
  workflowRunId: string
}

const seedWorkflowRun = async (
  prisma: PrismaClient,
  input: { steps: Array<{ id: string; type: string }> },
): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `wf-finish ${randomUUID()}` } })
  const template = await prisma.workflowTemplate.create({
    data: {
      createdByActorId: 'user-seed',
      createdByActorType: 'user',
      graphJson: { steps: input.steps },
      name: `wf ${randomUUID()}`,
      organizationId: org.id,
    },
  })
  const installation = await prisma.workflowInstallation.create({
    data: {
      createdByActorId: 'user-seed',
      createdByActorType: 'user',
      organizationId: org.id,
      workflowTemplateId: template.id,
      workflowTemplateVersion: 1,
    },
  })
  const run = await prisma.workflowRun.create({
    data: {
      installationId: installation.id,
      organizationId: org.id,
      startedByActorId: 'user-seed',
      startedByActorType: 'user',
      status: 'running',
      startedAt: new Date(),
    },
  })
  return {
    installationId: installation.id,
    organizationId: org.id,
    templateId: template.id,
    workflowRunId: run.id,
  }
}

const cleanup = async (prisma: PrismaClient, seed: Seed) => {
  // Queue jobs written by these suites carry no threadId, so scope the delete
  // to the seed's own ids instead (the runs/mailbox rules in AGENTS.md).
  await prisma.$executeRaw`
    DELETE FROM queue_jobs
    WHERE topic = 'trigger.event.dispatch'
      AND payload->'payload'->>'workflowRunId' = ${seed.workflowRunId}
  `.catch(() => undefined)
  await prisma.organization.deleteMany({ where: { id: seed.organizationId } })
}

const createStepRun = async (
  prisma: PrismaClient,
  input: {
    sequence: number
    status: 'blocked' | 'pending' | 'running' | 'skipped'
    stepKey: string
    stepType?: string
    workflowRunId: string
  },
) =>
  prisma.workflowStepRun.create({
    data: {
      sequence: input.sequence,
      status: input.status,
      stepKey: input.stepKey,
      stepType: input.stepType ?? 'agent',
      title: input.stepKey,
      workflowRunId: input.workflowRunId,
    },
  })

runDatabaseTest('W1: a late child completion cannot resurrect a cancelled run', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkflowRun(prisma, {
    steps: [{ id: 'step-a', type: 'agent' }],
  })
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const stepRun = await createStepRun(prisma, {
    sequence: 0,
    status: 'skipped',
    stepKey: 'step-a',
    workflowRunId: seed.workflowRunId,
  })
  await prisma.workflowRun.update({
    where: { id: seed.workflowRunId },
    data: { status: 'cancelled', finishedAt: new Date() },
  })

  // The suspended child's completion arrives after the cancel — the exact
  // orphan race W1 guards.
  const result = await markWorkflowStepRunFinished(prisma, {
    stepRunId: stepRun.id,
    success: true,
    summary: 'child done',
    workflowRunId: seed.workflowRunId,
  })

  assert.deepEqual(result, {
    applied: false,
    continueWorkflow: false,
    workflowRunCompleted: false,
  })

  const run = await prisma.workflowRun.findUniqueOrThrow({
    where: { id: seed.workflowRunId },
  })
  assert.equal(run.status, 'cancelled')

  const step = await prisma.workflowStepRun.findUniqueOrThrow({
    where: { id: stepRun.id },
  })
  assert.equal(step.status, 'skipped')
})

runDatabaseTest('W1: a successful finish still completes the last step and the run', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkflowRun(prisma, {
    steps: [{ id: 'step-a', type: 'agent' }],
  })
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const stepRun = await createStepRun(prisma, {
    sequence: 0,
    status: 'running',
    stepKey: 'step-a',
    workflowRunId: seed.workflowRunId,
  })

  const result = await markWorkflowStepRunFinished(prisma, {
    output: { answer: 'done' },
    stepRunId: stepRun.id,
    success: true,
    summary: 'finished',
    workflowRunId: seed.workflowRunId,
  })

  assert.deepEqual(result, {
    applied: true,
    continueWorkflow: false,
    workflowRunCompleted: true,
  })

  const run = await prisma.workflowRun.findUniqueOrThrow({
    where: { id: seed.workflowRunId },
  })
  assert.equal(run.status, 'completed')
  assert.ok(run.finishedAt)

  const step = await prisma.workflowStepRun.findUniqueOrThrow({
    where: { id: stepRun.id },
  })
  assert.equal(step.status, 'completed')
})

runDatabaseTest('W7: a failed step terminalizes the run and skips unreached steps', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkflowRun(prisma, {
    steps: [
      { id: 'step-a', type: 'tool' },
      { id: 'step-b', type: 'tool' },
      { id: 'step-c', type: 'tool' },
    ],
  })
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const failing = await createStepRun(prisma, {
    sequence: 0,
    status: 'running',
    stepKey: 'step-a',
    workflowRunId: seed.workflowRunId,
  })
  const pendingStep = await createStepRun(prisma, {
    sequence: 1,
    status: 'pending',
    stepKey: 'step-b',
    workflowRunId: seed.workflowRunId,
  })
  const blockedStep = await createStepRun(prisma, {
    sequence: 2,
    status: 'blocked',
    stepKey: 'step-c',
    workflowRunId: seed.workflowRunId,
  })

  const result = await markWorkflowStepRunFinished(prisma, {
    stepRunId: failing.id,
    success: false,
    summary: 'tool failed',
    workflowRunId: seed.workflowRunId,
  })

  assert.deepEqual(result, {
    applied: true,
    continueWorkflow: false,
    workflowRunCompleted: false,
  })

  const run = await prisma.workflowRun.findUniqueOrThrow({
    where: { id: seed.workflowRunId },
  })
  assert.equal(run.status, 'failed')

  const steps = await prisma.workflowStepRun.findMany({
    where: { workflowRunId: seed.workflowRunId },
    orderBy: { sequence: 'asc' },
  })
  assert.equal(steps[0]?.status, 'failed')
  assert.equal(steps[1]?.status, 'skipped')
  assert.equal(steps[2]?.status, 'skipped')
  assert.ok(steps[1]?.finishedAt)
  assert.ok(steps[2]?.finishedAt)
})

runDatabaseTest('W1: markWorkflowRunFinished loses to a concurrent cancel', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkflowRun(prisma, {
    steps: [{ id: 'step-a', type: 'agent' }],
  })
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  await prisma.workflowRun.update({
    where: { id: seed.workflowRunId },
    data: { status: 'cancelled', finishedAt: new Date() },
  })

  const result = await markWorkflowRunFinished(prisma, {
    success: true,
    summary: 'Workflow run completed.',
    workflowRunId: seed.workflowRunId,
  })

  assert.deepEqual(result, { applied: false })
  const run = await prisma.workflowRun.findUniqueOrThrow({
    where: { id: seed.workflowRunId },
  })
  assert.equal(run.status, 'cancelled')
})

runDatabaseTest('W3: async continuation of the final agent_task step emits workflow.run.completed', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkflowRun(prisma, {
    steps: [{ id: 'step-a', type: 'agent' }],
  })
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const stepRun = await createStepRun(prisma, {
    sequence: 0,
    status: 'running',
    stepKey: 'step-a',
    workflowRunId: seed.workflowRunId,
  })

  // What parent-workflow.ts does after loadWorkflowGraph: finish through the
  // emitting seam with the loaded graph.
  const { loadWorkflowGraph } = await import('../../src/run/workflows.js')
  const workflow = await loadWorkflowGraph(prisma, seed.workflowRunId)
  assert.ok(workflow)

  const result = await finishWorkflowStepRun(prisma, workflow, {
    output: { answer: 'done' },
    stepRunId: stepRun.id,
    success: true,
    summary: 'agent finished',
    workflowRunId: seed.workflowRunId,
  })

  assert.deepEqual(result, {
    applied: true,
    continueWorkflow: false,
    workflowRunCompleted: true,
  })

  const jobs = await prisma.$queryRaw<
    Array<{ topic: string; eventType: string }>
  >`
    SELECT topic, payload->>'eventType' AS "eventType"
    FROM queue_jobs
    WHERE topic = 'trigger.event.dispatch'
      AND payload->'payload'->>'workflowRunId' = ${seed.workflowRunId}
  `
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0]?.eventType, 'workflow.run.completed')
})

runDatabaseTest('W3: a finish that loses to a terminal status emits no terminal event', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkflowRun(prisma, {
    steps: [{ id: 'step-a', type: 'agent' }],
  })
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const stepRun = await createStepRun(prisma, {
    sequence: 0,
    status: 'skipped',
    stepKey: 'step-a',
    workflowRunId: seed.workflowRunId,
  })
  await prisma.workflowRun.update({
    where: { id: seed.workflowRunId },
    data: { status: 'cancelled', finishedAt: new Date() },
  })

  const { loadWorkflowGraph } = await import('../../src/run/workflows.js')
  const workflow = await loadWorkflowGraph(prisma, seed.workflowRunId)
  assert.ok(workflow)

  const result = await finishWorkflowStepRun(prisma, workflow, {
    stepRunId: stepRun.id,
    success: true,
    workflowRunId: seed.workflowRunId,
  })

  assert.equal(result.applied, false)
  const jobs = await prisma.$queryRaw<Array<{ topic: string }>>`
    SELECT topic
    FROM queue_jobs
    WHERE topic = 'trigger.event.dispatch'
      AND payload->'payload'->>'workflowRunId' = ${seed.workflowRunId}
  `
  assert.equal(jobs.length, 0)
})
