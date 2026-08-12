import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient } from '@prisma/client'

import { reapStuckWorkflowSteps } from '../../src/control/workflow-step-reaper.js'
import { loadWorkflowGraph } from '../../src/run/workflows.js'
import { runDatabaseTest } from './support.js'

// Database suites for W4 (graph snapshots) and W6 (lease/deadline reaping).
// reapStuckWorkflowSteps selects only `running` steps with an expired lease or
// deadline, and every assertion here is scoped to this file's own seed; steps
// from other suites are unexpired (or, worst case, also reaped — a terminal
// transition they were headed for anyway) and never counted.

type Seed = {
  installationId: string
  organizationId: string
  templateId: string
  workflowRunId: string
}

const seedWorkflowRun = async (
  prisma: PrismaClient,
  input: {
    graph: Record<string, unknown>
    runStatus?: 'pending' | 'running'
    withPinnedGraph?: boolean
    withSnapshot?: boolean
  },
): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `wf-w4w6 ${randomUUID()}` } })
  const template = await prisma.workflowTemplate.create({
    data: {
      createdByActorId: 'user-seed',
      createdByActorType: 'user',
      graphJson: input.graph as Prisma.InputJsonValue,
      name: `wf ${randomUUID()}`,
      organizationId: org.id,
    },
  })
  const installation = await prisma.workflowInstallation.create({
    data: {
      createdByActorId: 'user-seed',
      createdByActorType: 'user',
      organizationId: org.id,
      ...(input.withPinnedGraph ? { pinnedGraphJson: input.graph as Prisma.InputJsonValue } : {}),
      workflowTemplateId: template.id,
      workflowTemplateVersion: 1,
    },
  })
  const run = await prisma.workflowRun.create({
    data: {
      installationId: installation.id,
      organizationId: org.id,
      ...(input.withSnapshot ? { graphSnapshot: input.graph as Prisma.InputJsonValue } : {}),
      startedByActorId: 'user-seed',
      startedByActorType: 'user',
      status: input.runStatus ?? 'running',
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
    deadlineAt?: Date | null
    leaseExpiresAt?: Date | null
    leaseOwnerId?: string | null
    sequence: number
    status?: 'pending' | 'running'
    stepKey: string
    workflowRunId: string
  },
) =>
  prisma.workflowStepRun.create({
    data: {
      deadlineAt: input.deadlineAt ?? null,
      leaseExpiresAt: input.leaseExpiresAt ?? null,
      leaseOwnerId: input.leaseOwnerId ?? null,
      sequence: input.sequence,
      status: input.status ?? 'running',
      stepKey: input.stepKey,
      stepType: 'agent',
      title: input.stepKey,
      workflowRunId: input.workflowRunId,
    },
  })

runDatabaseTest('W4: a template edit does not change an in-flight run', async (t) => {
  const prisma = new PrismaClient()
  const originalGraph = {
    steps: [
      { id: 'first', type: 'tool', input: { toolName: 'kb_search' } },
      { id: 'second', type: 'agent', input: { agentId: 'a' } },
    ],
  }
  const editedGraph = {
    steps: [{ id: 'replaced', type: 'tool', input: { toolName: 'http_fetch' } }],
  }
  const seed = await seedWorkflowRun(prisma, {
    graph: originalGraph,
    withPinnedGraph: true,
    withSnapshot: true,
  })
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  // The template is edited after the run started.
  await prisma.workflowTemplate.update({
    where: { id: seed.templateId },
    data: { graphJson: editedGraph as Prisma.InputJsonValue },
  })

  const loaded = await loadWorkflowGraph(prisma, seed.workflowRunId)
  assert.ok(loaded)
  assert.deepEqual(
    loaded.graph.steps.map((step) => step.id),
    ['first', 'second'],
    'the run must execute its frozen snapshot, not the edited template',
  )

  // A pre-snapshot run (graph_snapshot NULL) falls back to the template's
  // current graph — the graph it has been executing against all along.
  const legacy = await seedWorkflowRun(prisma, { graph: editedGraph })
  const legacyLoaded = await loadWorkflowGraph(prisma, legacy.workflowRunId)
  assert.ok(legacyLoaded)
  assert.deepEqual(
    legacyLoaded.graph.steps.map((step) => step.id),
    ['replaced'],
  )
  await prisma.workflowRun.delete({ where: { id: legacy.workflowRunId } })
  await prisma.workflowInstallation.delete({ where: { id: legacy.installationId } })
  await prisma.workflowTemplate.delete({ where: { id: legacy.templateId } })
  await prisma.organization.delete({ where: { id: legacy.organizationId } })
})

runDatabaseTest('W6: the reaper reclaims an actively-worked step by its expired lease', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkflowRun(prisma, {
    graph: { steps: [{ id: 'work', type: 'tool', input: { toolName: 'kb_search' } }] },
    withSnapshot: true,
  })
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const step = await createStepRun(prisma, {
    leaseExpiresAt: new Date(Date.now() - 60_000),
    leaseOwnerId: randomUUID(),
    sequence: 0,
    stepKey: 'work',
    workflowRunId: seed.workflowRunId,
  })

  const result = await reapStuckWorkflowSteps(prisma)

  const stepAfter = await prisma.workflowStepRun.findUniqueOrThrow({ where: { id: step.id } })
  const runAfter = await prisma.workflowRun.findUniqueOrThrow({ where: { id: seed.workflowRunId } })
  assert.equal(stepAfter.status, 'failed')
  assert.equal(stepAfter.leaseOwnerId, null)
  assert.equal(stepAfter.leaseExpiresAt, null)
  assert.match(stepAfter.errorMessage ?? '', /lease expired/)
  assert.equal(runAfter.status, 'failed')
  assert.ok(result.reaped >= 1)
})

runDatabaseTest('W6: the reaper reclaims a suspended step by its expired deadline', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkflowRun(prisma, {
    graph: { steps: [{ id: 'wait-on-agent', type: 'agent', input: { agentId: 'a' } }] },
    withSnapshot: true,
  })
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  // Suspended agent_task: no lease, only a deadline that has passed.
  const step = await createStepRun(prisma, {
    deadlineAt: new Date(Date.now() - 60_000),
    sequence: 0,
    stepKey: 'wait-on-agent',
    workflowRunId: seed.workflowRunId,
  })

  await reapStuckWorkflowSteps(prisma)

  const stepAfter = await prisma.workflowStepRun.findUniqueOrThrow({ where: { id: step.id } })
  const runAfter = await prisma.workflowRun.findUniqueOrThrow({ where: { id: seed.workflowRunId } })
  assert.equal(stepAfter.status, 'failed')
  assert.equal(stepAfter.deadlineAt, null)
  assert.match(stepAfter.errorMessage ?? '', /deadline expired/)
  assert.equal(runAfter.status, 'failed')
})

runDatabaseTest('W6: the reaper leaves healthy leased and unexpired suspended steps alone', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkflowRun(prisma, {
    graph: { steps: [{ id: 'a', type: 'tool' }, { id: 'b', type: 'agent' }] },
    withSnapshot: true,
  })
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const leased = await createStepRun(prisma, {
    leaseExpiresAt: new Date(Date.now() + 60_000),
    leaseOwnerId: randomUUID(),
    sequence: 0,
    stepKey: 'a',
    workflowRunId: seed.workflowRunId,
  })
  const suspended = await createStepRun(prisma, {
    deadlineAt: new Date(Date.now() + 60_000),
    sequence: 1,
    stepKey: 'b',
    status: 'pending',
    workflowRunId: seed.workflowRunId,
  })

  await reapStuckWorkflowSteps(prisma)

  const leasedAfter = await prisma.workflowStepRun.findUniqueOrThrow({ where: { id: leased.id } })
  const suspendedAfter = await prisma.workflowStepRun.findUniqueOrThrow({
    where: { id: suspended.id },
  })
  const runAfter = await prisma.workflowRun.findUniqueOrThrow({ where: { id: seed.workflowRunId } })
  assert.equal(leasedAfter.status, 'running')
  assert.equal(suspendedAfter.status, 'pending')
  assert.equal(runAfter.status, 'running')
})
