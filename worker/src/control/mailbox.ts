import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { Prisma } from '@prisma/client'
import type { PgRealtimeTransport } from '@nessie/runtime'
import {
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  redactDetectedSecrets,
  type AuthorizedActionContext,
  type WsScope,
} from '@nessie/schemas'
import { ensureDefaultThread } from './channels.js'
import { markDelegationStepQueued } from '../run/plans.js'
import { markWorkflowStepRunQueued } from '../run/workflows.js'
import { enqueueRunExecution } from '../queue.js'
import { claimThreadRunOrPend } from '../run/thread-serialization.js'

const CLAIM_TIMEOUT_MS = 60_000

type ClaimedMailboxMessage = {
  actorId: string | null
  actorType: string | null
  attempts: number
  body: string
  channelId: string | null
  claimedAt: Date
  correlationId: string | null
  fromAgentId: string | null
  id: string
  organizationId: string
  planId: string | null
  planStepId: string | null
  subject: string | null
  threadId: string | null
  toAgentId: string
  workflowRunId: string | null
  workflowStepRunId: string | null
}

const buildMailboxActorContext = (input: {
  actorId: string
  actorType: 'agent' | 'service' | 'user'
  channelId: string
  organizationId: string
  targetAgentId: string
  // Omitted while the (agent, thread) slot claim is still unresolved: the
  // pending-marker path has no task, and the claimed path injects the fresh
  // task id once the task exists.
  taskId?: string
  threadId: string
}): AuthorizedActionContext => ({
  actor: {
    actorId: input.actorId,
    actorType: input.actorType,
    ...(input.actorType === 'agent' ? { roles: ['system'] } : {}),
  },
  actionContext: {
    agentId: parseAgentId(input.targetAgentId),
    channelId: parseChannelId(input.channelId),
    correlationId: undefined,
    purpose: 'mailbox.delivery',
    requestId: randomUUID(),
    ...(input.taskId ? { taskId: parseTaskId(input.taskId) } : {}),
    threadId: parseThreadId(input.threadId),
  },
  tenant: {
    organizationId: parseOrganizationId(input.organizationId),
  },
})

const buildScopes = (input: {
  agentId: string
  channelId: string
  organizationId: string
}): WsScope[] => [
  {
    kind: 'organization',
    organizationId: parseOrganizationId(input.organizationId),
  },
  {
    kind: 'channel',
    channelId: parseChannelId(input.channelId),
  },
  {
    kind: 'agent',
    agentId: parseAgentId(input.agentId),
  },
]

const claimNextMailboxMessage = async (
  prisma: PrismaClient,
): Promise<ClaimedMailboxMessage | null> => {
  const rows = await prisma.$queryRaw<ClaimedMailboxMessage[]>(
    Prisma.sql`
      WITH next_message AS (
        SELECT amm.id
        FROM "agent_mailbox_messages" AS amm
        WHERE amm."status" = 'queued'::"MailboxMessageStatus"
          AND amm."visible_at" <= now()
          AND amm."to_agent_id" IS NOT NULL
        ORDER BY amm."visible_at" ASC, amm."created_at" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE "agent_mailbox_messages" AS amm
      SET
        "status" = 'processing'::"MailboxMessageStatus",
        "claimed_at" = now(),
        "attempts" = amm."attempts" + 1
      FROM next_message
      WHERE amm."id" = next_message."id"
      RETURNING
        amm."actor_id" AS "actorId",
        amm."actor_type" AS "actorType",
        amm."body" AS "body",
        amm."attempts" AS "attempts",
        amm."channel_id" AS "channelId",
        amm."claimed_at" AS "claimedAt",
        amm."correlation_id" AS "correlationId",
        amm."from_agent_id" AS "fromAgentId",
        amm."id" AS "id",
        amm."organization_id" AS "organizationId",
        amm."plan_id" AS "planId",
        amm."plan_step_id" AS "planStepId",
        amm."subject" AS "subject",
        amm."thread_id" AS "threadId",
        amm."to_agent_id" AS "toAgentId",
        amm."workflow_run_id" AS "workflowRunId",
        amm."workflow_step_run_id" AS "workflowStepRunId"
    `,
  )

  return rows[0] ?? null
}

const deadLetterMailboxMessage = async (
  prisma: PrismaClient,
  message: Pick<ClaimedMailboxMessage, 'attempts' | 'id'>,
): Promise<boolean> => {
  const result = await prisma.agentMailboxMessage.updateMany({
    where: {
      attempts: message.attempts,
      deliveredAt: null,
      id: message.id,
      status: 'processing',
    },
    data: {
      claimedAt: null,
      status: 'dead_letter',
    },
  })

  return result.count === 1
}

export const reclaimExpiredMailboxMessages = async (
  prisma: PrismaClient,
): Promise<number> => {
  const rows = await prisma.$executeRaw(
    Prisma.sql`
      UPDATE "agent_mailbox_messages"
      SET
        "status" = CASE
          WHEN "attempts" >= 3 THEN 'dead_letter'::"MailboxMessageStatus"
          ELSE 'queued'::"MailboxMessageStatus"
        END,
        "claimed_at" = NULL,
        "visible_at" = CASE
          WHEN "attempts" >= 3 THEN "visible_at"
          WHEN "attempts" = 1 THEN now() + interval '10 seconds'
          WHEN "attempts" = 2 THEN now() + interval '30 seconds'
          ELSE now() + interval '60 seconds'
        END
      WHERE "status" = 'processing'::"MailboxMessageStatus"
        AND "delivered_at" IS NULL
        AND "claimed_at" < ${new Date(Date.now() - CLAIM_TIMEOUT_MS)}
    `,
  )

  return Number(rows)
}

const resolveMailboxActorType = (message: ClaimedMailboxMessage): 'agent' | 'service' | 'user' => {
  if (message.actorType === 'agent' || message.actorType === 'service' || message.actorType === 'user') {
    return message.actorType
  }

  return 'agent'
}

export const dispatchNextMailboxMessage = async (
  prisma: PrismaClient,
  realtimeTransport: PgRealtimeTransport,
): Promise<boolean> => {
  const message = await claimNextMailboxMessage(prisma)
  if (!message) {
    return false
  }

  const targetThreadId =
    message.threadId ??
    (message.channelId ? await ensureDefaultThread(prisma, message.channelId) : null)

  if (!targetThreadId) {
    await deadLetterMailboxMessage(prisma, message)
    return true
  }

  const thread = await prisma.thread.findUnique({
    where: { id: targetThreadId },
    select: {
      channelId: true,
      channel: {
        select: {
          organizationId: true,
        },
      },
    },
  })
  if (!thread) {
    await deadLetterMailboxMessage(prisma, message)
    return true
  }
  if (thread.channel.organizationId !== message.organizationId) {
    await deadLetterMailboxMessage(prisma, message)
    return true
  }
  if (message.channelId && message.channelId !== thread.channelId) {
    await deadLetterMailboxMessage(prisma, message)
    return true
  }

  const binding = await prisma.agentBinding.findFirst({
    where: {
      agentId: message.toAgentId,
      channelId: thread.channelId,
    },
    select: { id: true },
  })
  if (!binding) {
    await deadLetterMailboxMessage(prisma, message)
    return true
  }

  const spawnedEvent =
    message.fromAgentId &&
    thread.channel.organizationId &&
    ({
      agentId: message.fromAgentId,
      channelId: thread.channelId,
      organizationId: thread.channel.organizationId,
    } as const)

  // The API refuses new secret-bearing mailbox rows. Redact again here so a
  // legacy row or direct database insertion cannot cross into chat, realtime,
  // task metadata, a queue payload, or model context.
  const safeBody = redactDetectedSecrets(message.body)
  const safeSubject = message.subject
    ? redactDetectedSecrets(message.subject)
    : null

  const publishPayload = await prisma.$transaction(async (tx) => {
    const promptMessage = await tx.message.create({
      data: {
        content: safeBody,
        role: 'user',
        threadId: targetThreadId,
      },
      select: { id: true },
    })

    const baseActorContext = buildMailboxActorContext({
      actorId: message.actorId ?? message.fromAgentId ?? message.toAgentId,
      actorType: resolveMailboxActorType(message),
      channelId: thread.channelId,
      organizationId: message.organizationId,
      targetAgentId: message.toAgentId,
      threadId: targetThreadId,
    })

    // Same per-(agent, thread) claim as chat replies and trigger fires: with
    // a run already in flight the delivery pends for the batched follow-up
    // instead of spawning a concurrent run. The mailbox message is still
    // marked delivered — the pending marker IS the durable delivery.
    const claim = await claimThreadRunOrPend(tx, {
      agentId: message.toAgentId,
      threadId: targetThreadId,
      pending: {
        actorContext: baseActorContext,
        channelId: thread.channelId,
        // Agent-to-agent mail is automation, never a live human turn.
        interactive: false,
        messageId: promptMessage.id,
      },
    })

    let run: { id: string } | null = null
    let task: { id: string } | null = null
    if (claim === 'claimed') {
      run = await tx.run.create({
        data: {
          agentId: message.toAgentId,
          status: 'pending',
          threadId: targetThreadId,
        },
        select: { id: true },
      })

      task = await tx.task.create({
        data: {
          agentId: message.toAgentId,
          organizationId: message.organizationId,
          purpose: (safeSubject ?? safeBody).slice(0, 200),
          runId: run.id,
          status: 'inbox',
        },
        select: { id: true },
      })

      await enqueueRunExecution(
        tx,
        {
          actorContext: buildMailboxActorContext({
            actorId: message.actorId ?? message.fromAgentId ?? message.toAgentId,
            actorType: resolveMailboxActorType(message),
            channelId: thread.channelId,
            organizationId: message.organizationId,
            targetAgentId: message.toAgentId,
            taskId: task.id,
            threadId: targetThreadId,
          }),
          agentId: parseAgentId(message.toAgentId),
          messageId: promptMessage.id,
          parentPlanId: message.planId ?? undefined,
          parentPlanStepId: message.planStepId ?? undefined,
          parentWorkflowRunId: message.workflowRunId ?? undefined,
          parentWorkflowStepRunId: message.workflowStepRunId ?? undefined,
          promptOverride: safeBody,
          runId: parseRunId(run.id),
          taskId: parseTaskId(task.id),
          threadId: parseThreadId(targetThreadId),
        },
        `mailbox:${message.id}`,
      )
    }

    await tx.agentMailboxMessage.update({
      where: { id: message.id },
      data: {
        deliveredAt: new Date(),
        status: 'delivered',
      },
    })

    // Plan/workflow queue-markers reference the child run, so they only apply
    // when this delivery claimed the slot and created one.
    if (run && task) {
      await markDelegationStepQueued(tx, {
        artifacts: {
          childRunId: run.id,
          mailboxMessageId: message.id,
          targetAgentId: message.toAgentId,
        },
        planId: message.planId,
        planStepId: message.planStepId,
      })
      await markWorkflowStepRunQueued(tx, {
        output: {
          childRunId: run.id,
          mailboxMessageId: message.id,
          targetAgentId: message.toAgentId,
          taskId: task.id,
        },
        workflowRunId: message.workflowRunId,
        workflowStepRunId: message.workflowStepRunId,
      })
    }

    const childAgent = await tx.agent.findUnique({
      where: { id: message.toAgentId },
      select: { parentAgentId: true },
    })
    return {
      messageId: promptMessage.id,
      spawned:
        run && task &&
        childAgent?.parentAgentId === message.fromAgentId && spawnedEvent
          ? {
              childId: parseAgentId(message.toAgentId),
              parentId: parseAgentId(spawnedEvent.agentId),
              scopes: buildScopes(spawnedEvent),
              taskId: parseTaskId(task.id),
              threadId: parseThreadId(targetThreadId),
            }
          : null,
    }
  })

  if (!publishPayload) {
    return true
  }

  await realtimeTransport.publishWs(
    buildScopes({
      agentId: message.toAgentId,
      channelId: thread.channelId,
      organizationId: message.organizationId,
    }),
    {
      data: {
        agentId: parseAgentId(message.toAgentId),
        channelId: parseChannelId(thread.channelId),
        contentPreview: safeBody.slice(0, 200),
        messageId: publishPayload.messageId,
        role: 'user',
        threadId: parseThreadId(targetThreadId),
      },
      event: 'message.new',
    },
  )

  if (publishPayload.spawned) {
    await realtimeTransport.publishWs(publishPayload.spawned.scopes, {
      data: {
        childId: publishPayload.spawned.childId,
        messageId: publishPayload.messageId,
        parentId: publishPayload.spawned.parentId,
        taskId: publishPayload.spawned.taskId,
        threadId: publishPayload.spawned.threadId,
      },
      event: 'agent.spawned',
    })
  }

  return true
}
