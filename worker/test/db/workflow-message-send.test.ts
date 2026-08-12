import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { WORKFLOW_SECRET_REDACTION } from '@nessie/workspace-admin'
import { parseOrganizationId } from '@nessie/schemas'

import { executeWorkflowRun } from '../../src/control/workflows.js'
import { runDatabaseTest } from './support.js'

// W15 (message_send posts through the deterministic seam, no inference) and
// W16 (`when:` guard) end-to-end against the real executor. Every assertion is
// scoped to this file's own seed; the only queue jobs these paths can write
// are the W3 terminal events, cleaned up by workflowRunId like the sibling
// suites.

type Seed = {
  channelId: string
  installationId: string
  organizationId: string
  userId: string
}

const SECRET_REF = 'secret_mcp_cafedeadbeef'

const seedInstallation = async (
  prisma: PrismaClient,
  input: { resolvedBindings?: Record<string, unknown> } = {},
): Promise<Seed> => {
  const org = await prisma.organization.create({
    data: { name: `wf-msg ${randomUUID()}` },
  })
  const user = await prisma.user.create({
    data: { displayName: 'Workflow Owner', email: `wf-${randomUUID()}@example.com` },
  })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'ops',
      slug: `ops-${randomUUID()}`,
      organizationId: org.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const template = await prisma.workflowTemplate.create({
    data: {
      createdByActorId: user.id,
      createdByActorType: 'user',
      graphJson: { steps: [] },
      name: `wf ${randomUUID()}`,
      organizationId: org.id,
    },
  })
  const installation = await prisma.workflowInstallation.create({
    data: {
      channelId: channel.id,
      createdByActorId: user.id,
      createdByActorType: 'user',
      organizationId: org.id,
      resolvedBindings: input.resolvedBindings ?? {},
      status: 'active',
      workflowTemplateId: template.id,
      workflowTemplateVersion: 1,
    },
  })
  return {
    channelId: channel.id,
    installationId: installation.id,
    organizationId: org.id,
    userId: user.id,
  }
}

const seedRun = async (
  prisma: PrismaClient,
  seed: Seed,
  input: { actorType?: 'service' | 'user'; graph: Record<string, unknown>; workflowInput?: Record<string, unknown> },
) =>
  prisma.workflowRun.create({
    data: {
      graphSnapshot: input.graph,
      installationId: seed.installationId,
      input: input.workflowInput ?? {},
      organizationId: seed.organizationId,
      startedByActorId: input.actorType === 'service' ? seed.installationId : seed.userId,
      startedByActorType: input.actorType ?? 'user',
    },
  })

// The executor re-derives its context from the run's durable origin; the
// caller must carry the same actor/scope to pass the mismatch guard (the W28
// suite's pattern).
const executionContext = (seed: Seed, run: { startedByActorId: string; startedByActorType: string }) => ({
  actorContext: {
    actor: {
      actorId: run.startedByActorId,
      actorType: run.startedByActorType as 'service' | 'user',
      roles: ['system'],
    },
    actionContext: { purpose: 'test', requestId: randomUUID() },
    tenant: { organizationId: parseOrganizationId(seed.organizationId) },
  },
  ledgerIdentity: null,
})

const cleanup = async (prisma: PrismaClient, seeds: Seed[], runIds: string[]) => {
  // Queue jobs written by these suites carry no threadId; scope the delete to
  // the seeds' own workflow runs (the runs/mailbox rules in AGENTS.md).
  for (const runId of runIds) {
    await prisma.$executeRaw`
      DELETE FROM queue_jobs
      WHERE topic = 'trigger.event.dispatch'
        AND payload->'payload'->>'workflowRunId' = ${runId}
    `.catch(() => undefined)
  }
  await prisma.organization.deleteMany({
    where: { id: { in: seeds.map((seed) => seed.organizationId) } },
  })
}

const stepRunsOf = (prisma: PrismaClient, workflowRunId: string) =>
  prisma.workflowStepRun.findMany({
    orderBy: { sequence: 'asc' },
    where: { workflowRunId },
  })

runDatabaseTest('W15: message_send posts a real message to the installation channel and completes — no agent run', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedInstallation(prisma)
  const graph = {
    steps: [
      {
        id: 'announce',
        input: { body: 'Deploy finished: {{ workflow.input.version }}', toolName: 'message_send' },
        title: 'Announce',
        type: 'tool',
      },
    ],
  }
  const run = await seedRun(prisma, seed, { graph, workflowInput: { version: 'v42' } })
  t.after(async () => {
    await cleanup(prisma, [seed], [run.id])
    await prisma.$disconnect()
  })

  await executeWorkflowRun({
    prisma,
    workflowRunId: run.id,
    ...executionContext(seed, run),
  })

  const message = await prisma.message.findFirst({
    where: {
      thread: { channelId: seed.channelId },
    },
  })
  assert.ok(message, 'expected a channel message')
  assert.equal(message.content, 'Deploy finished: v42')
  // The durable actor is the user starter, so the post is theirs.
  assert.equal(message.userId, seed.userId)
  assert.equal(message.role, 'user')
  const metadata = message.metadata as { workflow?: { runId?: string; stepRunId?: string } }
  assert.equal(metadata.workflow?.runId, run.id)

  const refreshedRun = await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })
  assert.equal(refreshedRun.status, 'completed')
  const steps = await stepRunsOf(prisma, run.id)
  assert.equal(steps.length, 1)
  assert.equal(steps[0]?.status, 'completed')

  // The whole point: delivery without paying for inference.
  const agentRuns = await prisma.run.count({
    where: { thread: { channelId: seed.channelId } },
  })
  assert.equal(agentRuns, 0)
  assert.equal(
    await prisma.agentMailboxMessage.count({ where: { workflowRunId: run.id } }),
    0,
  )
})

runDatabaseTest('W15: a tainted secret_* binding never reaches the persisted message content', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedInstallation(prisma, {
    resolvedBindings: { apiKey: SECRET_REF, channel: '#ops' },
  })
  const graph = {
    steps: [
      {
        id: 'announce',
        input: {
          body: 'Posting {{ workflow.bindings.apiKey }} to {{ workflow.bindings.channel }}',
          toolName: 'message_send',
        },
        title: 'Announce',
        type: 'tool',
      },
    ],
  }
  const run = await seedRun(prisma, seed, { graph })
  t.after(async () => {
    await cleanup(prisma, [seed], [run.id])
    await prisma.$disconnect()
  })

  await executeWorkflowRun({
    prisma,
    workflowRunId: run.id,
    ...executionContext(seed, run),
  })

  const message = await prisma.message.findFirst({
    where: { thread: { channelId: seed.channelId } },
  })
  assert.ok(message, 'expected a channel message')
  assert.equal(
    message.content,
    `Posting ${WORKFLOW_SECRET_REDACTION} to #ops`,
  )
  // W0's boundary holds at this new sink: no shape of the ref survives.
  assert.equal(message.content.includes(SECRET_REF), false)
  assert.equal(message.content.includes('secret_'), false)

  const refreshedRun = await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })
  assert.equal(refreshedRun.status, 'completed')

  // The persisted step artifacts are sinks too.
  const [stepRun] = await stepRunsOf(prisma, run.id)
  assert.equal(JSON.stringify(stepRun?.input).includes(SECRET_REF), false)
  assert.equal(JSON.stringify(stepRun?.output).includes(SECRET_REF), false)
})

runDatabaseTest('W16: a falsy when: marks the step skipped and the run continues to completion', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedInstallation(prisma)
  const graph = {
    steps: [
      {
        id: 'guarded',
        input: { body: 'must never post', toolName: 'message_send' },
        title: 'Guarded',
        type: 'tool',
        when: "workflow.input.notify == 'yes'",
      },
      {
        id: 'after',
        input: { body: 'after {{ steps.guarded.status }}', toolName: 'message_send' },
        title: 'After',
        type: 'tool',
      },
    ],
  }
  const run = await seedRun(prisma, seed, { graph, workflowInput: { notify: 'no' } })
  t.after(async () => {
    await cleanup(prisma, [seed], [run.id])
    await prisma.$disconnect()
  })

  await executeWorkflowRun({
    prisma,
    workflowRunId: run.id,
    ...executionContext(seed, run),
  })

  const steps = await stepRunsOf(prisma, run.id)
  assert.equal(steps.length, 2)
  // Skipped — not failed, not halted.
  assert.equal(steps[0]?.status, 'skipped')
  // markWorkflowStepRunSkipped records the reason on errorMessage.
  assert.equal(steps[0]?.errorMessage, 'Skipped: when guard evaluated falsy.')
  assert.ok(steps[0]?.finishedAt)
  // And the run continued: the next step ran with the skipped status visible.
  assert.equal(steps[1]?.status, 'completed')

  const refreshedRun = await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })
  assert.equal(refreshedRun.status, 'completed')

  // Exactly one message: the guarded step's body never posted, and the follow-up
  // rendered the skipped status, proving the guard's document matches the
  // binding resolver's scope.
  const messages = await prisma.message.findMany({
    where: { thread: { channelId: seed.channelId } },
  })
  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.content, 'after skipped')
})

runDatabaseTest('W16: a truthy when: runs the step normally', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedInstallation(prisma)
  const graph = {
    steps: [
      {
        id: 'guarded',
        input: { body: 'truthy path posted', toolName: 'message_send' },
        title: 'Guarded',
        type: 'tool',
        when: "workflow.input.notify == 'yes'",
      },
    ],
  }
  const run = await seedRun(prisma, seed, { graph, workflowInput: { notify: 'yes' } })
  t.after(async () => {
    await cleanup(prisma, [seed], [run.id])
    await prisma.$disconnect()
  })

  await executeWorkflowRun({
    prisma,
    workflowRunId: run.id,
    ...executionContext(seed, run),
  })

  const steps = await stepRunsOf(prisma, run.id)
  assert.equal(steps.length, 1)
  assert.equal(steps[0]?.status, 'completed')

  const message = await prisma.message.findFirst({
    where: { thread: { channelId: seed.channelId } },
  })
  assert.equal(message?.content, 'truthy path posted')

  const refreshedRun = await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })
  assert.equal(refreshedRun.status, 'completed')
})
