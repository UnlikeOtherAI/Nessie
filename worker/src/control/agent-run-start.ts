import type { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'

import {
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
  parseProjectId,
  parseRunId,
  parseTaskId,
  parseTeamId,
  parseThreadId,
  parseUserId,
  withActionContext,
  type AuthorizedActionContext,
  type UoaSessionIdentity,
} from '@nessie/schemas'

import { enqueueRunExecution } from '../queue.js'

/**
 * Starting one agent run from a kickoff message that already exists.
 *
 * The run, its task and the execution job are one act, and two callers now make
 * it: a trigger firing, and a board watcher being told a ticket moved. Only the
 * provenance differs — a trigger carries its delivery, a watcher carries
 * nothing — so that is the only thing this takes as an option.
 *
 * The caller owns everything before this: the kickoff message and the
 * per-(agent, thread) claim. This runs only on `claimed`.
 */
/**
 * The actor context an unattended agent run carries.
 *
 * One builder, because a trigger firing and a board watcher waking are the same
 * kind of run: nobody is at the keyboard, the agent acts as itself, and the
 * tenant comes from the work rather than from a session.
 */
export const buildAgentActorContext = (input: {
  agentId: string
  channelId: string
  effectiveUserId?: string | null
  organizationId: string
  projectId?: string | null
  teamId?: string | null
  threadId: string
  // Omitted while the (agent, thread) slot claim is still unresolved: the
  // pending-marker path has no task, and the claimed path injects the fresh
  // task id via withActionContext once the task exists.
  taskId?: string
  source: string
  /**
   * The creator's UOA team, replayed from the trigger's launch origin.
   * A fire has no session, so without this the Ledger signer has no identity
   * to verify and every scheduled run fails before dispatch.
   */
  uoaIdentity?: UoaSessionIdentity
}): AuthorizedActionContext => ({
  actor: {
    actorId: input.agentId,
    actorType: 'agent',
    roles: ['system'],
  },
  actionContext: {
    agentId: parseAgentId(input.agentId),
    channelId: parseChannelId(input.channelId),
    // When a scheduled task was created by a specific user (e.g. via the
    // schedule_task tool, including the personal assistant acting for its
    // owner), run as that user so memory scoping and "act as user" tools
    // behave the same as the original conversation.
    ...(input.effectiveUserId
      ? { effectiveUserId: parseUserId(input.effectiveUserId) }
      : {}),
    purpose: input.source,
    requestId: randomUUID(),
    ...(input.uoaIdentity ? { uoaIdentity: input.uoaIdentity } : {}),
    threadId: parseThreadId(input.threadId),
    ...(input.taskId ? { taskId: parseTaskId(input.taskId) } : {}),
  },
  tenant: {
    organizationId: parseOrganizationId(input.organizationId),
    projectId: input.projectId ? parseProjectId(input.projectId) : undefined,
    teamId: input.teamId ? parseTeamId(input.teamId) : undefined,
  },
})

export const startAgentRun = async (
  tx: Prisma.TransactionClient,
  input: {
    actorContext: AuthorizedActionContext
    agentId: string
    channelId: string
    messageId: string
    organizationId: string
    /** What the task is for, in a person's words. Truncated for the row. */
    purpose: string
    threadId: string
    triggerId?: string
    triggerDeliveryId?: string
  },
): Promise<{ runId: string; taskId: string }> => {
  const run = await tx.run.create({
    data: {
      agentId: input.agentId,
      // A fire is a standalone contribution to the room, not an answer owed to
      // whoever last spoke. Stamped structurally from the fact that nobody
      // asked, never judged from content. This must stay paired with a
      // `system` kickoff: a hidden root plus default-thread placement would
      // bury the run under an invisible message and drop it out of the feed.
      replyPlacement: 'channel',
      status: 'pending',
      threadId: input.threadId,
      ...(input.triggerDeliveryId ? { triggerDeliveryId: input.triggerDeliveryId } : {}),
      ...(input.triggerId ? { triggerId: input.triggerId } : {}),
    },
    select: { id: true },
  })

  const task = await tx.task.create({
    data: {
      agentId: input.agentId,
      organizationId: input.organizationId,
      purpose: input.purpose.slice(0, 200),
      runId: run.id,
      status: 'inbox',
    },
    select: { id: true },
  })

  await enqueueRunExecution(
    tx,
    {
      actorContext: withActionContext(input.actorContext, { taskId: parseTaskId(task.id) }),
      agentId: parseAgentId(input.agentId),
      messageId: input.messageId,
      runId: parseRunId(run.id),
      taskId: parseTaskId(task.id),
      threadId: parseThreadId(input.threadId),
    },
    `run:${run.id}`,
  )

  return { runId: run.id, taskId: task.id }
}
