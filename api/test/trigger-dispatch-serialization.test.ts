import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { drainPendingThreadMessages } from '@nessie/db'
import {
  createAgentTodoTemplate,
  materializeScheduledAgentTodosForRun,
} from '@nessie/workspace-admin'

import { dispatchAgentTrigger } from '../src/services/trigger-dispatch.js'

// Integration tests against the local Postgres (see AGENTS.md): API-side
// trigger dispatch (webhook intake + manual fire) takes the same per-
// (agent, thread) claim as the worker paths, so a fire that arrives while a
// run is in flight is batched — not dropped and never concurrent.
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  organizationId: string
  projectId: string
  teamId: string
  channelId: string
  threadId: string
  agentId: string
  triggerId: string
}

const seedWorkspace = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `trg-ser ${randomUUID()}` } })
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
  const agent = await prisma.agent.create({ data: { name: 'A', organizationId: org.id } })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: channel.id } })
  const trigger = await prisma.agentTrigger.create({
    data: {
      agentId: agent.id,
      type: 'webhook',
      targetChannelId: channel.id,
      targetThreadId: thread.id,
    },
  })
  return {
    organizationId: org.id,
    projectId: project.id,
    teamId: team.id,
    channelId: channel.id,
    threadId: thread.id,
    agentId: agent.id,
    triggerId: trigger.id,
  }
}

// `run.execute` payloads carry a top-level `threadId`, so the seed's thread
// scopes the delete to this suite's own jobs. An `idempotency_key LIKE
// 'run:batch:%'` sweep would match every suite's jobs — and `pnpm -r test`
// (CI) runs the api and worker suites concurrently against one database, so it
// would delete a job the worker's serialization suite is about to count.
const cleanup = async (prisma: PrismaClient, seed: Seed) => {
  await prisma
    .$executeRaw`DELETE FROM queue_jobs WHERE payload->>'threadId' = ${seed.threadId}`
    .catch(() => undefined)
  await prisma.runThreadPendingMessage.deleteMany({ where: { threadId: seed.threadId } })
  await prisma.agentTodo.deleteMany({ where: { agentId: seed.agentId } })
  await prisma.agentTodoTemplate.deleteMany({ where: { agentId: seed.agentId } })
  await prisma.agentTriggerDelivery.deleteMany({ where: { triggerId: seed.triggerId } })
  await prisma.taskEvent.deleteMany({ where: { task: { organizationId: seed.organizationId } } })
  await prisma.task.deleteMany({ where: { organizationId: seed.organizationId } })
  await prisma.message.deleteMany({ where: { threadId: seed.threadId } })
  await prisma.run.deleteMany({ where: { threadId: seed.threadId } })
  await prisma.agentTrigger.deleteMany({ where: { id: seed.triggerId } })
  await prisma.agentBinding.deleteMany({ where: { channelId: seed.channelId } })
  await prisma.thread.deleteMany({ where: { channelId: seed.channelId } })
  await prisma.channel.deleteMany({ where: { id: seed.channelId } })
  await prisma.agent.deleteMany({ where: { id: seed.agentId } })
  await prisma.team.deleteMany({ where: { id: seed.teamId } })
  await prisma.project.deleteMany({ where: { id: seed.projectId } })
  await prisma.organization.deleteMany({ where: { id: seed.organizationId } })
}

runDatabaseTest('webhook dispatch while a run is active pends, then drains into one linked follow-up', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  // First fire claims the slot and creates the run.
  const first = await dispatchAgentTrigger(prisma, {
    dedupeKey: `d-${randomUUID()}`,
    payload: { n: 1 },
    source: 'webhook',
    triggerId: seed.triggerId,
  })
  assert.equal(first.kind, 'queued')
  if (first.kind !== 'queued') return
  assert.ok(first.runId)
  assert.equal(first.existing, false)

  // Second fire while the first run is in flight: batched, not dropped.
  const second = await dispatchAgentTrigger(prisma, {
    dedupeKey: `d-${randomUUID()}`,
    payload: { n: 2 },
    source: 'webhook',
    triggerId: seed.triggerId,
  })
  assert.equal(second.kind, 'queued')
  if (second.kind !== 'queued') return
  // No run yet — the fire is a durable pending marker + delivered delivery.
  assert.equal(second.runId, undefined)
  assert.equal(second.delivery.status, 'delivered')

  const runs = await prisma.run.findMany({
    where: { agentId: seed.agentId, threadId: seed.threadId },
  })
  assert.equal(runs.length, 1)

  const pendings = await prisma.runThreadPendingMessage.findMany({
    where: { agentId: seed.agentId, threadId: seed.threadId },
  })
  assert.equal(pendings.length, 1)
  assert.equal(pendings[0]?.triggerId, seed.triggerId)
  assert.equal(pendings[0]?.triggerDeliveryId, second.delivery.id)

  // A dedupe-key replay of the pended fire is recognized as existing (never
  // re-fired, never mis-marked failed).
  const replay = await dispatchAgentTrigger(prisma, {
    dedupeKey: second.delivery.dedupeKey,
    payload: { n: 2 },
    source: 'webhook',
    triggerId: seed.triggerId,
  })
  assert.equal(replay.kind, 'queued')
  if (replay.kind !== 'queued') return
  assert.equal(replay.existing, true)
  const deliveryAfterReplay = await prisma.agentTriggerDelivery.findUnique({
    where: { id: second.delivery.id },
  })
  assert.equal(deliveryAfterReplay?.status, 'delivered')

  // The in-flight run goes terminal; the drain delivers the pended fire as
  // ONE follow-up run carrying the trigger linkage.
  await prisma.run.update({
    where: { id: runs[0]!.id },
    data: { status: 'completed', finishedAt: new Date() },
  })
  const followUpRunId = await drainPendingThreadMessages(prisma, {
    agentId: seed.agentId,
    threadId: seed.threadId,
  })
  assert.ok(followUpRunId)

  const followUp = await prisma.run.findUniqueOrThrow({ where: { id: followUpRunId } })
  assert.equal(followUp.triggerId, seed.triggerId)
  assert.equal(followUp.triggerDeliveryId, second.delivery.id)
  assert.equal(
    await prisma.runThreadPendingMessage.count({
      where: { agentId: seed.agentId, threadId: seed.threadId },
    }),
    0,
  )
  assert.equal(
    (await prisma.run.findMany({ where: { agentId: seed.agentId, threadId: seed.threadId } }))
      .length,
    2,
  )
})

runDatabaseTest('manual to-do fire carries pending provenance and materializes one pinned checklist', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  await prisma.agent.update({ where: { id: seed.agentId }, data: { todosEnabled: true } })
  const template = await createAgentTodoTemplate(prisma, {
    agentId: seed.agentId,
    authorType: 'user',
    createdByUserId: null,
    name: 'Pinned scheduled checklist',
    organizationId: seed.organizationId,
    proposedByRunId: null,
    status: 'active',
    steps: [{ instructions: 'Keep this copied instruction.', key: 'copy', title: 'Copy' }],
  })
  const secondTemplate = await createAgentTodoTemplate(prisma, {
    agentId: seed.agentId,
    authorType: 'user',
    createdByUserId: null,
    name: 'Second scheduled checklist',
    organizationId: seed.organizationId,
    proposedByRunId: null,
    status: 'active',
    steps: [{ instructions: 'Keep this second instruction.', key: 'second', title: 'Second' }],
  })
  const secondTrigger = await prisma.agentTrigger.create({
    data: {
      agentId: seed.agentId,
      config: { todoTemplateId: secondTemplate.id },
      targetChannelId: seed.channelId,
      targetThreadId: seed.threadId,
      type: 'webhook',
    },
  })
  await prisma.agentTrigger.update({
    where: { id: seed.triggerId },
    data: { config: { todoTemplateId: template.id } },
  })

  const first = await dispatchAgentTrigger(prisma, {
    payload: { source: 'manual' }, source: 'manual', triggerId: seed.triggerId,
  })
  assert.equal(first.kind, 'queued')
  const directKickoff = await prisma.message.findFirstOrThrow({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    where: { threadId: seed.threadId },
  })
  assert.deepEqual(directKickoff.metadata, {
    todoScheduledKickoff: {
      todoTemplates: [{ templateId: template.id, triggerId: seed.triggerId }],
    },
  })
  const second = await dispatchAgentTrigger(prisma, {
    payload: { source: 'manual-again' }, source: 'manual', triggerId: seed.triggerId,
  })
  assert.equal(second.kind, 'queued')
  const third = await dispatchAgentTrigger(prisma, {
    payload: { source: 'manual-other-template' }, source: 'manual', triggerId: secondTrigger.id,
  })
  assert.equal(third.kind, 'queued')

  const firstRun = await prisma.run.findFirstOrThrow({
    where: { agentId: seed.agentId, threadId: seed.threadId },
  })
  await prisma.run.update({
    where: { id: firstRun.id }, data: { finishedAt: new Date(), status: 'completed' },
  })
  const adoptedRunId = await drainPendingThreadMessages(prisma, {
    agentId: seed.agentId,
    threadId: seed.threadId,
  })
  assert.ok(adoptedRunId)
  const adoptedRun = await prisma.run.findUniqueOrThrow({ where: { id: adoptedRunId } })
  const kickoff = await prisma.message.findUniqueOrThrow({
    where: { id: adoptedRun.triggerMessageId ?? assert.fail('missing scheduled kickoff') },
  })
  assert.deepEqual(kickoff.metadata, {
    todoScheduledKickoff: {
      todoTemplates: [
        { templateId: template.id, triggerId: seed.triggerId },
        { templateId: secondTemplate.id, triggerId: secondTrigger.id },
      ],
    },
  })

  const todos = await materializeScheduledAgentTodosForRun(prisma, {
    agentId: seed.agentId,
    organizationId: seed.organizationId,
    runId: adoptedRun.id,
    templateRefs: [
      { templateId: template.id, triggerId: seed.triggerId },
      { templateId: template.id, triggerId: seed.triggerId },
      { templateId: secondTemplate.id, triggerId: secondTrigger.id },
    ],
    threadId: seed.threadId,
  })
  assert.equal(todos.length, 2, 'same-template pends coalesce while distinct templates each materialize')
  assert.equal(todos[0]?.templateVersion, template.version)
  assert.equal(todos[0]?.triggerId, seed.triggerId)
  assert.equal(todos[1]?.triggerId, secondTrigger.id)
  await prisma.agentTodoTemplate.update({
    where: { id: template.id },
    data: {
      steps: [{ instructions: 'Changed after materialization.', key: 'copy', title: 'Copy' }],
      version: { increment: 1 },
    },
  })
  const copied = await prisma.agentTodo.findUniqueOrThrow({
    include: { steps: true }, where: { id: todos[0]?.id ?? assert.fail('missing to-do') },
  })
  assert.equal(copied.steps[0]?.instructions, 'Keep this copied instruction.')
})
