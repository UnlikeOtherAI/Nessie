import type { Prisma, PrismaClient } from '@prisma/client'
import {
  parseAgentId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  withActionContext,
  type AuthorizedActionContext,
  type RunExecuteJobPayload,
} from '@nessie/schemas'

/**
 * Handing a global agent a server-authored briefing, in one place.
 *
 * Two surfaces do this — `agent_handoff` from inside another agent's run, and
 * the Agent Designer sidebar's "Continue in chat" from the API — and they must
 * do it the same way, because every property that makes it safe is a property
 * of *how* the brief is delivered:
 *
 * - a hidden `system` message, never a `role: 'user'` row under the person's
 *   id. The integration-handoff precedent writes model text as the requester's
 *   own words: editable by them afterwards and indistinguishable from something
 *   they typed. A `system` row drives the run, stays out of the channel feed and
 *   out of future model context, and leaves the agent's own first reply as the
 *   only visible artifact.
 * - `claimThreadRunOrPend`, so a busy home DM (an open card, a turn still
 *   running) pends the brief for the batched follow-up rather than
 *   double-running the agent. Only the orchestrator's *judgement* is skipped.
 * - `replyPlacement: 'channel'`, because a reply threaded under an invisible
 *   root would never appear in the DM at all.
 * - an idempotency key on the enqueue, so a redelivered caller cannot start the
 *   same conversation twice.
 *
 * Callers keep what is genuinely theirs: the metadata shape, the disclosure
 * basis (a handoff carries the origin run's; a form draft carries none), the
 * cooldown row, and the doorway message. They also hand in the two queue
 * functions, exactly as `startAgentTodoRun` takes them: this package is loaded
 * from its build output by processes whose loaders resolve `@nessie/db`
 * differently, and importing them here breaks in one of them.
 *
 * Spec: docs/plans/2026-09-02-agent-designer-global-agent.md (D8, D9).
 */

export type GlobalAgentBriefInput = {
  /** The global agent's per-organisation row. */
  agentId: string
  /** The brief itself. Server-authored or person-authored; never model-signed. */
  content: string
  destinationChannelId: string
  /** Distinguishes a redelivery of the same request from a fresh one. */
  idempotencyKey: string
  metadata: Prisma.InputJsonValue
  organizationId: string
  /** Already scoped to the destination DM by the caller. */
  requesterActorContext: AuthorizedActionContext
  threadId: string
}

/**
 * `claimThreadRunOrPend` and `enqueueRunExecution` from `@nessie/db`, handed in
 * by the caller. The same seam `AgentTodoRunQueue` uses, for the same reason.
 */
export type GlobalAgentBriefQueue = {
  claimThreadRunOrPend: (
    tx: Prisma.TransactionClient,
    input: {
      agentId: string
      threadId: string
      pending: {
        actorContext: AuthorizedActionContext
        channelId: string
        interactive: boolean
        messageId: string
      }
    },
  ) => Promise<'claimed' | 'pended' | 'duplicate'>
  enqueueRunExecution: (
    prisma: Pick<PrismaClient, '$executeRaw'>,
    payload: RunExecuteJobPayload,
    idempotencyKey?: string,
  ) => Promise<boolean>
}

export type GlobalAgentBriefResult = {
  briefMessageId: string
  /** False when the home DM was busy and the brief pended behind the open turn. */
  started: boolean
}

export const deliverGlobalAgentBrief = async (
  tx: Prisma.TransactionClient,
  queue: GlobalAgentBriefQueue,
  input: GlobalAgentBriefInput,
): Promise<GlobalAgentBriefResult> => {
  const brief = await tx.message.create({
    data: {
      content: input.content,
      metadata: input.metadata,
      role: 'system',
      threadId: input.threadId,
    },
    select: { id: true },
  })

  const claim = await queue.claimThreadRunOrPend(tx, {
    agentId: input.agentId,
    pending: {
      actorContext: input.requesterActorContext,
      channelId: input.destinationChannelId,
      interactive: true,
      messageId: brief.id,
    },
    threadId: input.threadId,
  })
  if (claim !== 'claimed') {
    return { briefMessageId: brief.id, started: false }
  }

  const run = await tx.run.create({
    data: {
      agentId: input.agentId,
      replyPlacement: 'channel',
      status: 'pending',
      threadId: input.threadId,
      triggerMessageId: brief.id,
    },
    select: { id: true },
  })
  const task = await tx.task.create({
    data: {
      agentId: input.agentId,
      organizationId: input.organizationId,
      purpose: input.content.slice(0, 200),
      runId: run.id,
      status: 'inbox',
    },
    select: { id: true },
  })
  await queue.enqueueRunExecution(
    tx,
    {
      actorContext: withActionContext(input.requesterActorContext, {
        taskId: parseTaskId(task.id),
      }),
      agentId: parseAgentId(input.agentId),
      interactive: true,
      messageId: brief.id,
      runId: parseRunId(run.id),
      taskId: parseTaskId(task.id),
      threadId: parseThreadId(input.threadId),
    },
    input.idempotencyKey,
  )

  return { briefMessageId: brief.id, started: true }
}
