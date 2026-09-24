import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient } from '@prisma/client'
import {
  AuthorizedActionContextSchema,
  DocumentTriggerThreadMetadataSchema,
  RunExecuteJobPayloadSchema,
  TICKET_WORK_LIVE_STATUSES,
  TicketWorkThreadEventSchema,
} from '@nessie/schemas'

import { runDatabaseTest } from './support.js'
import {
  agentScope,
  documentDeliveries,
  drainDocumentJobs,
  seedDocumentTrigger,
  versionIds,
} from './document-trigger-fixture.js'
import { drainTicketJobs, finishRuns, move, newTask, seedTicketWork } from './ticket-work-fixture.js'

// A document trigger against Postgres, driven only through the real writers
// and the worker's own dispatch job (docs/standards/document-triggers.md): a
// quiet window coalesces saves into one review, the agent's own saves never
// wake it, a ticket's document reaches that ticket's live work for the same
// agent, anything else is reviewed in the page's own thread, and lost access
// pauses the trigger with a health reason.

const threadRows = async (prisma: PrismaClient, threadId: string) =>
  (await prisma.message.findMany({ where: { threadId, role: 'system' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))
    .flatMap((message) => {
      const metadata = message.metadata as Record<string, unknown> | null
      const parsed = TicketWorkThreadEventSchema.safeParse(metadata?.ticketWorkEvent)
      return parsed.success ? [{ ...parsed.data, content: message.content }] : []
    })

const kickoffOf = async (prisma: PrismaClient, runId: string) => {
  const run = await prisma.run.findUniqueOrThrow({ where: { id: runId }, select: { triggerMessageId: true } })
  return prisma.message.findUniqueOrThrow({ where: { id: run.triggerMessageId! } })
}

const runJobFor = async (prisma: PrismaClient, runId: string) => {
  const job = await prisma.queueJob.findFirstOrThrow({
    where: { topic: 'run.execute', payload: { path: ['runId'], equals: runId } },
  })
  return RunExecuteJobPayloadSchema.parse(job.payload)
}

runDatabaseTest('saves in one quiet window are one review in the page\'s own thread, with no document text in it', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const d = await seedDocumentTrigger(prisma, s, { folderPageId: undefined })
  const seen = new Set<string>()

  const page = await d.provider.createPage({ ...d.scope, body: '<p>Login keeps the redirect target.</p>', parentPageId: d.specsId, title: 'Login spec' })
  await d.provider.updatePage(page.id, { ...d.scope, body: '<p>Login keeps the redirect target and the locale.</p>' })
  await d.provider.updatePage(page.id, { ...d.scope, body: '<p>Login SECRET-PHRASE keeps the redirect target and the locale.</p>' })
  // Three saves, one window: one job, keyed by the window.
  const jobs = await prisma.queueJob.findMany({
    where: { topic: 'trigger.document.dispatch', payload: { path: ['triggerId'], equals: d.documentTriggerId } },
  })
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0]!.idempotencyKey, `doc:${d.documentTriggerId}:${page.id}:pending`)
  assert.ok(jobs[0]!.enqueuedAt.getTime() > Date.now() + 150_000, 'delayed by the default 180 s quiet window')

  assert.equal(await drainDocumentJobs(prisma, s, seen), 1)
  const [delivery] = await documentDeliveries(prisma, d.documentTriggerId)
  const [v1, , v3] = await versionIds(prisma, page.id)
  assert.equal(delivery?.status, 'delivered')
  assert.equal(delivery?.dedupeKey, `doc:${d.documentTriggerId}:${page.id}:${v3}`)
  assert.equal(delivery?.parsed.outcome, 'page_thread')
  assert.equal(delivery?.parsed.versionsCoalesced, 3)
  assert.equal(delivery?.parsed.fromVersionId, null, 'a page created after the trigger starts from nothing')
  assert.deepEqual(delivery?.parsed.authorKinds, ['person'])
  assert.doesNotMatch(JSON.stringify(delivery?.payload), /SECRET-PHRASE|Login spec/, 'the payload is metadata only')

  // One thread per (trigger, page), titled for the page, never General.
  const thread = await prisma.thread.findUniqueOrThrow({ where: { id: delivery!.parsed.threadId! } })
  assert.deepEqual(
    DocumentTriggerThreadMetadataSchema.parse(thread.metadata),
    { pageId: page.id, triggerId: d.documentTriggerId },
  )
  assert.equal(thread.channelId, s.channelId)
  assert.equal(thread.agentId, s.agentId)
  assert.equal(thread.title, 'Review: Login spec', 'every reader of the channel may read the page, so its title is said')
  const rows = await threadRows(prisma, thread.id)
  assert.deepEqual(rows.map((row) => row.kind), ['document_woken'])
  assert.match(rows[0]!.content, /^Woken: a person edited the document "Login spec" \(v3, its first version you are told of\)$/)

  // The run acts as the agent, with nobody behind it.
  const run = await prisma.run.findFirstOrThrow({ where: { threadId: thread.id } })
  const job = await runJobFor(prisma, run.id)
  const actor = AuthorizedActionContextSchema.parse(job.actorContext)
  assert.equal(actor.actor.actorType, 'agent')
  assert.equal(actor.actionContext.effectiveUserId, undefined)
  assert.equal(actor.actionContext.purpose, 'document_changed')
  assert.equal(run.triggerId, d.documentTriggerId)
  const kickoff = await kickoffOf(prisma, run.id)
  assert.equal(kickoff.role, 'system')
  assert.match(kickoff.content, new RegExp(`kb_page_read\\(pageId="${page.id}", versionId="${v3}"\\)`))
  assert.match(kickoff.content, /## Instructions\nReview the edit and say what changed in the thread\./)
  assert.doesNotMatch(kickoff.content, /SECRET-PHRASE|redirect target/, 'the kickoff never carries the document')

  // The window's key was released: the next save opens the next window, and
  // its review diffs from the version the last one brought the agent up to.
  await finishRuns(prisma, thread.id)
  await d.provider.updatePage(page.id, { ...d.scope, body: '<p>Login keeps only the locale.</p>' })
  assert.equal(await drainDocumentJobs(prisma, s, seen), 1)
  const second = (await documentDeliveries(prisma, d.documentTriggerId))[1]
  const v4 = (await versionIds(prisma, page.id))[3]
  assert.equal(second?.parsed.fromVersionId, v3)
  assert.equal(second?.parsed.toVersionId, v4)
  assert.equal(second?.parsed.threadId, thread.id, 'the page keeps its one thread')
  const secondRun = await prisma.run.findFirstOrThrow({ where: { threadId: thread.id, id: { not: run.id } } })
  assert.match((await kickoffOf(prisma, secondRun.id)).content,
    new RegExp(`kb_page_diff\\(pageId="${page.id}", fromVersionId="${v3}", toVersionId="${v4}"\\)`))
  assert.ok(v1)
})

runDatabaseTest('the agent\'s own saves never wake it, and move the marker past them', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const d = await seedDocumentTrigger(prisma, s)
  const seen = new Set<string>()
  const page = await d.provider.createPage({ ...agentScope(s, d), body: '<p>Draft by the agent.</p>', title: 'Agent notes' })
  assert.equal(await drainDocumentJobs(prisma, s, seen), 1)
  const [own] = await documentDeliveries(prisma, d.documentTriggerId)
  assert.equal(own?.status, 'skipped')
  assert.equal(own?.errorMessage, 'agent_edits_only')
  assert.equal(await prisma.run.count({ where: { triggerId: d.documentTriggerId } }), 0, 'no run, so no loop')

  // Another agent's save counts only with includeAgentEdits.
  const other = await prisma.agent.create({ data: { name: 'Other', organizationId: s.organizationId } })
  await d.provider.updatePage(page.id, { ...agentScope(s, d, other.id), body: '<p>Another agent edited.</p>' })
  await drainDocumentJobs(prisma, s, seen)
  assert.equal((await documentDeliveries(prisma, d.documentTriggerId))[1]?.errorMessage, 'agent_edits_only')

  // A person's save wakes it, diffing from the agents' last version.
  await d.provider.updatePage(page.id, { ...d.scope, body: '<p>A person edited.</p>' })
  await drainDocumentJobs(prisma, s, seen)
  const [, v2, v3] = await versionIds(prisma, page.id)
  const woke = (await documentDeliveries(prisma, d.documentTriggerId))[2]
  assert.equal(woke?.status, 'delivered')
  assert.equal(woke?.parsed.fromVersionId, v2)
  assert.equal(woke?.parsed.toVersionId, v3)
  assert.equal(woke?.parsed.versionsCoalesced, 1)
})

runDatabaseTest('a ticket\'s document reaches that ticket\'s live work for the same agent, in its work thread', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const d = await seedDocumentTrigger(prisma, s)
  const ticketSeen = new Set<string>()
  const seen = new Set<string>()
  const task = await newTask(prisma, s)
  await move(prisma, s, task.id, s.columns.inProgress)
  await drainTicketJobs(prisma, s, ticketSeen)
  const work = await prisma.agentTicketWork.findFirstOrThrow({ where: { triggerId: s.triggerId, taskId: task.id } })
  await finishRuns(prisma, work.threadId)

  const page = await d.provider.createPage({ ...d.scope, body: '<p>Spec v1 PRIVATE-WORDING.</p>', taskId: task.id, title: 'Login spec' })
  assert.equal(await drainDocumentJobs(prisma, s, seen), 1)
  const [delivery] = await documentDeliveries(prisma, d.documentTriggerId)
  assert.equal(delivery?.parsed.outcome, 'ticket_work')
  assert.equal(delivery?.parsed.workId, work.id)
  assert.equal(delivery?.parsed.threadId, work.threadId)
  assert.equal(delivery?.parsed.taskId, task.id)
  const after = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
  assert.equal(after.lastWakeReason, 'document_changed')
  assert.equal(after.wakeCount, 2, 'the pickup, then this wake')
  const rows = await threadRows(prisma, work.threadId)
  assert.equal(rows.at(-1)?.kind, 'woken')
  assert.equal(rows.at(-1)?.reason, 'document_changed')
  assert.equal(await prisma.thread.count({ where: { metadata: { path: ['pageId'], equals: page.id } } }), 0,
    'no page thread: the change went to the ticket')
  const run = await prisma.run.findFirstOrThrow({ where: { threadId: work.threadId }, orderBy: { createdAt: 'desc' } })
  const kickoff = await kickoffOf(prisma, run.id)
  assert.match(kickoff.content, /^## Why you were woken\ndocument_changed: a person saved 1 version of "Login spec"/)
  assert.match(kickoff.content, /What this document trigger asks of you: Review the edit/)
  assert.doesNotMatch(kickoff.content, /PRIVATE-WORDING/)
  // The ticket's own state block now promises document edits.
  assert.match(kickoff.content, /edits one of its documents that your document trigger watches/,
    'promised as far as the trigger watches, never for every document of the ticket')
})

runDatabaseTest('a ticket document with no live work is reviewed in its own thread, naming the ticket', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const d = await seedDocumentTrigger(prisma, s)
  const seen = new Set<string>()
  const task = await newTask(prisma, s, { title: 'Checkout flow' })
  await d.provider.createPage({ ...d.scope, body: '<p>Spec.</p>', taskId: task.id, title: 'Checkout spec' })
  await drainDocumentJobs(prisma, s, seen)
  const [delivery] = await documentDeliveries(prisma, d.documentTriggerId)
  assert.equal(delivery?.parsed.outcome, 'page_thread')
  const run = await prisma.run.findFirstOrThrow({ where: { threadId: delivery!.parsed.threadId! } })
  const kickoff = await kickoffOf(prisma, run.id)
  assert.match(kickoff.content, new RegExp(`It is a document of the ticket "Checkout flow" \\(ticketId=${task.id};`))
  assert.match(kickoff.content, /because you have no live work on that ticket \(it was never picked up\)/)
})

runDatabaseTest('on a board with two ticket triggers, only the document trigger\'s own agent\'s work is woken', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const d = await seedDocumentTrigger(prisma, s)
  const seen = new Set<string>()
  const task = await newTask(prisma, s)
  await move(prisma, s, task.id, s.columns.inProgress)
  await drainTicketJobs(prisma, s, new Set())
  const mine = await prisma.agentTicketWork.findFirstOrThrow({ where: { triggerId: s.triggerId, taskId: task.id } })
  await finishRuns(prisma, mine.threadId)
  // A second agent's ticket trigger on the same board, with live work on the same ticket.
  const reviewer = await prisma.agent.create({ data: { name: 'Reviewer', organizationId: s.organizationId } })
  await prisma.agentBinding.create({ data: { agentId: reviewer.id, channelId: s.channelId } })
  const theirs = await prisma.agentTrigger.create({
    data: {
      agentId: reviewer.id, type: 'ticket_changed', targetChannelId: s.channelId,
      scopeProjectId: s.projectId, scopeBoardId: s.boardId,
      config: { boardId: s.boardId, pickup: { columnIds: [s.columns.review], assignOnPickup: false }, follow: {} },
    },
  })
  const theirThread = await prisma.thread.create({ data: { agentId: reviewer.id, channelId: s.channelId, title: 'Theirs' } })
  const theirWork = await prisma.agentTicketWork.create({
    data: {
      organizationId: s.organizationId, triggerId: theirs.id, agentId: reviewer.id, taskId: task.id,
      projectId: s.projectId, threadId: theirThread.id, status: 'active', wakeCount: 1,
    },
  })
  await d.provider.createPage({ ...d.scope, body: '<p>Spec.</p>', taskId: task.id, title: 'Spec' })
  await drainDocumentJobs(prisma, s, seen)
  const [delivery] = await documentDeliveries(prisma, d.documentTriggerId)
  assert.equal(delivery?.parsed.workId, mine.id)
  assert.equal((await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: theirWork.id } })).wakeCount, 1,
    'the other agent\'s work is not woken')
  assert.equal(await prisma.message.count({ where: { threadId: theirThread.id } }), 0)
  assert.ok((TICKET_WORK_LIVE_STATUSES as readonly string[]).includes(theirWork.status))
})

runDatabaseTest('an agent that lost the space pauses its trigger with a health reason, and wakes nobody', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const d = await seedDocumentTrigger(prisma, s)
  const seen = new Set<string>()
  const page = await d.provider.createPage({ ...d.scope, body: '<p>Spec.</p>', title: 'Spec' })
  // The space narrows to its members: the channel's readers can no longer read it.
  await prisma.knowledgeSpace.update({ where: { id: d.spaceId }, data: { visibility: 'private' } })
  await drainDocumentJobs(prisma, s, seen)
  const [delivery] = await documentDeliveries(prisma, d.documentTriggerId)
  assert.equal(delivery?.status, 'skipped')
  assert.equal(delivery?.errorMessage, 'access_lost')
  const trigger = await prisma.agentTrigger.findUniqueOrThrow({ where: { id: d.documentTriggerId } })
  assert.equal(trigger.enabled, false)
  assert.equal(trigger.status, 'error')
  assert.equal(trigger.healthReason, 'document_trigger_access_lost')
  assert.match(trigger.healthDetail ?? '', /Private notes|private/)
  assert.equal(await prisma.run.count({ where: { triggerId: d.documentTriggerId } }), 0)
  // A paused trigger opens no window for the next save.
  await d.provider.updatePage(page.id, { ...d.scope, body: '<p>Spec 2.</p>' })
  assert.equal(await drainDocumentJobs(prisma, s, seen), 0)
  const alert = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT count(*)::bigint AS count FROM queue_jobs
     WHERE topic = 'trigger.health-alert' AND payload->>'triggerId' = ${d.documentTriggerId}`)
  assert.equal(Number(alert[0]!.count), 1, 'the owner is told once')
  assert.ok(randomUUID())
})

runDatabaseTest('with includeAgentEdits another agent\'s save wakes it, but never another reviewer\'s', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const d = await seedDocumentTrigger(prisma, s, { includeAgentEdits: true })
  const seen = new Set<string>()
  const page = await d.provider.createPage({ ...d.scope, body: '<p>Spec.</p>', title: 'Spec' })
  await drainDocumentJobs(prisma, s, seen)
  const helper = await prisma.agent.create({ data: { name: 'Helper', organizationId: s.organizationId } })
  await d.provider.updatePage(page.id, { ...agentScope(s, d, helper.id), body: '<p>Spec, tidied.</p>' })
  await drainDocumentJobs(prisma, s, seen)
  const woke = (await documentDeliveries(prisma, d.documentTriggerId))[1]
  assert.equal(woke?.status, 'delivered', 'an ordinary agent\'s save counts when agent edits are included')
  assert.deepEqual(woke?.parsed.authorKinds, ['agent'])

  // The helper reviews this project's documents too: its saves no longer wake
  // this agent, so two reviewers can never wake each other in a loop. It is
  // bound to the channel its trigger posts in, as a real reviewer is: its own
  // trigger's window closes on the same save, and one that lost its channel
  // or space would pause itself first — and a paused trigger's agent is no
  // longer a reviewer.
  await prisma.agentBinding.create({ data: { agentId: helper.id, channelId: s.channelId } })
  const fellow = await prisma.agentTrigger.create({
    data: {
      agentId: helper.id, type: 'document_changed', targetChannelId: s.channelId, scopeProjectId: s.projectId,
      config: { spaceId: d.spaceId, includeAgentEdits: true, instructions: { general: 'Review too.' } },
    },
  })
  await d.provider.updatePage(page.id, { ...agentScope(s, d, helper.id), body: '<p>Spec, tidied again.</p>' })
  await drainDocumentJobs(prisma, s, seen)
  const mine = (await documentDeliveries(prisma, d.documentTriggerId))
  assert.equal(mine.at(-1)?.errorMessage, 'agent_edits_only')
  assert.equal((await prisma.agentTrigger.findUniqueOrThrow({ where: { id: fellow.id } })).enabled, true,
    'the fellow reviewer\'s own trigger stayed on through the same save')
})
