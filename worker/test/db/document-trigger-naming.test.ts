import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { TicketWorkThreadEventSchema } from '@nessie/schemas'

import { runDatabaseTest } from './support.js'
import { documentDeliveries, drainDocumentJobs, seedDocumentTrigger } from './document-trigger-fixture.js'
import { finishRuns, seedTicketWork, type TicketWorkSeed } from './ticket-work-fixture.js'

// When a document may be named where its review is heard
// (docs/standards/document-triggers.md → "What a wake says"): only when every
// reader of the target channel may read the page. Otherwise the review
// thread's title, the kickoff and the thread's row all name it by its id —
// a version written from a narrower basis, or a page private to the agent
// itself, is still reviewed, but its title is never said in the channel.

type Seen = { title: string | null; kickoff: string; row: string; job: string }

/** The newest review of the page, as the channel and the agent see it. */
const newestReview = async (prisma: PrismaClient, triggerId: string): Promise<Seen> => {
  const delivery = (await documentDeliveries(prisma, triggerId)).at(-1)
  assert.equal(delivery?.status, 'delivered')
  const threadId = delivery!.parsed.threadId!
  const thread = await prisma.thread.findUniqueOrThrow({ where: { id: threadId } })
  const run = await prisma.run.findFirstOrThrow({ where: { threadId, triggerDeliveryId: delivery!.id } })
  const kickoff = await prisma.message.findUniqueOrThrow({ where: { id: run.triggerMessageId! } })
  const rows = (await prisma.message.findMany({ where: { threadId, role: 'system' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))
    .filter((message) => TicketWorkThreadEventSchema.safeParse((message.metadata as Record<string, unknown> | null)
      ?.ticketWorkEvent).success)
  const job = await prisma.queueJob.findFirstOrThrow({ where: { topic: 'run.execute', payload: { path: ['runId'], equals: run.id } } })
  await finishRuns(prisma, threadId)
  return { title: thread.title, kickoff: kickoff.content, row: rows.at(-1)!.content, job: JSON.stringify(job.payload) }
}

const assertNamedById = (seen: Seen, pageId: string, title: RegExp) => {
  assert.equal(seen.title, `Review: document ${pageId}`, 'the thread is titled by the id')
  assert.match(seen.kickoff, new RegExp(`a document \\(pageId=${pageId}\\) whose title is not said here`))
  assert.match(seen.row, /^Woken: a person edited a watched document \(/, 'the channel\'s row names no document')
  for (const said of [seen.title ?? '', seen.kickoff, seen.row, seen.job]) assert.doesNotMatch(said, title)
}

const privateChannel = async (prisma: PrismaClient, s: TicketWorkSeed) => prisma.channel.create({
  data: {
    label: 'hr', slug: `hr-${randomUUID()}`, visibility: 'private',
    organization: { connect: { id: s.organizationId } }, project: { connect: { id: s.projectId } },
    team: { connect: { id: s.teamId } },
  },
})

runDatabaseTest('a version written from a narrower basis is reviewed by the page\'s id, and its thread renamed', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const d = await seedDocumentTrigger(prisma, s)
  const seen = new Set<string>()
  const page = await d.provider.createPage({ ...d.scope, body: '<p>Bands.</p>', title: 'Salary bands' })
  await drainDocumentJobs(prisma, s, seen)
  const named = await newestReview(prisma, d.documentTriggerId)
  assert.equal(named.title, 'Review: Salary bands', 'every reader of the channel may read it: named')
  assert.match(named.row, /the document "Salary bands"/)

  // The next version was written from a private conversation's material.
  const hr = await privateChannel(prisma, s)
  await d.provider.updatePage(page.id, {
    ...d.scope, body: '<p>Bands, revised.</p>', basisScopes: [{ scopeType: 'channel', scopeId: hr.id }],
  })
  await drainDocumentJobs(prisma, s, seen)
  const hidden = await newestReview(prisma, d.documentTriggerId)
  assertNamedById(hidden, page.id, /Salary bands/)
})

runDatabaseTest('a page private to the agent itself is reviewed, by its id', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const d = await seedDocumentTrigger(prisma, s)
  const page = await d.provider.createPage({
    ...d.scope, body: '<p>Notes.</p>', title: 'CTO scratch notes', privateToAgentId: s.agentId,
  })
  await drainDocumentJobs(prisma, s, new Set())
  assertNamedById(await newestReview(prisma, d.documentTriggerId), page.id, /CTO scratch notes/)
})
