import assert from 'node:assert/strict'

import type { PrismaClient } from '@prisma/client'
import { lockStandingPolicyRow, suspendStandingPolicyInTransaction } from '@nessie/executor-manage'
import { lockTicketForWork } from '@nessie/team-admin'

import { dispatchTicketEvent } from '../../src/control/ticket-trigger-dispatch.js'
import { MINUTE, SESSION, pickUp, withMachinesWorld, type MachinesWorld } from './ticket-work-machines-fixture.js'
import { runDatabaseTest } from './support.js'

/**
 * The policy row's shared lock on the wake paths, against Postgres (T5;
 * docs/standards/ticket-work-machine-access.md → "A machine is assigned at
 * dispatch"): a wake that resumes work on a machine that came back reads its
 * policy only under the row's shared lock, so a suspension in flight wins; and
 * the ticket's own lock (`FOR NO KEY UPDATE`) never waits for the history row
 * an end writes while it holds its policy row, so taking the policy lock after
 * the ticket's closes no cycle.
 */

const recordOf = (prisma: PrismaClient, id: string) => prisma.agentTicketWork.findUniqueOrThrow({ where: { id } })

/** A board editor's comment on the ticket, dispatched: a follow wake. */
const comment = async (prisma: PrismaClient, world: MachinesWorld, taskId: string) => {
  const row = await prisma.taskComment.create({
    data: { authorUserId: world.colleagueId, body: 'One more thing.', organizationId: world.organizationId, taskId },
  })
  const event = await prisma.taskEvent.create({
    data: { eventType: 'comment_added', payload: { by: world.colleagueId, commentId: row.id, origin: SESSION }, taskId },
  })
  return () => dispatchTicketEvent(prisma, { organizationId: world.organizationId, taskEventId: event.id })
}

/** A suspension held open until the caller lets it commit. */
const holdSuspension = async (prisma: PrismaClient, policyId: string) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let started!: () => void
  const holding = new Promise<void>((resolve) => { started = resolve })
  const done = prisma.$transaction(async (tx) => {
    await suspendStandingPolicyInTransaction(tx, {
      actor: { userId: null }, detail: { test: true }, policyId, reason: 'trigger_changed',
    })
    started()
    await gate
  }, { timeout: 20_000 })
  await holding
  return { done, release }
}

runDatabaseTest('a wake that finds its machine back waits for a suspension in flight, and reads it', async () => {
  await withMachinesWorld(['Minis'], async (world, prisma) => {
    const [minis] = world.machines as [string]
    const { taskId, work } = await pickUp(prisma, world, 'Fix login redirect', new Set())
    // The machine went away; a comment's wake finds it offline and the work waits for it.
    await prisma.executor.update({ where: { id: minis }, data: { lastSeenAt: new Date(Date.now() - 5 * MINUTE), status: 'offline' } })
    await (await comment(prisma, world, taskId))()
    assert.deepEqual([(await recordOf(prisma, work.id)).status, (await recordOf(prisma, work.id)).stateReason],
      ['waiting_machine', 'machine_offline'])
    await prisma.executor.update({ where: { id: minis }, data: { lastSeenAt: new Date(), status: 'online' } })
    const next = await comment(prisma, world, taskId)
    // Machine access is being suspended while the next comment's wake comes.
    const suspension = await holdSuspension(prisma, world.policyId)
    let settled = false
    const wake = next().finally(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(settled, false, 'the wake waits for the policy row the suspension holds')
    suspension.release()
    await Promise.all([suspension.done, wake])
    const record = await recordOf(prisma, work.id)
    assert.deepEqual([record.status, record.stateReason, record.executorId],
      ['waiting_machine', 'machine_access_suspended', null], 'never resumed under a suspended policy')
  })
})

runDatabaseTest('the ticket\'s lock never waits for the history an end writes, so the policy lock after it closes no cycle', async () => {
  await withMachinesWorld(['Minis'], async (world, prisma) => {
    const { taskId, work } = await pickUp(prisma, world, 'Fix login redirect', new Set())
    // A wake holds the ticket's lock, and will want the policy row after it.
    let locked!: () => void
    const holdingTicket = new Promise<void>((resolve) => { locked = resolve })
    let suspended!: () => void
    const suspensionWrote = new Promise<void>((resolve) => { suspended = resolve })
    const wake = prisma.$transaction(async (tx) => {
      await lockTicketForWork(tx, taskId)
      locked()
      await suspensionWrote
      return lockStandingPolicyRow(tx, world.policyId)
    }, { timeout: 20_000 })
    await holdingTicket
    // The suspension takes the policy row, then writes the ticket's `work_paused` row under it.
    const suspension = prisma.$transaction(async (tx) => {
      await suspendStandingPolicyInTransaction(tx, {
        actor: { userId: null }, detail: { test: true }, policyId: world.policyId, reason: 'trigger_changed',
      })
      suspended()
    }, { timeout: 20_000 })
    const [status] = await Promise.all([wake, suspension])
    assert.equal(status, 'suspended', 'the wake read the suspension once it committed')
    const paused = await prisma.taskEvent.findFirstOrThrow({ where: { eventType: 'work_paused', taskId } })
    assert.equal((paused.payload as { workId: string }).workId, work.id)
  })
})
