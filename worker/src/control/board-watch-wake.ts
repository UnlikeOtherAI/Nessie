import type { PrismaClient } from '@prisma/client'
import { claimThreadRunOrPend } from '@nessie/db'
import { UoaSessionIdentitySchema } from '@nessie/schemas'

import { buildAgentActorContext, startAgentRun } from './agent-run-start.js'

/**
 * Waking an agent that watches a board.
 *
 * Deliberately **not** a synthetic `AgentTrigger`. `queueTriggerRun` needs a
 * trigger row to hang its delivery, retry and health off, and a watcher has
 * none of that — inventing one per watcher would put rows on the Triggers page
 * that nobody created and nobody can edit. What that path and this one actually
 * share is the layer underneath: a `system` kickoff message, the per-(agent,
 * thread) claim, and `startAgentRun`. Those are reused verbatim.
 *
 * The kickoff is `system`, never `user`. A `user` role would attribute
 * "A ticket moved" to whoever added the watcher, filling their DM with
 * plumbing signed by somebody who never wrote it — the exact defect the
 * trigger path documents. `system` keeps the row for audit and for the run's
 * own prompt while staying out of the channel feed and out of future model
 * context.
 *
 * The destination and the identity are **read from the watcher row**, not
 * worked out here. Both were resolved from the adder's session when the
 * watcher was added: the DM key includes a team that only that session knew,
 * and the Ledger signer verifies a captured identity that a sessionless run
 * cannot reconstruct. Recomputing either was how this opened a second DM
 * nobody read and started runs that could not sign.
 */

const kickoffContent = (input: {
  boardName: string
  tickets: { key: string; title: string; changed: string }[]
}): string => {
  const lines = input.tickets.map(
    (ticket) => `- ${ticket.key}: ${ticket.title} (${ticket.changed})`,
  )
  return [
    `You watch the board "${input.boardName}". ${
      input.tickets.length === 1 ? 'A ticket' : `${input.tickets.length} tickets`
    } changed:`,
    ...lines,
    '',
    'Check the board for anything else that moved while you were busy — a wake',
    'that arrives mid-run is batched into this one, and only the latest list',
    'survives. Then decide whether anything is needed; if nothing is, do',
    'nothing and say so briefly.',
  ].join('\n')
}

export const wakeBoardWatcherAgent = async (
  prisma: PrismaClient,
  input: {
    agentId: string
    addedByUserId: string
    /** Resolved at add time. A row without one predates the capture. */
    channelId: string | null
    threadId: string | null
    launchOrigin: unknown
    organizationId: string
    projectId: string
    boardId: string
    boardName: string
    taskIds: string[]
  },
): Promise<'woken' | 'pending' | 'unreachable'> => {
  // A row written before the target was captured, or one whose channel has since
  // been deleted, is unreachable. Deliberately not re-resolved: a second guess
  // at the destination is the defect this column exists to remove.
  if (!input.channelId || !input.threadId) return 'unreachable'
  const thread = await prisma.thread.findFirst({
    where: { id: input.threadId, channelId: input.channelId },
    select: { id: true },
  })
  if (!thread) return 'unreachable'
  const binding = await prisma.agentBinding.count({
    where: { agentId: input.agentId, channelId: input.channelId },
  })
  // The run would be refused downstream without this; refusing here says why.
  if (binding === 0) return 'unreachable'
  const target = { channelId: input.channelId, threadId: input.threadId }

  const tasks = await prisma.task.findMany({
    where: { id: { in: input.taskIds }, projectId: input.projectId },
    select: {
      id: true,
      title: true,
      status: true,
      externalLink: { select: { externalKey: true } },
    },
  })
  if (tasks.length === 0) return 'unreachable'

  const content = kickoffContent({
    boardName: input.boardName,
    tickets: tasks.map((task) => ({
      key: task.externalLink?.externalKey ?? task.id.slice(0, 8),
      title: task.title ?? 'Untitled',
      changed: `now ${task.status}`,
    })),
  })

  const origin = (input.launchOrigin ?? {}) as { teamId?: string; uoaIdentity?: unknown }
  const uoaIdentity = UoaSessionIdentitySchema.safeParse(origin.uoaIdentity)
  const actorContext = buildAgentActorContext({
    agentId: input.agentId,
    channelId: target.channelId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    source: 'board-watch',
    threadId: target.threadId,
    ...(origin.teamId ? { teamId: origin.teamId } : {}),
    ...(uoaIdentity.success ? { uoaIdentity: uoaIdentity.data } : {}),
  })

  return prisma.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: { content, role: 'system', threadId: target.threadId },
      select: { id: true },
    })
    // The same claim a chat reply takes: with a run already in flight for this
    // agent in this thread, the wake pends and is batched into the follow-up
    // rather than spawning a concurrent run. A busy board therefore costs one
    // run at a time per agent, not one per ticket.
    const claim = await claimThreadRunOrPend(tx, {
      agentId: input.agentId,
      threadId: target.threadId,
      pending: {
        actorContext,
        channelId: target.channelId,
        interactive: false,
        messageId: message.id,
      },
    })
    if (claim !== 'claimed') return 'pending'

    await startAgentRun(tx, {
      actorContext,
      agentId: input.agentId,
      channelId: target.channelId,
      messageId: message.id,
      organizationId: input.organizationId,
      purpose: content,
      threadId: target.threadId,
    })
    return 'woken'
  })
}
