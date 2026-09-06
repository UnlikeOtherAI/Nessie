import { Prisma, type PrismaClient } from '@prisma/client'
import {
  AuthorizedActionContextSchema,
  parseAgentId,
  parseChannelId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  RunExecuteJobPayloadSchema,
  withActionContext,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import { enqueueRunExecution } from './queue.js'

// Per-(agent, principal, thread) run serialization. `principal` is null for
// ordinary bindings and PA DMs, and is the PA-presence owner in a shared room.
//
// Invariant: at most ONE in-flight run per (agent, thread). A message that
// arrives while a run is in flight is recorded as a durable
// `RunThreadPendingMessage` row instead of spawning a concurrent run; when the
// in-flight run reaches a terminal state (completed, cancelled, failed —
// including the budget-gate block), the terminal path drains every pending row
// into ONE batched follow-up run, in arrival order. No message is lost across
// a worker crash: the row is the pending marker, and the periodic
// `sweepPendingThreadMessages` re-poll enqueues the follow-up for any pair
// whose run disappeared without draining (crash between terminal update and
// drain, or an API-side queued cancel that never reached the worker).
//
// Race freedom comes from a transaction-scoped advisory lock keyed on
// (agentId, principalUserId, threadId) taken by BOTH the claim side (orchestrate.decide reply,
// trigger fire, mailbox delivery, API trigger dispatch) and the drain side
// inside the same transaction as the run/pending writes: a claim either sees
// the run still active (and pends, so the pending row precedes any drain
// check) or sees it terminal (and claims the slot itself). DeepWater/
// product-handoff runs keep their own stricter invariants and never touch this
// module.
//
// Batch ordering caveat: arrival order is read from `messages.created_at`,
// which is `timestamp(3)`, so messages that arrive within the same millisecond
// tie and fall back to the pending row's `seq` — the order concurrent claims
// happened to record their markers, which need not be arrival order. Accepted:
// every pended message is loaded into the follow-up as thread history either
// way, and the only thing the tie can reorder is which of two same-millisecond
// messages is treated as "latest" for the prompt and `triggerMessageId`.
//
// Batch visibility caveat: the batched follow-up loads pended `user`/
// `assistant` messages as ordinary thread history, but `loadConversation`
// excludes `system`-role messages (e.g. PA scheduled-trigger kickoffs), so
// repeated system-role kickoffs coalesce to the LATEST one — only it drives
// the follow-up's prompt. That is intended: each kickoff is a self-contained
// "check for work" directive, not conversation content.

// Statuses that count as "a run is in flight for this (agent, thread)".
// `waiting_approval` is in-flight: the run resumes after the approval, so new
// messages must pend rather than interleave.
const ACTIVE_THREAD_RUN_STATUSES = [
  'pending',
  'running',
  'waiting_approval',
  'waiting_input',
] as const

// Transaction-scoped advisory lock serializing claim vs. drain for one
// (agent, principal, thread) tuple. Released automatically at commit/rollback.
const acquireThreadRunLock = async (
  tx: Prisma.TransactionClient,
  agentId: string,
  principalUserId: string | undefined,
  threadId: string,
): Promise<void> => {
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${agentId}:${principalUserId ?? 'ordinary'}:${threadId}`}, 0))`,
  )
}

const runPrincipalWhere = (principalUserId: string | undefined) =>
  principalUserId === undefined ? { principalUserId: null } : { principalUserId }

const findActiveThreadRun = async (
  tx: Prisma.TransactionClient,
  agentId: string,
  principalUserId: string | undefined,
  threadId: string,
): Promise<{ id: string } | null> => {
  return tx.run.findFirst({
    where: {
      agentId,
      ...runPrincipalWhere(principalUserId),
      threadId,
      status: { in: [...ACTIVE_THREAD_RUN_STATUSES] },
    },
    select: { id: true },
  })
}

export type ThreadRunClaimOutcome = 'claimed' | 'pended' | 'duplicate'

// Claim the (agent, thread) run slot inside the caller's transaction. On
// 'claimed' the caller creates its run + task + queue job in the same
// transaction, so the slot is visibly occupied at commit. On 'pended' the
// message was recorded for the batched follow-up instead; the caller creates
// no run. On 'duplicate' the delivery is an at-least-once redelivery of a job
// that already committed (a run with this triggerMessageId — ANY status,
// since even a terminal run proves the message was delivered — or an existing
// pending marker): the caller must no-op, creating neither run nor pending
// row. Without the duplicate guard a redelivered decide job would see its own
// committed run still active, pend the same message again, and the drain
// would deliver a second reply.
export const claimThreadRunOrPend = async (
  tx: Prisma.TransactionClient,
  input: {
    agentId: string
    principalUserId?: string
    threadId: string
    pending: {
      actorContext: AuthorizedActionContext
      channelId: string
      interactive: boolean
      messageId: string
      // Trigger provenance, set only by trigger-fire paths. Copied onto the
      // batched follow-up run when the LATEST pending row carries it.
      triggerId?: string
      triggerDeliveryId?: string
      todoTemplateId?: string
    }
  },
): Promise<ThreadRunClaimOutcome> => {
  await acquireThreadRunLock(tx, input.agentId, input.principalUserId, input.threadId)

  const alreadyDelivered = await tx.run.findFirst({
    where: {
      agentId: input.agentId,
      ...runPrincipalWhere(input.principalUserId),
      threadId: input.threadId,
      triggerMessageId: input.pending.messageId,
    },
    select: { id: true },
  })
  if (alreadyDelivered) {
    return 'duplicate'
  }
  const alreadyPended = await tx.runThreadPendingMessage.findFirst({
    where: {
      agentId: input.agentId,
      messageId: input.pending.messageId,
      ...runPrincipalWhere(input.principalUserId),
    },
    select: { seq: true },
  })
  if (alreadyPended) {
    return 'duplicate'
  }

  const active = await findActiveThreadRun(
    tx,
    input.agentId,
    input.principalUserId,
    input.threadId,
  )
  if (!active) {
    return 'claimed'
  }

  await tx.runThreadPendingMessage.create({
    data: {
      agentId: input.agentId,
      principalUserId: input.principalUserId ?? null,
      threadId: input.threadId,
      messageId: input.pending.messageId,
      channelId: input.pending.channelId,
      interactive: input.pending.interactive,
      actorContext: JSON.parse(
        JSON.stringify(input.pending.actorContext),
      ) as Prisma.InputJsonValue,
      triggerId: input.pending.triggerId ?? null,
      triggerDeliveryId: input.pending.triggerDeliveryId ?? null,
      todoTemplateId: input.pending.todoTemplateId ?? null,
    },
  })
  return 'pended'
}

// Claim-side probe for paths that must REJECT instead of pending when the
// slot is held (a human explicitly restarting into a busy thread gets a clear
// 409, not a silent queue). Takes the same advisory lock, so the answer is
// race-free against concurrent claims and drains inside this transaction.
export const isThreadRunSlotBusy = async (
  tx: Prisma.TransactionClient,
  input: { agentId: string; principalUserId?: string; threadId: string },
): Promise<boolean> => {
  await acquireThreadRunLock(tx, input.agentId, input.principalUserId, input.threadId)
  return (
    await findActiveThreadRun(tx, input.agentId, input.principalUserId, input.threadId)
  ) !== null
}

// Drain every pending message for (agent, thread) into ONE batched follow-up
// run. Pended user/assistant messages stay visible to the follow-up through
// normal thread conversation loading (system-role kickoffs coalesce to the
// latest — see the module header). The latest pending message drives the
// run's prompt, triggerMessageId (restart replay), interactivity (budget
// exemption), actor context, and — when it came from a trigger fire — the
// triggerId/triggerDeliveryId linkage. Returns the follow-up run id, or null
// when there is nothing to drain (no pendings, or a run is already in flight
// again).
export const drainPendingThreadMessages = async (
  prisma: PrismaClient,
  input: { agentId: string; principalUserId?: string; threadId: string },
): Promise<string | null> => {
  return prisma.$transaction(async (tx) => {
    await acquireThreadRunLock(tx, input.agentId, input.principalUserId, input.threadId)
    const active = await findActiveThreadRun(
      tx,
      input.agentId,
      input.principalUserId,
      input.threadId,
    )
    if (active) {
      return null
    }

    // Batch order is thread arrival order (the message's createdAt), not the
    // order concurrent decide jobs happened to record their pending markers;
    // seq is the deterministic tiebreaker.
    const pendings = await tx.runThreadPendingMessage.findMany({
      where: {
        agentId: input.agentId,
        threadId: input.threadId,
        ...runPrincipalWhere(input.principalUserId),
      },
      orderBy: [{ message: { createdAt: 'asc' } }, { seq: 'asc' }],
      include: { message: { select: { content: true, role: true } } },
    })
    if (pendings.length === 0) {
      return null
    }
    const latest = pendings[pendings.length - 1]
    if (!latest) {
      return null
    }

    const thread = await tx.thread.findUniqueOrThrow({
      where: { id: input.threadId },
      select: { channel: { select: { organizationId: true } } },
    })

    // A batch may contain fires from more than one schedule. Preserve the
    // latest fire's trigger provenance for each template while coalescing
    // repeated fires of the same checklist into one adopting-run instance.
    const scheduledTemplates = [...pendings.reduce((templates, pending) => {
      if (pending.todoTemplateId && pending.triggerId) {
        templates.set(pending.todoTemplateId, {
          templateId: pending.todoTemplateId,
          triggerId: pending.triggerId,
        })
      }
      return templates
    }, new Map<string, { templateId: string; triggerId: string }>()).values()]
    const scheduledKickoff = scheduledTemplates.length > 0
      ? await tx.message.create({
          data: {
            // The worker replaces this placeholder with the instance-pinned
            // checklist once the run has actually claimed its slot.
            content: 'Scheduled to-do kickoff pending materialization.',
            metadata: {
              todoScheduledKickoff: { todoTemplates: scheduledTemplates },
            } as Prisma.InputJsonValue,
            role: 'system',
            threadId: input.threadId,
          },
          select: { id: true },
        })
      : null

    const run = await tx.run.create({
      data: {
        agentId: input.agentId,
        principalUserId: latest.principalUserId,
        threadId: input.threadId,
        // A batched follow-up whose kickoff is hidden still posts to the room
        // rather than threading under it — matching the direct claim path in
        // `agent-run-start.ts`. Without this, an unattended fire that lands
        // while the slot is busy replies under a `system` kickoff nobody can
        // see, and vanishes from the channel.
        //
        // Keyed on the kickoff's role, not on `triggerId`: a trigger fire was
        // the first path to write a hidden kickoff, but a board watcher's wake
        // is the second, and the rule was always "a hidden root cannot own a
        // reply". Structural either way — derived from the row, never content.
        replyPlacement:
          latest.triggerId || latest.message.role === 'system' ? 'channel' : null,
        status: 'pending',
        triggerMessageId: scheduledKickoff?.id ?? latest.messageId,
        triggerId: latest.triggerId ?? null,
        triggerDeliveryId: latest.triggerDeliveryId ?? null,
      },
      select: { id: true },
    })
    const task = await tx.task.create({
      data: {
        agentId: input.agentId,
        organizationId: thread.channel.organizationId,
        purpose: (scheduledKickoff ? 'Scheduled to-do' : latest.message.content).slice(0, 200),
        runId: run.id,
        status: 'inbox',
      },
      select: { id: true },
    })

    const actorContext = AuthorizedActionContextSchema.parse(latest.actorContext)
    const payload = RunExecuteJobPayloadSchema.parse({
      actorContext: withActionContext(actorContext, {
        agentId: parseAgentId(input.agentId),
        channelId: parseChannelId(latest.channelId),
        taskId: parseTaskId(task.id),
        threadId: parseThreadId(input.threadId),
      }),
      agentId: parseAgentId(input.agentId),
      ...(latest.principalUserId ? { principalUserId: latest.principalUserId } : {}),
      interactive: latest.interactive,
      messageId: scheduledKickoff?.id ?? latest.messageId,
      runId: parseRunId(run.id),
      taskId: parseTaskId(task.id),
      threadId: parseThreadId(input.threadId),
    })
    // Keyed by the fresh run id so the follow-up enqueue never collides with
    // the per-message `run:<messageId>:<agentId>` keys of prior turns.
    await enqueueRunExecution(tx, payload, `run:batch:${run.id}`)

    await tx.runThreadPendingMessage.deleteMany({
      where: { seq: { in: pendings.map((pending) => pending.seq) } },
    })

    console.log(
      JSON.stringify({
        event: 'thread.pending.drained',
        agentId: input.agentId,
        threadId: input.threadId,
        runId: run.id,
        batchedMessages: pendings.length,
      }),
    )
    return run.id
  })
}

// Terminal-path drain: a failure here must never turn an already-terminal run
// back into a failure — the sweep below is the backstop that retries.
export const drainPendingThreadMessagesBestEffort = async (
  prisma: PrismaClient,
  input: { agentId: string; principalUserId?: string; threadId: string },
): Promise<void> => {
  try {
    await drainPendingThreadMessages(prisma, input)
  } catch (error) {
    console.error(
      '[worker] failed to drain pending thread messages',
      input.agentId,
      input.threadId,
      error,
    )
  }
}

// Restart-durability re-poll: find (agent, thread) pairs with pending rows but
// no in-flight run and drain each. Covers a worker crash between the terminal
// update and the drain, and an API-side cancel of a queued (never-executed)
// run, which no worker path ever observes.
export const sweepPendingThreadMessages = async (
  prisma: PrismaClient,
  input: { limit?: number } = {},
): Promise<number> => {
  const pairs = await prisma.$queryRaw<{
    agentId: string
    principalUserId: string | null
    threadId: string
  }[]>(
    Prisma.sql`
      SELECT DISTINCT p.agent_id AS "agentId",
             p.principal_user_id AS "principalUserId",
             p.thread_id AS "threadId"
      FROM run_thread_pending_messages p
      WHERE NOT EXISTS (
        SELECT 1 FROM runs r
        WHERE r.agent_id = p.agent_id
          AND r.thread_id = p.thread_id
          AND r.principal_user_id IS NOT DISTINCT FROM p.principal_user_id
          AND r.status IN ('pending', 'running', 'waiting_approval', 'waiting_input')
      )
      LIMIT ${input.limit ?? 20}
    `,
  )

  let drained = 0
  for (const pair of pairs) {
    const runId = await drainPendingThreadMessages(prisma, {
      agentId: pair.agentId,
      ...(pair.principalUserId ? { principalUserId: pair.principalUserId } : {}),
      threadId: pair.threadId,
    })
    if (runId) {
      drained += 1
    }
  }
  return drained
}
