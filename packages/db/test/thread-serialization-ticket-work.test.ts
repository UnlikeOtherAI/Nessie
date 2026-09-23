import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { Prisma, PrismaClient } from '@prisma/client'
import {
  parseOrganizationId,
  TICKET_WORK_PURPOSE,
  type AuthorizedActionContext,
  type RunExecuteJobPayload,
} from '@nessie/schemas'

import { claimThreadRunOrPend, drainPendingThreadMessages } from '../src/thread-serialization.js'

// A ticket-work wake is a hidden `system` kickoff rebuilt from its work record,
// and its run acts as the agent with no effective user. Folded into an ordinary
// batch it would either lose its facts behind a person's message or, when it
// is the latest row, run that person's message under the agent's authority.
// So a pended `ticket.work` row drains alone, between the batches around it.

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

runDatabaseTest('a ticket-work wake pended between people\'s messages drains as a run of its own', async (t) => {
  const prisma = new PrismaClient()
  const organization = await prisma.organization.create({ data: { name: `ticket-work drain ${randomUUID()}` } })
  const project = await prisma.project.create({ data: { name: 'Nessie', organizationId: organization.id } })
  const team = await prisma.team.create({ data: { name: 'Engineering', projectId: project.id } })
  const [person, channel, agent] = await Promise.all([
    prisma.user.create({ data: { displayName: 'Ondrej', email: `ticket-work-drain-${randomUUID()}@example.com` } }),
    prisma.channel.create({ data: {
      label: 'eng', organizationId: organization.id, projectId: project.id, slug: `eng-${randomUUID()}`, teamId: team.id,
    } }),
    prisma.agent.create({ data: { name: 'CTO', organizationId: organization.id } }),
  ])
  const thread = await prisma.thread.create({ data: { channelId: channel.id, title: 'NES-142 Fix login redirect' } })
  t.after(async () => {
    await prisma.$executeRaw(Prisma.sql`DELETE FROM queue_jobs WHERE payload->>'threadId' = ${thread.id}`)
    await prisma.runThreadPendingMessage.deleteMany({ where: { threadId: thread.id } })
    await prisma.task.deleteMany({ where: { organizationId: organization.id } })
    await prisma.run.deleteMany({ where: { threadId: thread.id } })
    await prisma.message.deleteMany({ where: { threadId: thread.id } })
    await prisma.thread.delete({ where: { id: thread.id } })
    await prisma.channel.delete({ where: { id: channel.id } })
    await prisma.agent.delete({ where: { id: agent.id } })
    await prisma.team.delete({ where: { id: team.id } })
    await prisma.project.delete({ where: { id: project.id } })
    await prisma.user.delete({ where: { id: person.id } })
    await prisma.organization.delete({ where: { id: organization.id } })
    await prisma.$disconnect()
  })

  const tenant = { organizationId: parseOrganizationId(organization.id) }
  const personContext = (): AuthorizedActionContext => ({
    actor: { actorType: 'user', actorId: person.id, roles: ['member'] },
    tenant,
    actionContext: { requestId: randomUUID() },
  })
  const wakeContext = (): AuthorizedActionContext => ({
    actor: { actorType: 'agent', actorId: agent.id, roles: ['system'] },
    tenant,
    actionContext: { purpose: TICKET_WORK_PURPOSE, requestId: randomUUID() },
  })

  // The agent is mid-run, so everything below pends.
  const busy = await prisma.run.create({ data: { agentId: agent.id, threadId: thread.id, status: 'running' } })
  // `messages.created_at` is `timestamp(3)`; state the arrival order rather
  // than race the clock for it.
  const base = Date.now()
  const arrivals = [
    { role: 'user' as const, content: 'Is the redirect fixed on staging?', context: personContext(), interactive: true },
    { role: 'user' as const, content: 'The login page is the one in the spec.', context: personContext(), interactive: true },
    { role: 'system' as const, content: 'Ticket work wake: ticket_commented.', context: wakeContext(), interactive: false },
    { role: 'user' as const, content: 'Also check the mobile app.', context: personContext(), interactive: true },
  ]
  const messageIds: string[] = []
  for (const [index, arrival] of arrivals.entries()) {
    const message = await prisma.message.create({ data: {
      content: arrival.content,
      createdAt: new Date(base + index * 1_000),
      role: arrival.role,
      threadId: thread.id,
      ...(arrival.role === 'user' ? { userId: person.id } : {}),
    } })
    messageIds.push(message.id)
    assert.equal(await prisma.$transaction((tx) => claimThreadRunOrPend(tx, {
      agentId: agent.id,
      threadId: thread.id,
      pending: {
        actorContext: arrival.context,
        channelId: channel.id,
        interactive: arrival.interactive,
        messageId: message.id,
      },
    })), 'pended')
  }
  const [firstAsk, secondAsk, wake, laterAsk] = messageIds as [string, string, string, string]

  const expected = [
    { batch: [firstAsk, secondAsk], actorType: 'user', purpose: undefined, interactive: true, replyPlacement: null },
    // The hidden kickoff cannot own a reply thread, so the wake answers in the
    // conversation, exactly as a direct claim of it would.
    { batch: [wake], actorType: 'agent', purpose: TICKET_WORK_PURPOSE, interactive: false, replyPlacement: 'channel' },
    { batch: [laterAsk], actorType: 'user', purpose: undefined, interactive: true, replyPlacement: null },
  ]
  let predecessorId = busy.id
  for (const turn of expected) {
    await prisma.run.update({ where: { id: predecessorId }, data: { finishedAt: new Date(), status: 'completed' } })
    const runId = await drainPendingThreadMessages(prisma, { agentId: agent.id, threadId: thread.id })
    assert.ok(runId, 'each terminal drain starts exactly one follow-up')

    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId }, select: {
      replyPlacement: true, triggerMessageId: true,
    } })
    assert.equal(run.triggerMessageId, turn.batch[turn.batch.length - 1])
    assert.equal(run.replyPlacement, turn.replyPlacement)

    const job = await prisma.queueJob.findFirstOrThrow({ where: { idempotencyKey: `run:batch:${runId}` } })
    const payload = job.payload as RunExecuteJobPayload
    assert.deepEqual(payload.batchMessageIds, turn.batch, 'nothing else is folded into this run')
    assert.equal(payload.interactive, turn.interactive)
    assert.equal(payload.actorContext.actor.actorType, turn.actorType)
    assert.equal(payload.actorContext.actionContext.purpose, turn.purpose)
    assert.equal(payload.actorContext.actionContext.effectiveUserId, undefined)
    predecessorId = runId
  }

  assert.equal(await prisma.runThreadPendingMessage.count({ where: { threadId: thread.id } }), 0)
})
