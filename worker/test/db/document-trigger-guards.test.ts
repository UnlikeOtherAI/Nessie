import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import {
  DOCUMENT_TRIGGER_PAGE_WAKES_PER_DAY,
  documentTriggerDeliveryKey,
  documentTriggerPendingKey,
  TRIGGER_DOCUMENT_DISPATCH_TOPIC,
  TriggerDocumentDispatchJobPayloadSchema,
} from '@nessie/schemas'
import { documentTriggerOnVersionCreated } from '@nessie/team-admin'

import { dispatchDocumentChange } from '../../src/control/document-trigger-dispatch.js'
import { createTicketWorkSeam } from '../../src/control/ticket-work.js'
import type { TicketWorkSeam } from '../../src/control/ticket-work-seam.js'
import { createWorkerKnowledgeProvider } from '../../src/run/pa-tools/knowledge-provider.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { runDatabaseTest } from './support.js'
import { agentScope, documentDeliveries, drainDocumentJobs, seedDocumentTrigger } from './document-trigger-fixture.js'
import { drainTicketJobs, finishRuns, move, newTask, seedTicketWork, type TicketWorkSeed } from './ticket-work-fixture.js'

// The guards around a document trigger's review, against Postgres
// (docs/standards/document-triggers.md): a save that joined a window is seen
// by it however the commit and the job interleave, and one that lands while
// the window is decided opens the next; a label filter sees the labels a save
// leaves; an agent's publish opens a publish window; one narrower page is
// skipped without pausing the trigger; no two reviewers can wake each other,
// in any project; a page wakes its agent at most so often a day; route 1
// still asks the document trigger's own channel; and a document edit that
// wakes ticket work answers no open question.

const windowJobs = (prisma: PrismaClient, triggerId: string) => prisma.queueJob.findMany({
  where: { topic: TRIGGER_DOCUMENT_DISPATCH_TOPIC, payload: { path: ['triggerId'], equals: triggerId } },
  orderBy: { enqueuedAt: 'asc' },
})

const openWindows = async (prisma: PrismaClient, triggerId: string) =>
  (await windowJobs(prisma, triggerId)).filter((row) => row.idempotencyKey !== null)

/** A ticket in progress with its live work for the seed's agent, its first run finished. */
const liveWork = async (prisma: PrismaClient, s: TicketWorkSeed) => {
  const task = await newTask(prisma, s)
  await move(prisma, s, task.id, s.columns.inProgress)
  await drainTicketJobs(prisma, s, new Set())
  const work = await prisma.agentTicketWork.findFirstOrThrow({ where: { triggerId: s.triggerId, taskId: task.id } })
  await finishRuns(prisma, work.threadId)
  return { task, work }
}

runDatabaseTest('a save that joined the window but commits after the job started is still what the job reads', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const d = await seedDocumentTrigger(prisma, s)
  const page = await d.provider.createPage({ ...d.scope, body: '<p>v1</p>', title: 'Spec' })
  assert.equal((await openWindows(prisma, d.documentTriggerId)).length, 1)

  // A save joins the open window, and is slow to commit.
  let joined!: () => void
  let commit!: () => void
  const hasJoined = new Promise<void>((resolve) => { joined = resolve })
  const mayCommit = new Promise<void>((resolve) => { commit = resolve })
  const saving = prisma.$transaction(async (tx) => {
    const version = await tx.knowledgePageVersion.create({
      data: { pageId: page.id, versionNumber: 2, body: '<p>v2</p>', authorType: 'user', authorId: s.editorId },
    })
    await documentTriggerOnVersionCreated(tx, {
      organizationId: s.organizationId, projectId: s.projectId, spaceId: d.spaceId, pageId: page.id,
      kind: 'document', versionId: version.id, versionNumber: 2, authorType: 'user', authorId: s.editorId,
      origin: 'user_authored',
    })
    joined()
    await mayCommit
  }, { timeout: 30_000 })
  await hasJoined

  // The window ends while that save is still open: the job waits for it.
  let handled = false
  const handling = dispatchDocumentChange(prisma, { organizationId: s.organizationId, pageId: page.id, triggerId: d.documentTriggerId })
    .then(() => { handled = true })
  await new Promise((resolve) => setTimeout(resolve, 800))
  const waited = !handled
  commit()
  await saving
  await handling
  assert.ok(waited, 'the job waits for the save that joined its window')

  const deliveries = await documentDeliveries(prisma, d.documentTriggerId)
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0]?.parsed.toVersionNumber, 2, 'the review covers the save that joined the window')
  assert.equal(deliveries[0]?.parsed.versionsCoalesced, 2)
  assert.equal((await openWindows(prisma, d.documentTriggerId)).length, 0, 'and nothing is left over for a next window')
})

runDatabaseTest('a save that lands while a window is being decided opens the next window', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const d = await seedDocumentTrigger(prisma, s)
  const { task } = await liveWork(prisma, s)
  const page = await d.provider.createPage({ ...d.scope, body: '<p>v1</p>', taskId: task.id, title: 'Spec' })
  const [job] = await openWindows(prisma, d.documentTriggerId)
  // A version that commits after this window read the page — mid-route — and
  // announced no window of its own.
  const real = createTicketWorkSeam(prisma)
  const seam: TicketWorkSeam = {
    ...real,
    wakeTicketWork: async (tx, input) => {
      await prisma.knowledgePageVersion.create({
        data: { pageId: page.id, versionNumber: 2, body: '<p>v2</p>', authorType: 'user', authorId: s.editorId },
      })
      return real.wakeTicketWork(tx, input)
    },
  }
  await dispatchDocumentChange(prisma, TriggerDocumentDispatchJobPayloadSchema.parse(job!.payload), { seam })
  const [first] = await documentDeliveries(prisma, d.documentTriggerId)
  assert.equal(first?.parsed.toVersionNumber, 1, 'the window decided what it read')
  const next = await openWindows(prisma, d.documentTriggerId)
  assert.deepEqual(next.map((row) => row.idempotencyKey), [documentTriggerPendingKey(d.documentTriggerId, page.id)],
    'the save it did not read opens the next window')
  assert.ok(next[0]!.enqueuedAt.getTime() > Date.now() + 150_000, 'a whole quiet window long')

  await dispatchDocumentChange(prisma, TriggerDocumentDispatchJobPayloadSchema.parse(next[0]!.payload))
  const second = (await documentDeliveries(prisma, d.documentTriggerId)).at(-1)
  assert.deepEqual([second?.status, second?.parsed.toVersionNumber], ['delivered', 2])
  assert.equal((await openWindows(prisma, d.documentTriggerId)).length, 0, 'and it opens no window after itself')
})

runDatabaseTest('a label-filtered trigger sees a page created with its label, and one given it later', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const d = await seedDocumentTrigger(prisma, s, { labels: ['spec'] })
  const labelled = await d.provider.createPage({ ...d.scope, body: '<p>Spec</p>', labels: ['Spec'], title: 'Spec' })
  const notes = await d.provider.createPage({ ...d.scope, body: '<p>Notes</p>', title: 'Notes' })
  const pending = (pageId: string) => documentTriggerPendingKey(d.documentTriggerId, pageId)
  assert.deepEqual((await openWindows(prisma, d.documentTriggerId)).map((row) => row.idempotencyKey), [pending(labelled.id)],
    'created with the label: its window opens; without it: none')
  await d.provider.updatePage(notes.id, { ...d.scope, labels: ['spec'] })
  assert.deepEqual((await openWindows(prisma, d.documentTriggerId)).map((row) => row.idempotencyKey).sort(),
    [pending(labelled.id), pending(notes.id)].sort(), 'given the label: its window opens')
  await drainDocumentJobs(prisma, s, new Set())
  const statuses = (await documentDeliveries(prisma, d.documentTriggerId)).map((row) => row.status)
  assert.deepEqual(statuses, ['delivered', 'delivered'])
})

runDatabaseTest('an agent\'s publish opens a publish-firing trigger\'s window, as a person\'s does', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const d = await seedDocumentTrigger(prisma, s, { fireOn: 'publish' })
  // The provider every worker document tool writes through.
  const tools = createWorkerKnowledgeProvider({
    prisma,
    agentId: s.agentId,
    run: { id: randomUUID(), originatingUserId: s.editorId },
    actorContext: {
      actor: { actorId: s.agentId, actorType: 'agent' },
      actionContext: { correlationId: randomUUID(), requestId: randomUUID() },
      tenant: { organizationId: s.organizationId, teamId: s.teamId },
    },
  } as unknown as BuiltinToolRuntimeContext)
  const page = await tools.createPage({ ...agentScope(s, d), body: '<p>Draft</p>', title: 'Spec' })
  assert.equal((await openWindows(prisma, d.documentTriggerId)).length, 0, 'a draft opens no publish window')
  await tools.publishPage({ organizationId: s.organizationId, pageId: page.id })
  assert.deepEqual((await openWindows(prisma, d.documentTriggerId)).map((row) => row.idempotencyKey),
    [documentTriggerPendingKey(d.documentTriggerId, page.id)])
})

runDatabaseTest('one restricted page is skipped with its reason; the trigger keeps watching the rest', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const d = await seedDocumentTrigger(prisma, s)
  const seen = new Set<string>()
  const other = await prisma.agent.create({ data: { name: 'Someone else', organizationId: s.organizationId } })
  const payroll = await d.provider.createPage({ ...d.scope, body: '<p>Pay</p>', title: 'Payroll', sensitivityTier: 'restricted' })
  const notes = await d.provider.createPage({ ...d.scope, body: '<p>Notes</p>', title: 'Notes', privateToAgentId: other.id })
  const spec = await d.provider.createPage({ ...d.scope, body: '<p>Spec</p>', title: 'Spec' })
  await drainDocumentJobs(prisma, s, seen)
  const byPage = new Map((await documentDeliveries(prisma, d.documentTriggerId)).map((row) => [row.parsed.pageId, row]))
  for (const narrow of [payroll, notes]) {
    assert.deepEqual([byPage.get(narrow.id)?.status, byPage.get(narrow.id)?.errorMessage], ['skipped', 'page_not_readable'])
  }
  assert.equal(byPage.get(spec.id)?.status, 'delivered', 'the other page is still reviewed')
  const trigger = await prisma.agentTrigger.findUniqueOrThrow({ where: { id: d.documentTriggerId } })
  assert.deepEqual([trigger.enabled, trigger.status, trigger.healthReason], [true, 'active', null], 'not paused')
})

runDatabaseTest('no two reviewers wake each other, in any project, nor a save made during a review', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const d = await seedDocumentTrigger(prisma, s, { includeAgentEdits: true })
  const seen = new Set<string>()
  const page = await d.provider.createPage({ ...d.scope, body: '<p>Spec</p>', title: 'Spec' })
  await drainDocumentJobs(prisma, s, seen)

  // B reviews another project's documents with agent edits included: its save here never counts.
  const other = await prisma.project.create({ data: { name: `Other ${randomUUID()}`, organizationId: s.organizationId } })
  const reviewer = await prisma.agent.create({ data: { name: 'Reviewer B', organizationId: s.organizationId } })
  await prisma.agentTrigger.create({
    data: {
      agentId: reviewer.id, type: 'document_changed', scopeProjectId: other.id,
      config: { spaceId: randomUUID(), includeAgentEdits: true, instructions: { general: 'Review.' } },
    },
  })
  await d.provider.updatePage(page.id, { ...agentScope(s, d, reviewer.id), body: '<p>Spec, by B</p>' })
  await drainDocumentJobs(prisma, s, seen)
  assert.equal((await documentDeliveries(prisma, d.documentTriggerId)).at(-1)?.errorMessage, 'agent_edits_only',
    'a reviewer of another project is a reviewer')

  // C's document trigger was switched off, but a run it started is still live: a save from it never counts.
  const helper = await prisma.agent.create({ data: { name: 'Helper C', organizationId: s.organizationId } })
  const helperTrigger = await prisma.agentTrigger.create({
    data: {
      agentId: helper.id, type: 'document_changed', scopeProjectId: other.id, enabled: false,
      config: { spaceId: randomUUID(), instructions: { general: 'Review.' } },
    },
  })
  const thread = await prisma.thread.create({ data: { agentId: helper.id, channelId: s.channelId } })
  const run = await prisma.run.create({
    data: { agentId: helper.id, threadId: thread.id, triggerId: helperTrigger.id, status: 'running' },
  })
  await d.provider.updatePage(page.id, { ...agentScope(s, d, helper.id), body: '<p>Spec, by C in a review</p>' })
  await drainDocumentJobs(prisma, s, seen)
  assert.equal((await documentDeliveries(prisma, d.documentTriggerId)).at(-1)?.errorMessage, 'agent_edits_only',
    'a save made during a document review never counts')

  // Once that run is over, C's own save counts, because the trigger includes agent edits.
  await prisma.run.update({ where: { id: run.id }, data: { status: 'completed', finishedAt: new Date(Date.now() - 60_000) } })
  await d.provider.updatePage(page.id, { ...agentScope(s, d, helper.id), body: '<p>Spec, by C alone</p>' })
  await drainDocumentJobs(prisma, s, seen)
  const last = (await documentDeliveries(prisma, d.documentTriggerId)).at(-1)
  assert.equal(last?.status, 'delivered')
  assert.deepEqual(last?.parsed.authorKinds, ['agent'])
})

runDatabaseTest('a page wakes its agent at most so often a day, and the change stays owed', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const d = await seedDocumentTrigger(prisma, s)
  const seen = new Set<string>()
  const page = await d.provider.createPage({ ...d.scope, body: '<p>v1</p>', title: 'Spec' })
  // The day's wakes already used, as delivered rows of earlier windows.
  const used = Array.from({ length: DOCUMENT_TRIGGER_PAGE_WAKES_PER_DAY }, () =>
    documentTriggerDeliveryKey(d.documentTriggerId, page.id, randomUUID()))
  await prisma.agentTriggerDelivery.createMany({
    data: used.map((dedupeKey) => ({
      triggerId: d.documentTriggerId, dedupeKey, source: 'document', status: 'delivered' as const, deliveredAt: new Date(),
    })),
  })
  await drainDocumentJobs(prisma, s, seen)
  const skip = await prisma.agentTriggerDelivery.findFirstOrThrow({ where: { triggerId: d.documentTriggerId, status: 'skipped' } })
  assert.equal(skip.errorMessage, 'wake_limit')
  assert.equal(await prisma.run.count({ where: { triggerId: d.documentTriggerId } }), 0, 'nobody was woken')

  // A day later the next save brings the agent up through both versions.
  await prisma.agentTriggerDelivery.updateMany({
    where: { dedupeKey: { in: used } }, data: { deliveredAt: new Date(Date.now() - 25 * 60 * 60 * 1_000) },
  })
  await d.provider.updatePage(page.id, { ...d.scope, body: '<p>v2</p>' })
  await drainDocumentJobs(prisma, s, seen)
  const woke = await prisma.agentTriggerDelivery.findFirstOrThrow({
    where: { triggerId: d.documentTriggerId, status: 'delivered', dedupeKey: { notIn: used } },
  })
  assert.equal((woke.payload as { versionsCoalesced?: number }).versionsCoalesced, 2, 'the skipped window is still owed')
})

runDatabaseTest('a ticket\'s document still needs the document trigger\'s own channel, and pauses it when lost', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const reviews = await prisma.channel.create({
    data: {
      label: 'reviews', slug: `reviews-${randomUUID()}`, organization: { connect: { id: s.organizationId } },
      project: { connect: { id: s.projectId } }, team: { connect: { id: s.teamId } },
    },
  })
  await prisma.agentBinding.create({ data: { agentId: s.agentId, channelId: reviews.id } })
  const d = await seedDocumentTrigger(prisma, s, {}, { targetChannelId: reviews.id })
  const { task, work } = await liveWork(prisma, s)
  const before = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
  // The agent leaves the document trigger's channel, but stays in the ticket trigger's.
  await prisma.agentBinding.deleteMany({ where: { agentId: s.agentId, channelId: reviews.id } })
  await d.provider.createPage({ ...d.scope, body: '<p>Spec</p>', taskId: task.id, title: 'Spec' })
  await drainDocumentJobs(prisma, s, new Set())
  const trigger = await prisma.agentTrigger.findUniqueOrThrow({ where: { id: d.documentTriggerId } })
  assert.deepEqual([trigger.enabled, trigger.healthReason], [false, 'agent_channel_access_lost'])
  const after = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
  assert.equal(after.wakeCount, before.wakeCount, 'the ticket\'s work was not woken through a trigger that lost its channel')
})

runDatabaseTest('a document edit wakes the ticket\'s work but answers no open question', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const d = await seedDocumentTrigger(prisma, s)
  const { task, work } = await liveWork(prisma, s)
  // The agent asked on the ticket and waits for a person (ticket-work-reminders.md).
  const asked = new Date()
  await prisma.agentTicketWork.update({ where: { id: work.id }, data: { awaitingAnswerAt: asked } })
  await d.provider.createPage({ ...d.scope, body: '<p>Spec</p>', taskId: task.id, title: 'Spec' })
  await drainDocumentJobs(prisma, s, new Set())
  const [delivery] = await documentDeliveries(prisma, d.documentTriggerId)
  assert.deepEqual([delivery?.status, delivery?.parsed.outcome], ['delivered', 'ticket_work'])
  const after = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
  assert.equal(after.wakeCount, work.wakeCount + 1, 'the edit woke the work')
  assert.equal(after.awaitingAnswerAt?.getTime(), asked.getTime(), 'a spec edit is not the answer the agent waits for')
})
