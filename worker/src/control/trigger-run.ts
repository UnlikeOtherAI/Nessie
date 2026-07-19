import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import { buildTriggerPrompt } from '@nessie/runtime'
import {
  type AgentTriggerType,
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
  parseProjectId,
  parseRunId,
  parseTaskId,
  parseTeamId,
  parseThreadId,
  parseUserId,
  type AuthorizedActionContext,
  type WorkflowRunExecuteJobPayload,
} from '@nessie/schemas'
import { enqueueQueueJob, enqueueRunExecution } from '../queue.js'
import { recordDeliveryFailure } from './trigger-delivery-retry.js'
import {
  assertTriggerExecutionOriginTenant,
  resolveTriggerExecutionOrigin,
  TriggerLaunchOriginError,
} from './trigger-origin.js'

// Shared "fire a run from a trigger" primitives used by both the scheduler sweep
// and event dispatch. Kept separate from the scheduling/claim logic so the two
// callers depend on the run-queueing seam, not on each other.

// sp-webhook: a retry attempt (driven by the delivery-retry poller) reuses an
// existing `failed` delivery row instead of creating a new one, so the
// (trigger_id, dedupe_key) uniqueness holds and backoff state accumulates.
type RetryContext = { reuseDeliveryId?: string; retryCount?: number }

// Create the delivery for a fresh fire, or reuse+reset the row when retrying.
const upsertDelivery = async (
  tx: Prisma.TransactionClient,
  input: {
    dedupeKey?: string
    payload: Prisma.InputJsonValue
    retry?: RetryContext
    source: string
    triggerId: string
  },
): Promise<{ id: string }> => {
  if (input.retry?.reuseDeliveryId) {
    return tx.agentTriggerDelivery.update({
      where: { id: input.retry.reuseDeliveryId },
      data: {
        payload: input.payload,
        source: input.source,
        status: 'pending',
        errorMessage: null,
      },
      select: { id: true },
    })
  }

  return tx.agentTriggerDelivery.create({
    data: {
      dedupeKey: input.dedupeKey,
      payload: input.payload,
      source: input.source,
      status: 'pending',
      triggerId: input.triggerId,
    },
    select: { id: true },
  })
}

const normalizePayload = (payload: unknown): Prisma.InputJsonValue => {
  if (payload === null) {
    return Prisma.JsonNull as unknown as Prisma.InputJsonValue
  }
  if (
    typeof payload === 'string' ||
    typeof payload === 'number' ||
    typeof payload === 'boolean'
  ) {
    return payload
  }
  if (Array.isArray(payload)) {
    return payload as Prisma.InputJsonValue
  }
  if (payload && typeof payload === 'object') {
    return payload as Prisma.InputJsonValue
  }
  return {}
}

const buildActorContext = (input: {
  agentId: string
  channelId: string
  effectiveUserId?: string | null
  organizationId: string
  projectId?: string | null
  teamId?: string | null
  threadId: string
  taskId: string
  source: string
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
    threadId: parseThreadId(input.threadId),
    taskId: parseTaskId(input.taskId),
  },
  tenant: {
    organizationId: parseOrganizationId(input.organizationId),
    projectId: input.projectId ? parseProjectId(input.projectId) : undefined,
    teamId: input.teamId ? parseTeamId(input.teamId) : undefined,
  },
})

export const queueWorkflowTriggerRun = async (
  prisma: PrismaClient,
  input: {
    dedupeKey?: string
    payload: unknown
    retry?: RetryContext
    source: string
    trigger: {
      id: string
      type: AgentTriggerType
      workflowInstallation: {
        active: boolean
        channelId: string | null
        id: string
        organizationId: string
        status: 'active' | 'disabled' | 'draft' | 'paused'
        projectId: string | null
        teamId: string | null
      }
    }
  },
): Promise<void> => {
  const installation = input.trigger.workflowInstallation
  if (!installation.active || installation.status === 'disabled') {
    return
  }

  const existingDelivery = input.dedupeKey
    ? await prisma.agentTriggerDelivery.findFirst({
        where: {
          dedupeKey: input.dedupeKey,
          triggerId: input.trigger.id,
        },
        include: {
          workflowRuns: {
            select: { id: true },
            take: 1,
          },
        },
      })
    : null

  if (existingDelivery?.workflowRuns[0]?.id) {
    return
  }

  const actorContext: AuthorizedActionContext = {
    actor: {
      actorId: installation.id,
      actorType: 'service',
      roles: ['system'],
    },
    actionContext: {
      ...(installation.channelId
        ? { channelId: parseChannelId(installation.channelId) }
        : {}),
      purpose: `trigger:${input.trigger.type}`,
      requestId: randomUUID(),
      correlationId: `trigger:${input.trigger.id}`,
    },
    tenant: {
      organizationId: parseOrganizationId(installation.organizationId),
      projectId: installation.projectId ? parseProjectId(installation.projectId) : undefined,
      teamId: installation.teamId ? parseTeamId(installation.teamId) : undefined,
    },
  }

  const normalizedPayload = normalizePayload(input.payload)
  try {
    await prisma.$transaction(async (tx) => {
      const delivery = await upsertDelivery(tx, {
        dedupeKey: input.dedupeKey,
        payload: normalizedPayload,
        retry: input.retry,
        source: input.source,
        triggerId: input.trigger.id,
      })

      const workflowRun = await tx.workflowRun.create({
        data: {
          installationId: installation.id,
          organizationId: installation.organizationId,
          triggerId: input.trigger.id,
          triggerDeliveryId: delivery.id,
          input: (input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
            ? (input.payload as Record<string, unknown>)
            : { payload: input.payload ?? null }) as Prisma.InputJsonValue,
          startedByActorType: actorContext.actor.actorType,
          startedByActorId: actorContext.actor.actorId,
        },
        select: { id: true },
      })

      const jobPayload: WorkflowRunExecuteJobPayload = {
        actorContext,
        workflowRunId: workflowRun.id,
      }
      await enqueueQueueJob(tx, {
        idempotencyKey: `workflow-run:start:${workflowRun.id}`,
        payload: jobPayload,
        topic: 'workflow.run.execute',
      })

      await tx.agentTriggerDelivery.update({
        where: { id: delivery.id },
        data: {
          deliveredAt: new Date(),
          status: 'delivered',
        },
      })

      await tx.agentTrigger.update({
        where: { id: input.trigger.id },
        data: {
          lastFiredAt: new Date(),
        },
      })
    })
  } catch (error) {
    if (
      input.dedupeKey &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return
    }
    // sp-webhook: persist a retryable failed delivery (outside the rolled-back
    // tx) so the retry poller can re-attempt with backoff.
    await recordDeliveryFailure(prisma, {
      dedupeKey: input.dedupeKey,
      error,
      existingDeliveryId: input.retry?.reuseDeliveryId,
      payload: normalizedPayload,
      retryCount: input.retry?.retryCount ?? 0,
      source: input.source,
      triggerId: input.trigger.id,
    })
    throw error
  }
}

export const queueTriggerRun = async (
  prisma: PrismaClient,
  input: {
    dedupeKey?: string
    payload: unknown
    retry?: RetryContext
    source: string
    trigger: {
      agent: {
        agentKind: 'personal_assistant' | 'shared'
        organizationId: string | null
        projectId: string | null
        teamId: string | null
      }
      agentId: string
      config?: unknown
      id: string
      targetChannelId: string
      targetThreadId: string
      type: AgentTriggerType
    }
  },
): Promise<void> => {
  // The personal assistant is its owner's delegate: it reaches every channel in
  // the organization, so the binding gate and the membership re-check below do
  // not apply to it. It always keeps acting as its owner.
  const isPersonalAssistantTrigger =
    input.trigger.agent.agentKind === 'personal_assistant'
  const existingDelivery = input.dedupeKey
    ? await prisma.agentTriggerDelivery.findFirst({
        where: {
          dedupeKey: input.dedupeKey,
          triggerId: input.trigger.id,
        },
        include: {
          run: {
            select: { id: true },
          },
        },
      })
    : null

  if (existingDelivery?.run?.id) {
    return
  }

  const thread = await prisma.thread.findUnique({
    where: { id: input.trigger.targetThreadId },
    select: {
      channel: {
        select: { organizationId: true, visibility: true },
      },
      channelId: true,
    },
  })
  if (!thread || thread.channelId !== input.trigger.targetChannelId) {
    return
  }

  if (!isPersonalAssistantTrigger) {
    const binding = await prisma.agentBinding.findFirst({
      where: {
        agentId: input.trigger.agentId,
        channelId: input.trigger.targetChannelId,
      },
      select: { id: true },
    })
    if (!binding) {
      return
    }
  }

  const content = buildTriggerPrompt({
    config: input.trigger.config,
    payload: input.payload,
    source: input.source,
    triggerType: input.trigger.type,
  })

  const normalizedPayload = normalizePayload(input.payload)
  try {
    const executionOrigin = resolveTriggerExecutionOrigin({
      agent: input.trigger.agent,
      channelOrganizationId: thread.channel.organizationId,
      config: input.trigger.config,
    })
    await assertTriggerExecutionOriginTenant(prisma, executionOrigin)

    // Shared agents must still be usable by the saved user at fire time. Losing
    // that authorization fails closed; it must never silently erase the user
    // while retaining their immutable billing team.
    if (
      !isPersonalAssistantTrigger
      && executionOrigin.userId
      && thread.channel.visibility !== 'public'
    ) {
      const membership = await prisma.channelMember.findFirst({
        where: {
          channelId: input.trigger.targetChannelId,
          userId: executionOrigin.userId,
        },
        select: { userId: true },
      })
      if (!membership) {
        throw new TriggerLaunchOriginError(
          'its saved user no longer has access to the target channel',
        )
      }
    }

    await prisma.$transaction(async (tx) => {
      const delivery = await upsertDelivery(tx, {
        dedupeKey: input.dedupeKey,
        payload: normalizedPayload,
        retry: input.retry,
        source: input.source,
        triggerId: input.trigger.id,
      })

      const message = await tx.message.create({
        data: {
          content,
          // A PA-owned scheduled run posts AS the owner, so its kickoff prompt is
          // an internal system-injected directive rather than a post the owner
          // made. Mark it `system` so it drives the run but is excluded from both
          // the channel feed and future model context (see listThreadMessages /
          // loadConversation). Shared agents keep the visible `user` kickoff.
          ...(isPersonalAssistantTrigger
            ? {
                metadata: {
                  delegatedByAgentId: input.trigger.agentId,
                } as Prisma.InputJsonValue,
              }
            : {}),
          role: isPersonalAssistantTrigger ? 'system' : 'user',
          threadId: input.trigger.targetThreadId,
        },
        select: { id: true },
      })

      const run = await tx.run.create({
        data: {
          agentId: input.trigger.agentId,
          status: 'pending',
          threadId: input.trigger.targetThreadId,
          triggerDeliveryId: delivery.id,
          triggerId: input.trigger.id,
        },
        select: { id: true },
      })

      const task = await tx.task.create({
        data: {
          agentId: input.trigger.agentId,
          organizationId: executionOrigin.organizationId,
          purpose: content.slice(0, 200),
          runId: run.id,
          status: 'inbox',
        },
        select: { id: true },
      })

      await enqueueRunExecution(
        tx,
        {
          actorContext: buildActorContext({
            agentId: input.trigger.agentId,
            channelId: input.trigger.targetChannelId,
            effectiveUserId: executionOrigin.userId,
            organizationId: executionOrigin.organizationId,
            projectId: executionOrigin.projectId,
            source: input.source,
            taskId: task.id,
            teamId: executionOrigin.teamId,
            threadId: input.trigger.targetThreadId,
          }),
          agentId: parseAgentId(input.trigger.agentId),
          messageId: message.id,
          runId: parseRunId(run.id),
          taskId: parseTaskId(task.id),
          threadId: parseThreadId(input.trigger.targetThreadId),
        },
        `run:${run.id}`,
      )

      await tx.agentTriggerDelivery.update({
        where: { id: delivery.id },
        data: {
          deliveredAt: new Date(),
          status: 'delivered',
        },
      })

      await tx.agentTrigger.update({
        where: { id: input.trigger.id },
        data: {
          lastFiredAt: new Date(),
        },
      })
    })
  } catch (error) {
    if (
      input.dedupeKey &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return
    }
    // sp-webhook: persist a retryable failed delivery (outside the rolled-back
    // tx) so the retry poller can re-attempt with backoff.
    await recordDeliveryFailure(prisma, {
      dedupeKey: input.dedupeKey,
      error,
      existingDeliveryId: input.retry?.reuseDeliveryId,
      payload: normalizedPayload,
      retryCount: input.retry?.retryCount ?? 0,
      source: input.source,
      triggerId: input.trigger.id,
    })
    if (error instanceof TriggerLaunchOriginError) {
      await prisma.agentTrigger.update({
        where: { id: input.trigger.id },
        data: { status: 'error' },
      })
    }
    throw error
  }
}
