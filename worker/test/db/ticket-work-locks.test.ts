import assert from 'node:assert/strict'

import { Prisma, PrismaClient } from '@prisma/client'

import { lockThreadRunSlot } from '../../src/run/thread-serialization.js'
import { runDatabaseTest } from './support.js'
import { drainTicketJobs, finishRuns, move, newTask, seedTicketWork } from './ticket-work-fixture.js'

// Ticket work takes its locks in one order — the ticket, then the thread's
// run slot, then the work record, then a reminder (docs/standards/ticket-work.md
// → "Reminders, the quiet wake and the sweep") — so a wake and a reminder's
// claim on the same record can never wait on each other.

runDatabaseTest('a person\'s wake waits for the run slot before it writes the record, so a reminder claim holding the slot finishes', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const seen = new Set<string>()
  const task = await newTask(prisma, s)
  await move(prisma, s, task.id, s.columns.inProgress)
  await drainTicketJobs(prisma, s, seen)
  const work = await prisma.agentTicketWork.findFirstOrThrow({ where: { triggerId: s.triggerId, taskId: task.id } })
  await finishRuns(prisma, work.threadId)
  // Parked in review, then a person moves it back: that wake resumes the record.
  await move(prisma, s, task.id, s.columns.review)
  await drainTicketJobs(prisma, s, seen)
  await finishRuns(prisma, work.threadId)
  await move(prisma, s, task.id, s.columns.inProgress)
  const back = await prisma.taskEvent.findFirstOrThrow({
    where: { taskId: task.id, eventType: 'column_entered' }, orderBy: { createdAt: 'desc' },
  })

  // A reminder's claim: it holds the thread's run slot, and then wants the record.
  let slotHeld!: () => void
  const holding = new Promise<void>((resolve) => { slotHeld = resolve })
  const claim = prisma.$transaction(async (tx) => {
    await lockThreadRunSlot(tx, { agentId: s.agentId, threadId: work.threadId })
    slotHeld()
    // Long enough for the wake below to reach whatever it waits on.
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    await tx.$queryRaw(Prisma.sql`SELECT id FROM agent_ticket_work WHERE id = ${work.id}::uuid FOR UPDATE`)
  }, { timeout: 30_000 })
  await holding
  const wake = drainTicketJobs(prisma, s, seen)
  await Promise.all([claim, wake])

  const delivery = await prisma.agentTriggerDelivery.findUniqueOrThrow({
    where: { triggerId_dedupeKey: { triggerId: s.triggerId, dedupeKey: `ticket:${s.triggerId}:${back.id}` } },
  })
  assert.equal(delivery.status, 'delivered', delivery.errorMessage ?? '')
  const resumed = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
  assert.deepEqual([resumed.status, resumed.lastWakeReason], ['active', 'ticket_moved'])
})
