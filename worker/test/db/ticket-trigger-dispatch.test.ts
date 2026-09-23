import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import type { NormalisedItem } from '@nessie/board-sources'
import {
  TRIGGER_TICKET_DISPATCH_TOPIC,
  TriggerTicketDispatchJobPayloadSchema,
  type AuthorizedActionContext,
  type TaskEventOrigin,
} from '@nessie/schemas'
import {
  applyInboundItem,
  assignProjectTask,
  createProjectTask,
  createTaskComment,
  moveProjectTaskToColumn,
} from '@nessie/team-admin'

import { reattemptTriggerDelivery } from '../../src/control/trigger-retry-dispatch.js'
import { dispatchTicketEvent, reattemptTicketTriggerDelivery } from '../../src/control/ticket-trigger-dispatch.js'
import type { TicketWorkSeam } from '../../src/control/ticket-work-seam.js'
import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import { runTicketCreateTool, runTicketMoveTool } from '../../src/run/pa-tools/tickets.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { runDatabaseTest } from './support.js'

// `trigger.ticket.dispatch` end to end against Postgres: real writers stamp
// the origin and enqueue the job in their transaction, the dispatcher reads
// the event and the board's triggers afresh, and each decision is one
// delivery row (docs/standards/ticket-work.md). The work seam is a recorder:
// what a start or a wake then does is not this layer's.

const SESSION: TaskEventOrigin = { kind: 'session' }

const recordingSeam = () => {
  const calls: Array<{ op: 'start' | 'wake'; input: Record<string, unknown> }> = []
  const seam: TicketWorkSeam = {
    startTicketWork: async (_tx, input) => {
      calls.push({ op: 'start', input: input as unknown as Record<string, unknown> })
      return { outcome: 'started', workId: randomUUID() }
    },
    wakeTicketWork: async (_tx, input) => {
      calls.push({ op: 'wake', input: input as unknown as Record<string, unknown> })
      return { outcome: 'woken', workId: input.workId }
    },
  }
  return { calls, seam }
}

const seed = async (
  prisma: PrismaClient,
  options: { pickup?: 'backlog+inProgress' | 'inProgress'; includeSourceEvents?: boolean } = {},
) => {
  const suffix = randomUUID()
  const [editor, outsider] = await Promise.all(['editor', 'outsider'].map((name) =>
    prisma.user.create({ data: { displayName: name, email: `dispatch-${name}-${suffix}@example.test` } })))
  const organization = await prisma.organization.create({ data: { name: `dispatch-${suffix}` } })
  await prisma.organizationMember.createMany({
    data: [editor!, outsider!].map((user) => ({ organizationId: organization.id, userId: user.id, role: 'member' })),
  })
  const project = await prisma.project.create({ data: { name: `dispatch-${suffix}`, organizationId: organization.id } })
  // Only the editor is a project member: the outsider can reach a ticket
  // assigned to them, but cannot edit the board.
  await prisma.projectMember.create({ data: { projectId: project.id, userId: editor!.id } })
  const team = await prisma.team.create({ data: { name: `dispatch-${suffix}`, projectId: project.id } })
  const board = await prisma.board.create({
    data: { projectId: project.id, organizationId: organization.id, name: 'Engineering', isDefault: true, position: 0 },
  })
  const column = async (name: string, category: 'todo' | 'in_progress' | 'review' | 'done', position: number) =>
    (await prisma.boardColumn.create({
      data: { boardId: board.id, organizationId: organization.id, name, category, position },
    })).id
  const columns = {
    backlog: await column('Backlog', 'todo', 0),
    inProgress: await column('In progress', 'in_progress', 1),
    review: await column('Review', 'review', 2),
    done: await column('Done', 'done', 3),
  }
  const agent = await prisma.agent.create({ data: { name: `cto-${suffix}`, organizationId: organization.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'engineering',
      slug: `engineering-${suffix}`,
      organization: { connect: { id: organization.id } },
      project: { connect: { id: project.id } },
      team: { connect: { id: team.id } },
    },
  })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: channel.id } })
  const thread = await prisma.thread.create({ data: { channelId: channel.id, title: 'NES-1 Fix login' } })
  const connection = await prisma.boardSourceConnection.create({
    data: {
      organizationId: organization.id,
      ownerUserId: editor!.id,
      provider: 'linear',
      externalAccountId: `acct-${suffix}`,
      externalTenantId: `org-${suffix}`,
    },
  })
  const source = await prisma.boardSource.create({
    data: {
      projectId: project.id,
      organizationId: organization.id,
      connectionId: connection.id,
      provider: 'linear',
      name: 'Linear',
      container: { teamId: 'team-1' },
      containerKey: `team-${suffix}`,
      createdByUserId: editor!.id,
    },
  })
  const pickupColumnIds = options.pickup === 'backlog+inProgress'
    ? [columns.backlog, columns.inProgress]
    : [columns.inProgress]
  const trigger = await prisma.agentTrigger.create({
    data: {
      agentId: agent.id,
      type: 'ticket_changed',
      targetChannelId: channel.id,
      scopeProjectId: project.id,
      scopeBoardId: board.id,
      config: {
        boardId: board.id,
        pickup: { columnIds: pickupColumnIds },
        follow: { includeSourceEvents: options.includeSourceEvents ?? false },
      },
    },
  })
  const actorContext = {
    actor: { actorId: editor!.id, actorType: 'user', roles: ['member'] },
    actionContext: { requestId: randomUUID() },
    tenant: { organizationId: organization.id },
  } as unknown as AuthorizedActionContext
  return {
    organizationId: organization.id,
    projectId: project.id,
    boardId: board.id,
    editorId: editor!.id,
    outsiderId: outsider!.id,
    agentId: agent.id,
    channelId: channel.id,
    threadId: thread.id,
    sourceId: source.id,
    triggerId: trigger.id,
    columns,
    actorContext,
    cleanup: async () => {
      await prisma.organization.deleteMany({ where: { id: organization.id } })
      await prisma.user.deleteMany({ where: { id: { in: [editor!.id, outsider!.id] } } })
      // The dispatch jobs this seed's events enqueued carry no key to cascade on.
      await prisma.queueJob.deleteMany({
        where: { topic: TRIGGER_TICKET_DISPATCH_TOPIC, payload: { path: ['organizationId'], equals: organization.id } },
      })
    },
  }
}
type Seed = Awaited<ReturnType<typeof seed>>

const newTask = async (prisma: PrismaClient, s: Seed, origin: TaskEventOrigin = SESSION) => {
  const created = await createProjectTask(prisma, {
    actorContext: s.actorContext,
    organizationId: s.organizationId,
    createdByUserId: s.editorId,
    projectId: s.projectId,
    title: 'Fix login redirect',
    origin,
  })
  assert.ok(!('error' in created))
  return created
}

const move = (prisma: PrismaClient, s: Seed, taskId: string, columnId: string, origin: TaskEventOrigin) =>
  moveProjectTaskToColumn(prisma, {
    taskId, organizationId: s.organizationId, columnId, actorId: s.editorId, origin,
  })

/**
 * Dispatch every job the task's events enqueued that this suite has not run
 * yet, oldest first — exactly the jobs the writers put on the queue, so a
 * writer that forgot to enqueue fails here.
 */
const drain = async (prisma: PrismaClient, taskId: string, seam: TicketWorkSeam, seen: Set<string>) => {
  const events = await prisma.taskEvent.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } })
  const jobs = await prisma.queueJob.findMany({
    where: {
      topic: TRIGGER_TICKET_DISPATCH_TOPIC,
      idempotencyKey: { in: events.map((event) => `${TRIGGER_TICKET_DISPATCH_TOPIC}:${event.id}`) },
    },
    orderBy: { enqueuedAt: 'asc' },
  })
  for (const job of jobs) {
    if (seen.has(job.id)) continue
    seen.add(job.id)
    await dispatchTicketEvent(prisma, TriggerTicketDispatchJobPayloadSchema.parse(job.payload), { seam })
  }
}

const latestEvent = (prisma: PrismaClient, taskId: string, eventType: string) =>
  prisma.taskEvent.findFirstOrThrow({ where: { taskId, eventType }, orderBy: { createdAt: 'desc' } })

const deliveryFor = (prisma: PrismaClient, triggerId: string, taskEventId: string) =>
  prisma.agentTriggerDelivery.findUnique({
    where: { triggerId_dedupeKey: { triggerId, dedupeKey: `ticket:${triggerId}:${taskEventId}` } },
  })

/** The worker's ticket tools, run for the editor by the seed's shared agent. */
const agentContext = (prisma: PrismaClient, s: Seed): BuiltinToolRuntimeContext => ({
  actorContext: {
    actionContext: { requestId: randomUUID() },
    actor: { actorId: s.editorId, actorType: 'user', roles: ['member'] },
    tenant: { organizationId: s.organizationId },
  },
  agentId: s.agentId,
  agentKind: 'shared',
  channel: { id: s.channelId, organizationId: s.organizationId, projectId: s.projectId },
  consumedSources: createConsumedSourceSink(),
  ledgerIdentity: null,
  prisma,
  realtimeTransport: { publishWs: async () => undefined },
  run: { id: randomUUID(), interactive: true, messageId: randomUUID(), threadId: s.threadId },
  toolCallId: randomUUID(),
} as unknown as BuiltinToolRuntimeContext)

const liveWork = (prisma: PrismaClient, s: Seed, taskId: string, status: 'active' | 'parked') =>
  prisma.agentTicketWork.create({
    data: {
      organizationId: s.organizationId,
      triggerId: s.triggerId,
      agentId: s.agentId,
      taskId,
      projectId: s.projectId,
      threadId: s.threadId,
      status,
      startedByUserId: s.editorId,
    },
  })

const sourceContext = (s: Seed) => ({
  id: s.sourceId,
  organizationId: s.organizationId,
  projectId: s.projectId,
  provider: 'linear',
  stateMapping: [
    { externalStateId: 'todo', externalStateName: 'Todo', category: 'todo' as const, isDefaultForCategory: true },
    { externalStateId: 'doing', externalStateName: 'Doing', category: 'in_progress' as const, isDefaultForCategory: true },
    { externalStateId: 'review', externalStateName: 'Review', category: 'review' as const, isDefaultForCategory: true },
  ],
  fieldMappings: [],
  identityByExternalUserId: new Map(),
})

const sourceItem = (over: Partial<NormalisedItem> = {}): NormalisedItem => ({
  externalId: 'issue-1', externalKey: 'ENG-1', url: 'https://linear.app/acme/issue/ENG-1',
  title: 'Mirrored', description: 'From upstream', stateId: 'todo', stateName: 'Todo',
  assignee: null, priority: 'high', dueDate: null, labels: [], fields: {},
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z', archived: false,
  ...over,
})

runDatabaseTest('a board editor\'s own move starts work once, however often the job replays', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const { calls, seam } = recordingSeam()
  const task = await newTask(prisma, s)

  await move(prisma, s, task.id, s.columns.inProgress, SESSION)
  const seen = new Set<string>()
  await drain(prisma, task.id, seam, seen)
  const entered = await latestEvent(prisma, task.id, 'column_entered')
  // At-least-once: the same job again finds its delivery and starts nothing.
  await dispatchTicketEvent(prisma, { organizationId: s.organizationId, taskEventId: entered.id }, { seam })

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.op, 'start')
  assert.equal(calls[0]?.input.startedByUserId, s.editorId)
  const delivery = await deliveryFor(prisma, s.triggerId, entered.id)
  assert.equal(delivery?.status, 'delivered')
  assert.equal(delivery?.source, 'pickup')
  assert.deepEqual(
    { ...(delivery?.payload as Record<string, unknown>), workId: undefined },
    {
      taskEventId: entered.id, taskId: task.id, eventType: 'column_entered', originKind: 'session',
      outcome: 'pickup', wakeReason: 'pickup', workId: undefined,
    },
  )
})

runDatabaseTest('an agent\'s move, a token\'s move, and agent\'s, token\'s and a source\'s create each start nothing', async (t) => {
  const prisma = new PrismaClient()
  // Backlog is a start-work column here too, so a create lands in one.
  const s = await seed(prisma, { pickup: 'backlog+inProgress', includeSourceEvents: true })
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const { calls, seam } = recordingSeam()
  const seen = new Set<string>()
  const expectSkip = async (taskId: string, eventType: string, reason: string, source = 'pickup') => {
    await drain(prisma, taskId, seam, seen)
    const event = await latestEvent(prisma, taskId, eventType)
    const delivery = await deliveryFor(prisma, s.triggerId, event.id)
    assert.equal(delivery?.status, 'skipped', `${eventType} ${reason}`)
    assert.equal(delivery?.source, source)
    assert.equal(delivery?.errorMessage, reason)
    assert.equal((delivery?.payload as { skipReason?: string }).skipReason, reason)
  }

  // 1. An agent's ticket_move into the column, through the real worker tool.
  // The ticket is the platform's own (a system create starts nothing either).
  const moved = await newTask(prisma, s, { kind: 'system' })
  await expectSkip(moved.id, 'created', 'system_origin')
  const moving = agentContext(prisma, s)
  await runTicketMoveTool(moving, { ticketId: moved.id, columnId: s.columns.inProgress })
  // The tool stamps the agent and its run; the editor it acted for stays `by`.
  const agentMove = await latestEvent(prisma, moved.id, 'column_entered')
  assert.deepEqual((agentMove.payload as { origin?: unknown }).origin, {
    kind: 'agent', agentId: s.agentId, runId: moving.run.id,
  })
  assert.equal((agentMove.payload as { by?: unknown }).by, s.editorId)
  await expectSkip(moved.id, 'column_entered', 'agent_origin')

  // 2. An API-token move (what the MCP surface stamps).
  const tokened = await newTask(prisma, s, { kind: 'token', keyId: randomUUID() })
  await expectSkip(tokened.id, 'created', 'token_origin')
  await move(prisma, s, tokened.id, s.columns.inProgress, { kind: 'token', keyId: randomUUID() })
  await expectSkip(tokened.id, 'column_entered', 'token_origin')

  // 3. An agent's ticket_create straight into the column.
  const created = await runTicketCreateTool(agentContext(prisma, s), { title: 'Created by the agent' })
  assert.match(created.outputPreview, /Created ticket/)
  const agentTask = await prisma.task.findFirstOrThrow({ where: { projectId: s.projectId, title: 'Created by the agent' } })
  await expectSkip(agentTask.id, 'created', 'agent_origin')

  // 4. A board-source create into the column, even with source events followed.
  const synced = await applyInboundItem(prisma, sourceContext(s), sourceItem({ stateId: 'doing', stateName: 'Doing' }))
  assert.ok('taskId' in synced && synced.taskId)
  await expectSkip(synced.taskId, 'created', 'source_origin')

  assert.deepEqual(calls, [], 'none of them may start or wake anything')
  assert.equal(await prisma.agentTicketWork.count({ where: { triggerId: s.triggerId } }), 0)
})

runDatabaseTest('a token or agent move back into a start-work column leaves a parked record parked', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const { calls, seam } = recordingSeam()
  const seen = new Set<string>()
  const task = await newTask(prisma, s)
  await move(prisma, s, task.id, s.columns.review, SESSION)
  await drain(prisma, task.id, seam, seen)
  const parked = await liveWork(prisma, s, task.id, 'parked')

  await move(prisma, s, task.id, s.columns.inProgress, { kind: 'token', keyId: randomUUID() })
  await drain(prisma, task.id, seam, seen)
  const byToken = await latestEvent(prisma, task.id, 'column_entered')
  assert.equal((await deliveryFor(prisma, s.triggerId, byToken.id))?.errorMessage, 'token_origin')

  await move(prisma, s, task.id, s.columns.review, { kind: 'token', keyId: randomUUID() })
  await runTicketMoveTool(agentContext(prisma, s), { ticketId: task.id, columnId: s.columns.inProgress })
  await drain(prisma, task.id, seam, seen)
  const byAgent = await latestEvent(prisma, task.id, 'column_entered')
  assert.equal((await deliveryFor(prisma, s.triggerId, byAgent.id))?.errorMessage, 'agent_origin')

  assert.deepEqual(calls, [])
  const still = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: parked.id } })
  assert.equal(still.status, 'parked')

  // The editor's own move back is a re-entry on the same record, never a second pickup.
  await move(prisma, s, task.id, s.columns.review, SESSION)
  await move(prisma, s, task.id, s.columns.inProgress, SESSION)
  await drain(prisma, task.id, seam, seen)
  const reentry = calls.at(-1)
  assert.equal(reentry?.op, 'wake')
  assert.equal(reentry?.input.workId, parked.id)
  assert.equal(reentry?.input.reason, 'ticket_moved')
  assert.equal(calls.filter((call) => call.op === 'start').length, 0)
})

runDatabaseTest('a source event wakes live work only when the trigger opts in, and never picks up', async (t) => {
  const prisma = new PrismaClient()
  const followed = await seed(prisma, { includeSourceEvents: true })
  const unfollowed = await seed(prisma)
  t.after(async () => { await followed.cleanup(); await unfollowed.cleanup(); await prisma.$disconnect() })

  for (const s of [followed, unfollowed]) {
    const { calls, seam } = recordingSeam()
    const seen = new Set<string>()
    const synced = await applyInboundItem(prisma, sourceContext(s), sourceItem())
    assert.ok('taskId' in synced && synced.taskId)
    const taskId = synced.taskId
    await drain(prisma, taskId, seam, seen)

    // Upstream moves it into the start-work column: never a pickup.
    await applyInboundItem(prisma, sourceContext(s), sourceItem({
      stateId: 'doing', stateName: 'Doing', updatedAt: '2026-09-03T00:00:00.000Z',
    }))
    await drain(prisma, taskId, seam, seen)
    const intoPickup = await latestEvent(prisma, taskId, 'column_entered')
    assert.equal((await deliveryFor(prisma, s.triggerId, intoPickup.id))?.errorMessage, 'source_origin')
    assert.deepEqual(calls, [])

    // With work live, upstream moves it on: a followed `moved` change.
    const work = await liveWork(prisma, s, taskId, 'active')
    await applyInboundItem(prisma, sourceContext(s), sourceItem({
      stateId: 'review', stateName: 'Review', updatedAt: '2026-09-04T00:00:00.000Z',
    }))
    await drain(prisma, taskId, seam, seen)
    const onward = await latestEvent(prisma, taskId, 'column_entered')
    const delivery = await deliveryFor(prisma, s.triggerId, onward.id)
    if (s === followed) {
      assert.equal(delivery?.status, 'delivered')
      assert.equal(calls.length, 1)
      assert.equal(calls[0]?.input.workId, work.id)
      assert.equal(calls[0]?.input.reason, 'ticket_moved')
      // Its text reaches the agent marked untrusted.
      assert.equal(calls[0]?.input.untrusted, true)
      assert.equal((delivery?.payload as { untrusted?: boolean }).untrusted, true)
    } else {
      assert.equal(delivery?.status, 'skipped')
      assert.equal(delivery?.errorMessage, 'source_origin')
      assert.deepEqual(calls, [])
    }
  }
})

runDatabaseTest('a board editor\'s comment wakes live work; a non-editor\'s is recorded and wakes nothing', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const { calls, seam } = recordingSeam()
  const seen = new Set<string>()
  const task = await newTask(prisma, s)
  // The outsider reaches the ticket as its assignee, but is no project member.
  await assignProjectTask(prisma, {
    taskId: task.id, organizationId: s.organizationId, assigneeUserId: s.outsiderId,
    actorContext: s.actorContext, origin: SESSION,
  })
  const work = await liveWork(prisma, s, task.id, 'active')
  await drain(prisma, task.id, seam, seen)

  const comment = (userId: string) => createTaskComment(prisma, {
    organizationId: s.organizationId, userId, isOrganizationAdmin: false, origin: SESSION,
  }, { taskId: task.id, body: `From ${userId}` })
  assert.ok(!('error' in await comment(s.outsiderId)))
  await drain(prisma, task.id, seam, seen)
  const outsiderComment = await latestEvent(prisma, task.id, 'comment_added')
  assert.equal((await deliveryFor(prisma, s.triggerId, outsiderComment.id))?.errorMessage, 'not_board_editor')
  assert.deepEqual(calls, [])

  assert.ok(!('error' in await comment(s.editorId)))
  await drain(prisma, task.id, seam, seen)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.input.workId, work.id)
  assert.equal(calls[0]?.input.reason, 'ticket_commented')
  assert.equal(calls[0]?.input.untrusted, false)
})

runDatabaseTest('entering an end column sends one machine-less wake; the agent\'s own move sends none', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const { calls, seam } = recordingSeam()
  const seen = new Set<string>()

  const byPerson = await newTask(prisma, s)
  await liveWork(prisma, s, byPerson.id, 'active')
  await move(prisma, s, byPerson.id, s.columns.done, SESSION)
  await drain(prisma, byPerson.id, seam, seen)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.input.machineLess, true)
  assert.equal(calls[0]?.input.reason, 'ticket_moved')

  const byAgent = await newTask(prisma, s)
  await liveWork(prisma, s, byAgent.id, 'active')
  await moveProjectTaskToColumn(prisma, {
    taskId: byAgent.id, organizationId: s.organizationId, columnId: s.columns.done, actorId: s.editorId,
    agentId: s.agentId, unattended: true, origin: { kind: 'agent', agentId: s.agentId, runId: randomUUID() },
  })
  await drain(prisma, byAgent.id, seam, seen)
  const own = await latestEvent(prisma, byAgent.id, 'column_entered')
  assert.equal((await deliveryFor(prisma, s.triggerId, own.id))?.errorMessage, 'own_agent_event')
  assert.equal(calls.length, 1)
})

runDatabaseTest('an unbuilt work seam is a failed delivery, and a retry settles it', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const task = await newTask(prisma, s)
  await move(prisma, s, task.id, s.columns.inProgress, SESSION)
  const entered = await latestEvent(prisma, task.id, 'column_entered')

  // The worker's default seam: recorded, never silently dropped, never thrown.
  await dispatchTicketEvent(prisma, { organizationId: s.organizationId, taskEventId: entered.id })
  const failed = await deliveryFor(prisma, s.triggerId, entered.id)
  assert.equal(failed?.status, 'failed')
  assert.match(failed?.errorMessage ?? '', /startTicketWork is not implemented yet/)
  assert.ok(failed?.nextRetryAt, 'a failed start is retried')

  // The retry poller's arm decides the stored event again on the same row.
  const trigger = await prisma.agentTrigger.findUniqueOrThrow({ where: { id: s.triggerId } })
  await reattemptTriggerDelivery(prisma, {
    dedupeKey: failed!.dedupeKey ?? undefined,
    payload: failed!.payload,
    reuseDeliveryId: failed!.id,
    retryCount: failed!.retryCount,
    source: failed!.source ?? 'pickup',
    triggerId: trigger.id,
    type: trigger.type,
  })
  // Still the unbuilt seam in the poller's wiring, so it fails again, in place.
  const retried = await deliveryFor(prisma, s.triggerId, entered.id)
  assert.equal(retried?.id, failed?.id)
  assert.equal(retried?.status, 'failed')
  assert.equal(retried?.retryCount, (failed?.retryCount ?? 0) + 1)

  // Once the seam can start work, the same row is delivered.
  const { calls, seam } = recordingSeam()
  await reattemptTicketTriggerDelivery(prisma, {
    organizationId: s.organizationId,
    payload: retried!.payload,
    retryCount: retried!.retryCount,
    reuseDeliveryId: retried!.id,
    triggerId: trigger.id,
  }, { seam })
  const settled = await deliveryFor(prisma, s.triggerId, entered.id)
  assert.equal(settled?.id, failed?.id)
  assert.equal(settled?.status, 'delivered')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.op, 'start')
})
