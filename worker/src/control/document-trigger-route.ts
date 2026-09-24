import type { Prisma, PrismaClient } from '@prisma/client'
import {
  TICKET_WORK_LIVE_STATUSES,
  TicketChangedStoredConfigSchema,
  type DocumentChangedStoredConfig,
} from '@nessie/schemas'

import type { CountedVersions, WatchedPage } from './document-trigger-facts.js'
import {
  describeDocumentChange,
  documentThreadTitle,
  renderDocumentReviewKickoff,
  type DocumentChangeFacts,
  type DocumentTicketNote,
} from './document-trigger-kickoff.js'
import { ensureDocumentReviewThread, queueDocumentReviewRun } from './document-trigger-run.js'
import type { DocumentAct } from './document-trigger-dispatch.js'
import { assertTargetChannel } from './ticket-work.js'
import type { TicketWorkSeam } from './ticket-work-seam.js'

/**
 * Where a document change lands (docs/plans/2026-09-23-ticket-driven-agents/triggers.md,
 * "Where it lands"; docs/standards/document-triggers.md), in this order:
 *
 * 1. **The page's ticket's live work for this trigger's agent.** A ticket
 *    document (`KnowledgePage.taskId`) whose ticket has a live work record of
 *    the same agent — never another agent's, however many ticket triggers
 *    cover the board — wakes that record as a `document_changed` follow in its
 *    work thread, under the ticket trigger's own rules: it follows `document`,
 *    and a person who can edit the board saved part of the change. That is
 *    how a spec edit reaches the coding agent mid-work.
 * 2. **Otherwise the page's own review thread** in the target channel, one per
 *    (trigger, page), never the channel's General thread; for a ticket's
 *    document the kickoff names the ticket and why it is reviewed here.
 *
 * Runs inside the delivery's transaction.
 */

type RouteInput = {
  seam: TicketWorkSeam
  trigger: { id: string; agentId: string; organizationId: string; targetChannelId: string | null }
  config: DocumentChangedStoredConfig
  page: WatchedPage
  facts: DocumentChangeFacts
  counts: CountedVersions
  /** When the version the agent is brought up to was saved. */
  at: Date
  deliveryId: string
}

type TicketRoute =
  | { kind: 'work'; work: { id: string; taskId: string; projectId: string; threadId: string }; ticketTrigger: TicketTrigger }
  | { kind: 'thread'; note: DocumentTicketNote | null }

type TicketTrigger = {
  id: string
  agentId: string
  targetChannelId: string | null
  config: ReturnType<typeof TicketChangedStoredConfigSchema.parse>
}

/** Whether the change goes to the ticket's live work, or — with why not — to the page's own thread. */
const ticketRoute = async (prisma: PrismaClient, input: RouteInput): Promise<TicketRoute> => {
  const taskId = input.page.taskId
  if (!taskId) return { kind: 'thread', note: null }
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true, title: true } })
  if (!task) return { kind: 'thread', note: null }
  const note = (why: DocumentTicketNote['why']): TicketRoute => ({ kind: 'thread', note: { id: task.id, title: task.title, why } })
  const work = await prisma.agentTicketWork.findFirst({
    where: { taskId, agentId: input.trigger.agentId, status: { in: [...TICKET_WORK_LIVE_STATUSES] } },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true, taskId: true, projectId: true, threadId: true,
      trigger: {
        select: {
          id: true, agentId: true, config: true, enabled: true, status: true, targetChannelId: true, type: true,
        },
      },
    },
  })
  if (!work) {
    const ended = await prisma.agentTicketWork.count({ where: { taskId, agentId: input.trigger.agentId } })
    return note(ended > 0 ? 'work_ended' : 'no_work')
  }
  const trigger = work.trigger
  const config = TicketChangedStoredConfigSchema.safeParse(trigger?.config)
  if (!trigger?.agentId || trigger.type !== 'ticket_changed' || !trigger.enabled || trigger.status !== 'active' || !config.success) {
    return note('work_ended')
  }
  if (!config.data.follow.kinds.includes('document')) return note('not_followed')
  // The follow rule: only a person who can edit the board steers the work.
  if (input.counts.editorCount === 0) {
    return note(input.facts.counted.people === 0 ? 'other_agent_edits' : 'not_board_editor')
  }
  return {
    kind: 'work',
    work: { id: work.id, taskId: work.taskId, projectId: work.projectId, threadId: work.threadId },
    ticketTrigger: {
      id: trigger.id, agentId: trigger.agentId, targetChannelId: trigger.targetChannelId, config: config.data,
    },
  }
}

/** The document trigger's own instructions, carried into the ticket's wake beside the ticket trigger's. */
const withInstructions = (text: string, config: DocumentChangedStoredConfig): string =>
  config.instructions ? `${text}\nWhat this document trigger asks of you: ${config.instructions.general}` : text

const reviewInThread = async (
  tx: Prisma.TransactionClient,
  input: RouteInput,
  note: DocumentTicketNote | null,
): ReturnType<DocumentAct> => {
  const channelId = await assertTargetChannel(tx, input.trigger)
  const channel = await tx.channel.findUniqueOrThrow({
    where: { id: channelId },
    select: { id: true, label: true, projectId: true, teamId: true },
  })
  const thread = await ensureDocumentReviewThread(tx, {
    triggerId: input.trigger.id,
    pageId: input.page.id,
    agentId: input.trigger.agentId,
    channelId,
    title: documentThreadTitle(input.facts),
  })
  await queueDocumentReviewRun(tx, {
    trigger: input.trigger,
    channel,
    threadId: thread.id,
    kickoff: renderDocumentReviewKickoff({
      facts: input.facts,
      channelLabel: channel.label,
      ticket: note,
      instructions: input.config.instructions,
    }),
    summary: describeDocumentChange(input.facts).summary,
    purpose: input.facts.nameable ? `Document review: ${input.facts.page.title}` : 'Document review',
    deliveryId: input.deliveryId,
  })
  return { outcome: 'page_thread', threadId: thread.id }
}

export const routeDocumentChange = async (
  prisma: PrismaClient,
  tx: Prisma.TransactionClient,
  input: RouteInput,
): ReturnType<DocumentAct> => {
  const route = await ticketRoute(prisma, input)
  if (route.kind === 'thread') return reviewInThread(tx, input, route.note)
  const described = describeDocumentChange(input.facts)
  const outcome = await input.seam.wakeTicketWork(tx, {
    trigger: { ...route.ticketTrigger, organizationId: input.trigger.organizationId },
    task: { id: route.work.taskId, projectId: route.work.projectId },
    event: {
      id: input.facts.to.id,
      eventType: 'document_changed',
      createdAt: input.at,
      kind: 'document',
      described: { text: withInstructions(described.text, input.config), summary: described.summary },
    },
    workId: route.work.id,
    reason: 'document_changed',
    untrusted: input.facts.untrusted,
    machineLess: false,
    resumes: false,
    deliveryId: input.deliveryId,
  })
  // The work stopped before the change reached it (its wake limit, or it
  // ended a moment ago): the change is still reviewed, in the page's thread.
  if (outcome.outcome === 'refused') {
    const task = await tx.task.findUnique({ where: { id: route.work.taskId }, select: { title: true } })
    return reviewInThread(tx, input, { id: route.work.taskId, title: task?.title ?? null, why: 'work_ended' })
  }
  return { outcome: 'ticket_work', workId: outcome.workId, threadId: route.work.threadId }
}
