import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import type {
  BoardTicketWorkRecord,
  TaskTicketWorkRecord,
  TicketWorkThreadGate,
} from '@nessie/schemas'
import Fastify from 'fastify'

import { registerTicketWorkRoutes } from '../src/routes/ticket-work.js'

// What the project sees of a ticket's work, through the real routes against
// Postgres (docs/standards/ticket-work.md → "What the project sees"): the
// chip's records and the skip worth saying, the thread linked only for a
// reader who may open it, the board's badges and dots, and the work thread's
// posting rule. Every read is the ticket's, board's or thread's own, never the
// owner-only Triggers routes'.

const dbTest = process.env.DATABASE_URL ? test : test.skip

const seed = async (prisma: PrismaClient) => {
  const suffix = randomUUID()
  const [editor, member, outsider] = await Promise.all(['Ondrej', 'Jana', 'Visitor'].map((name) =>
    prisma.user.create({ data: { displayName: name, email: `work-view-${name}-${suffix}@example.test` } })))
  const organization = await prisma.organization.create({ data: { name: `work-view-${suffix}` } })
  await prisma.organizationMember.createMany({
    data: [editor!, member!, outsider!].map((user) => ({ organizationId: organization.id, userId: user.id, role: 'member' })),
  })
  const project = await prisma.project.create({ data: { name: `Nessie ${suffix}`, organizationId: organization.id } })
  await prisma.projectMember.createMany({
    data: [editor!, member!].map((user) => ({ projectId: project.id, userId: user.id })),
  })
  const team = await prisma.team.create({ data: { name: `Engineering ${suffix}`, projectId: project.id } })
  const channel = (label: string, visibility: 'public' | 'protected') => prisma.channel.create({
    data: {
      label, slug: `${label}-${suffix}`, organizationId: organization.id, projectId: project.id, teamId: team.id, visibility,
    },
  })
  const room = await channel('engineering', 'public')
  // A room that went protected after its trigger was made: its reader list is
  // no longer the project's, so a ticket reader outside it gets no link.
  const closedRoom = await channel('leads', 'protected')
  await prisma.channelMember.create({ data: { channelId: closedRoom.id, userId: editor!.id } })
  const board = await prisma.board.create({
    data: { isDefault: true, name: 'Engineering', organizationId: organization.id, position: 0, projectId: project.id },
  })
  const [todo, doing, done] = await Promise.all([
    ['To do', 'todo', 0], ['In progress', 'in_progress', 1], ['Done', 'done', 2],
  ].map(([name, category, position]) => prisma.boardColumn.create({
    data: {
      boardId: board.id, category: category as 'todo', name: name as string,
      organizationId: organization.id, position: position as number,
    },
  })))
  const [cto, reviewer] = await Promise.all(['CTO', 'Reviewer'].map((name) =>
    prisma.agent.create({ data: { name, organizationId: organization.id } })))
  const ticketConfig = (columnIds: string[], wakesPerTicket = 30) => ({
    boardId: board.id,
    pickup: { assignOnPickup: true, columnIds },
    limits: { startsPerDay: 20, wakesPerTicket },
    instructions: { general: 'Triage it.' },
  })
  const trigger = await prisma.agentTrigger.create({
    data: {
      agentId: cto!.id, type: 'ticket_changed', targetChannelId: room.id, name: 'Pick up',
      config: ticketConfig([doing!.id], 12), scopeBoardId: board.id, scopeProjectId: project.id,
    },
  })
  // Disabled: its column starts nothing, so no badge.
  const paused = await prisma.agentTrigger.create({
    data: {
      agentId: reviewer!.id, type: 'ticket_changed', targetChannelId: room.id, enabled: false, status: 'paused',
      config: ticketConfig([done!.id]), scopeBoardId: board.id, scopeProjectId: project.id,
    },
  })
  const task = (title: string) =>
    prisma.task.create({ data: { organizationId: organization.id, projectId: project.id, title } })
  const [working, finished, stopped, closed] = await Promise.all([
    task('Fix login redirect'), task('Ship the docs'), task('Refactor billing'), task('Leads only'),
  ])
  const thread = (channelId: string, taskId: string) => prisma.thread.create({
    data: { agentId: cto!.id, channelId, metadata: { taskId, triggerId: trigger.id }, title: 'work' },
  })
  const work = async (taskId: string, channelId: string, data: Record<string, unknown>) =>
    prisma.agentTicketWork.create({ data: {
      agentId: cto!.id, organizationId: organization.id, projectId: project.id, taskId, triggerId: trigger.id,
      threadId: (await thread(channelId, taskId)).id, startedByUserId: editor!.id, ...data,
    } })
  const workingRecord = await work(working.id, room.id, {
    status: 'active', wakeCount: 3, lastWakeAt: new Date(), lastWakeReason: 'ticket_commented',
  })
  await work(finished.id, room.id, { status: 'done', endedAt: new Date(), endedReason: 'left_flow', stateReason: 'left_flow' })
  await work(stopped.id, room.id, {
    status: 'failed', endedAt: new Date(), endedReason: 'limit_wakes', stateReason: 'limit_wakes', wakeCount: 12,
  })
  const closedRecord = await work(closed.id, closedRoom.id, { status: 'parked' })
  const ordinaryThread = await prisma.thread.create({ data: { agentId: cto!.id, channelId: room.id } })
  return {
    board, closed, closedRecord, cto: cto!, doing: doing!, editor: editor!, finished, member: member!,
    ordinaryThread, organization, outsider: outsider!, paused, project, room, stopped, todo: todo!, trigger,
    working, workingRecord,
    cleanup: async () => {
      await prisma.organization.deleteMany({ where: { id: organization.id } })
      await prisma.user.deleteMany({ where: { id: { in: [editor!.id, member!.id, outsider!.id] } } })
    },
  }
}

type Seeded = Awaited<ReturnType<typeof seed>>

const withRoutes = async (
  run: (input: {
    app: ReturnType<typeof Fastify>
    as: (userId: string, roles?: string[]) => void
    s: Seeded
    prisma: PrismaClient
  }) => Promise<void>,
) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  let viewer = { id: s.editor.id, roles: ['member'] }
  const accessible = () => (viewer.id === s.outsider.id ? [] : [s.project.id])
  const app = Fastify({ logger: false })
  registerTicketWorkRoutes(app, {
    isProjectAccessibleToActor: async (_actor: unknown, projectId: string) => accessible().includes(projectId),
    listAccessibleProjectIds: async () => accessible(),
    prisma,
    requireActorContext: () => ({
      actor: { actorType: 'user', actorId: viewer.id, roles: viewer.roles },
      actionContext: { requestId: randomUUID() },
      tenant: { organizationId: s.organization.id },
    }),
    requireUserActor: () => true,
  } as never)
  await app.ready()
  try {
    await run({ app, as: (id, roles = ['member']) => { viewer = { id, roles } }, s, prisma })
  } finally {
    await app.close()
    try { await s.cleanup() } finally { await prisma.$disconnect() }
  }
}

const read = async <T>(app: ReturnType<typeof Fastify>, url: string): Promise<{ status: number; data: T }> => {
  const response = await app.inject({ method: 'GET', url })
  return { status: response.statusCode, data: (response.json() as { data: T }).data }
}

dbTest('the chip names the work, its last wake and its limit, and links the thread for its readers', async () => {
  await withRoutes(async ({ app, as, s }) => {
    const { status, data } = await read<TaskTicketWorkRecord>(app, `/api/tasks/${s.working.id}/work`)
    assert.equal(status, 200)
    assert.equal(data.records.length, 1)
    const [record] = data.records
    assert.equal(record!.id, s.workingRecord.id)
    assert.equal(record!.status, 'active')
    assert.equal(record!.agent.name, 'CTO')
    assert.equal(record!.startedByName, 'Ondrej')
    assert.equal(record!.lastWakeReason, 'ticket_commented')
    assert.equal(record!.wakeCount, 3)
    assert.equal(record!.wakeLimit, 12, 'the trigger\'s own wakesPerTicket')
    assert.deepEqual(record!.thread, { id: s.workingRecord.threadId, channelId: s.room.id })
    assert.equal(data.lastSkip, null)

    // A thread in a room the reader is not in: the chip, and no door.
    as(s.member.id)
    const closed = await read<TaskTicketWorkRecord>(app, `/api/tasks/${s.closed.id}/work`)
    assert.equal(closed.data.records[0]!.status, 'parked')
    assert.equal(closed.data.records[0]!.thread, null)
    as(s.editor.id)
    const opened = await read<TaskTicketWorkRecord>(app, `/api/tasks/${s.closed.id}/work`)
    assert.equal(opened.data.records[0]!.thread?.id, s.closedRecord.threadId)

    // Someone who cannot read the ticket is told nothing about it.
    as(s.outsider.id)
    assert.equal((await read(app, `/api/tasks/${s.working.id}/work`)).status, 404)
  })
})

dbTest('a move that started nothing is said on the ticket until work starts after it', async () => {
  await withRoutes(async ({ app, s, prisma }) => {
    const skip = (taskId: string, skipReason: string, createdAt: Date) => prisma.agentTriggerDelivery.create({
      data: {
        createdAt,
        dedupeKey: `ticket:${s.trigger.id}:${randomUUID()}`,
        errorMessage: skipReason,
        payload: {
          eventType: 'column_entered', originKind: 'agent', outcome: 'skipped', skipReason,
          taskEventId: randomUUID(), taskId,
        },
        source: 'pickup',
        status: 'skipped',
        triggerId: s.trigger.id,
      },
    })
    const fresh = await prisma.task.create({
      data: { organizationId: s.organization.id, projectId: s.project.id, title: 'Moved by an agent' },
    })
    await skip(fresh.id, 'agent_origin', new Date())
    const said = await read<TaskTicketWorkRecord>(app, `/api/tasks/${fresh.id}/work`)
    assert.deepEqual(said.data.records, [])
    assert.equal(said.data.lastSkip?.reason, 'agent_origin')
    assert.equal(said.data.lastSkip?.agentName, 'CTO')

    // Older than the work that did start: nothing to say any more.
    await skip(s.working.id, 'token_origin', new Date(Date.now() - 60 * 60 * 1000))
    assert.equal((await read<TaskTicketWorkRecord>(app, `/api/tasks/${s.working.id}/work`)).data.lastSkip, null)

    // Bookkeeping skips are the Triggers page's, not the ticket's.
    const other = await prisma.task.create({
      data: { organizationId: s.organization.id, projectId: s.project.id, title: 'Between start columns' },
    })
    await skip(other.id, 'already_in_pickup_column', new Date())
    assert.equal((await read<TaskTicketWorkRecord>(app, `/api/tasks/${other.id}/work`)).data.lastSkip, null)

    // A pickup that failed and switched its trigger off is said on the ticket.
    const failed = await prisma.task.create({
      data: { organizationId: s.organization.id, projectId: s.project.id, title: 'Picked up as the channel went' },
    })
    await prisma.agentTriggerDelivery.create({
      data: {
        dedupeKey: `ticket:${s.trigger.id}:${randomUUID()}`,
        errorMessage: 'its agent is no longer in the target channel',
        payload: {
          eventType: 'column_entered', originKind: 'session', outcome: 'pickup', wakeReason: 'pickup',
          taskEventId: randomUUID(), taskId: failed.id,
        },
        source: 'pickup',
        status: 'failed',
        triggerId: s.trigger.id,
      },
    })
    const readFailed = () => read<TaskTicketWorkRecord>(app, `/api/tasks/${failed.id}/work`)
    assert.equal((await readFailed()).data.lastSkip, null, 'a failure still being retried is not the ticket\'s news yet')
    await prisma.agentTrigger.update({ where: { id: s.trigger.id }, data: { status: 'error', enabled: false } })
    assert.equal((await readFailed()).data.lastSkip?.reason, 'trigger_failed')
  })
})

dbTest('the board says which columns start work, which cards work is on, and who may add a doorway', async () => {
  await withRoutes(async ({ app, as, s }) => {
    const { status, data } = await read<BoardTicketWorkRecord>(
      app, `/api/projects/${s.project.id}/boards/${s.board.id}/ticket-work`,
    )
    assert.equal(status, 200)
    assert.deepEqual(data.pickups, [
      { agentId: s.cto.id, agentName: 'CTO', columnId: s.doing.id, triggerId: s.trigger.id },
    ], 'the disabled trigger\'s column starts nothing')
    assert.deepEqual(
      data.cards.map((card) => [card.taskId, card.status, card.stateReason]).sort(),
      [
        [s.working.id, 'active', null],
        [s.stopped.id, 'failed', 'limit_wakes'],
        [s.closed.id, 'parked', null],
      ].sort(),
      'live work and work a limit stopped; finished work leaves no dot',
    )
    assert.equal(data.viewerCanCreateTriggers, false)
    as(s.editor.id, ['owner'])
    assert.equal((await read<BoardTicketWorkRecord>(
      app, `/api/projects/${s.project.id}/boards/${s.board.id}/ticket-work`,
    )).data.viewerCanCreateTriggers, true, 'the Triggers routes\' own owner gate')
    as(s.outsider.id)
    assert.equal((await read(app, `/api/projects/${s.project.id}/boards/${s.board.id}/ticket-work`)).status, 404)
  })
})

dbTest('a work thread says who may write in it; an ordinary thread is none', async () => {
  await withRoutes(async ({ app, as, s }) => {
    const url = `/api/threads/${s.workingRecord.threadId}/ticket-work`
    const editor = await read<TicketWorkThreadGate>(app, url)
    assert.equal(editor.status, 200)
    assert.equal(editor.data.taskId, s.working.id)
    assert.equal(editor.data.taskTitle, 'Fix login redirect')
    assert.equal(editor.data.viewerCanPost, true)

    // Reads the public room, cannot edit the board: sees it, may not steer it.
    as(s.outsider.id)
    const outsider = await read<TicketWorkThreadGate>(app, url)
    assert.equal(outsider.status, 200)
    assert.equal(outsider.data.viewerCanPost, false)
    // A room they are not in is not theirs to ask about.
    assert.equal((await read(app, `/api/threads/${s.closedRecord.threadId}/ticket-work`)).status, 404)

    as(s.editor.id)
    const ordinary = await read<TicketWorkThreadGate | null>(app, `/api/threads/${s.ordinaryThread.id}/ticket-work`)
    assert.equal(ordinary.status, 200)
    assert.equal(ordinary.data, null)
  })
})

dbTest('a work thread says whether a message there reaches the agent, and why not', async () => {
  await withRoutes(async ({ app, s, prisma }) => {
    const outcome = async (threadId: string) =>
      (await read<TicketWorkThreadGate>(app, `/api/threads/${threadId}/ticket-work`)).data.messageOutcome
    assert.equal(await outcome(s.workingRecord.threadId), 'wakes')
    const finished = await prisma.agentTicketWork.findFirstOrThrow({ where: { taskId: s.finished.id } })
    assert.equal(await outcome(finished.threadId), 'work_ended')
    await prisma.agentTrigger.update({
      where: { id: s.trigger.id },
      data: { config: { ...(s.trigger.config as Record<string, unknown>), follow: { kinds: ['comment'] } } },
    })
    assert.equal(await outcome(s.workingRecord.threadId), 'not_followed')
    await prisma.agentTrigger.update({ where: { id: s.trigger.id }, data: { enabled: false, status: 'paused' } })
    assert.equal(await outcome(s.workingRecord.threadId), 'trigger_disabled')
  })
})

dbTest('the chip lists the ticket\'s work history, and a refused re-entry says the work did not resume', async () => {
  await withRoutes(async ({ app, s, prisma }) => {
    const row = (eventType: string, payload: Record<string, unknown>, createdAt: Date) => prisma.taskEvent.create({
      data: {
        taskId: s.working.id, eventType, createdAt,
        payload: {
          origin: { kind: 'system' }, workId: s.workingRecord.id, triggerId: s.trigger.id, agentId: s.cto.id, ...payload,
        },
      },
    })
    const base = Date.now() - 10_000
    await row('work_started', { status: 'active', reason: null, by: s.editor.id }, new Date(base))
    await row('work_paused', { status: 'parked', reason: null, by: `agent:${s.cto.id}` }, new Date(base + 1000))
    const { data } = await read<TaskTicketWorkRecord>(app, `/api/tasks/${s.working.id}/work`)
    assert.deepEqual(
      data.history.map((entry) => [entry.eventType, entry.agentName, entry.byName]),
      [['work_paused', 'CTO', 'CTO'], ['work_started', 'CTO', 'Ondrej']],
      'newest first, who caused each by name',
    )

    // An agent's move back into the start-work column left the work parked.
    const parked = await prisma.task.create({
      data: { organizationId: s.organization.id, projectId: s.project.id, title: 'Parked' },
    })
    const record = await prisma.agentTicketWork.create({ data: {
      agentId: s.cto.id, organizationId: s.organization.id, projectId: s.project.id, taskId: parked.id,
      triggerId: s.trigger.id, threadId: s.workingRecord.threadId, startedByUserId: s.editor.id, status: 'parked',
      startedAt: new Date(base),
    } })
    const followSkip = (reentry: boolean) => prisma.agentTriggerDelivery.create({
      data: {
        dedupeKey: `ticket:${s.trigger.id}:${randomUUID()}`,
        errorMessage: 'agent_origin',
        payload: {
          eventType: 'column_entered', originKind: 'agent', outcome: 'skipped', skipReason: 'agent_origin',
          taskEventId: randomUUID(), taskId: parked.id, ...(reentry ? { reentry: true } : {}),
        },
        source: 'follow',
        status: 'skipped',
        triggerId: s.trigger.id,
      },
    })
    // An agent's ordinary move of live work is the Triggers page's business…
    await followSkip(false)
    assert.equal((await read<TaskTicketWorkRecord>(app, `/api/tasks/${parked.id}/work`)).data.lastSkip, null)
    // …a refused re-entry is the ticket's.
    await followSkip(true)
    const said = await read<TaskTicketWorkRecord>(app, `/api/tasks/${parked.id}/work`)
    assert.deepEqual([said.data.lastSkip?.reason, said.data.lastSkip?.reentry], ['agent_origin', true])
    assert.equal(said.data.records[0]?.id, record.id)
  })
})

dbTest('the chip names the pending reminder and the open question, and only a board editor may cancel the reminder', async () => {
  await withRoutes(async ({ app, as, s, prisma }) => {
    const dueAt = new Date(Date.now() + 15 * 60 * 1000)
    const reminder = await prisma.agentReminder.create({
      data: {
        agentId: s.cto.id, threadId: s.workingRecord.threadId, workId: s.workingRecord.id,
        dueAt, note: 'waiting for CI',
      },
    })
    const askedAt = new Date(Date.now() - 5 * 60 * 1000)
    await prisma.agentTicketWork.update({ where: { id: s.workingRecord.id }, data: { awaitingAnswerAt: askedAt } })
    // A member of the organisation outside the project: reads the ticket
    // here (the harness lets every viewer but the outsider read it), cannot
    // edit its board.
    const reader = await prisma.user.create({
      data: { displayName: 'Reader', email: `work-view-reader-${randomUUID()}@example.test` },
    })
    await prisma.organizationMember.create({
      data: { organizationId: s.organization.id, userId: reader.id, role: 'member' },
    })
    const cancel = (reminderId: string) =>
      app.inject({ method: 'DELETE', url: `/api/tasks/${s.working.id}/work/reminders/${reminderId}` })
    try {
      const seen = await read<TaskTicketWorkRecord>(app, `/api/tasks/${s.working.id}/work`)
      assert.equal(seen.data.viewerCanEditBoard, true)
      assert.deepEqual(seen.data.records[0]!.pendingReminder, {
        id: reminder.id, dueAt: dueAt.toISOString(), note: 'waiting for CI',
      })
      assert.equal(seen.data.records[0]!.awaitingAnswerAt, askedAt.toISOString())

      as(reader.id)
      const read_ = await read<TaskTicketWorkRecord>(app, `/api/tasks/${s.working.id}/work`)
      assert.equal(read_.status, 200)
      assert.equal(read_.data.viewerCanEditBoard, false, 'no Cancel for a reader who cannot edit the board')
      assert.equal(read_.data.records[0]!.pendingReminder?.note, 'waiting for CI', 'but the reminder is said')
      const refused = await cancel(reminder.id)
      assert.equal(refused.statusCode, 403)
      assert.equal((refused.json() as { error: { code: string } }).error.code, 'TICKET_WORK_REMINDER_READ_ONLY')
      as(s.outsider.id)
      assert.equal((await cancel(reminder.id)).statusCode, 404, 'someone who cannot read the ticket learns nothing')
      assert.equal((await prisma.agentReminder.findUniqueOrThrow({ where: { id: reminder.id } })).status, 'pending')

      as(s.editor.id)
      const cancelled = await cancel(reminder.id)
      assert.equal(cancelled.statusCode, 200)
      const row = await prisma.agentReminder.findUniqueOrThrow({ where: { id: reminder.id } })
      assert.deepEqual([row.status, row.cancelledReason], ['cancelled', 'person'])
      // The work thread says who cancelled it, and the audit trail records it.
      const trace = await prisma.message.findFirstOrThrow({
        where: {
          threadId: s.workingRecord.threadId,
          role: 'system',
          metadata: { path: ['ticketWorkEvent', 'kind'], equals: 'reminder_cancelled' },
        },
      })
      assert.equal(trace.content, 'Reminder cancelled: Ondrej cancelled the agent\'s reminder')
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId: s.organization.id, action: 'trigger.reminder_cancelled', resourceId: reminder.id },
      })
      assert.equal(audit.actorId, s.editor.id)
      assert.equal(audit.resourceType, 'agent_reminder')
      const again = await cancel(reminder.id)
      assert.equal(again.statusCode, 404)
      assert.equal((again.json() as { error: { code: string } }).error.code, 'REMINDER_NOT_FOUND')
      const after = await read<TaskTicketWorkRecord>(app, `/api/tasks/${s.working.id}/work`)
      assert.equal(after.data.records[0]!.pendingReminder, null)

      // A reminder on another ticket's work is not this ticket's to cancel.
      const elsewhere = await prisma.agentReminder.create({
        data: { agentId: s.cto.id, threadId: s.closedRecord.threadId, workId: s.closedRecord.id, dueAt, note: 'later' },
      })
      assert.equal((await cancel(elsewhere.id)).statusCode, 404)
      assert.equal((await cancel('not-a-uuid')).statusCode, 404)
    } finally {
      await prisma.user.delete({ where: { id: reader.id } })
    }
  })
})
