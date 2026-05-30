import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import { buildTriggerPrompt } from '@nessie/runtime'
import {
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
  parseProjectId,
  parseRunId,
  parseTaskId,
  parseTeamId,
  parseThreadId,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import { enqueueRunExecution } from '../queue/pgqueue.js'
import { dispatchWorkflowTrigger } from './trigger-dispatch-workflow.js'
import {
  type DispatchTriggerResult,
  isTriggerDeliveryDedupeConflict,
  loadExistingDeliveryRun,
  mapTriggerDeliveryRecord,
  mapTriggerRecord,
  normalizePayload,
} from './trigger-shared.js'

export type { DispatchTriggerResult } from './trigger-shared.js'

export const dispatchAgentTrigger = async (
  prisma: PrismaClient,
  input: {
    actorContext?: AuthorizedActionContext
    dedupeKey?: string
    payload?: unknown
    prompt?: string
    source: string
    triggerId: string
  },
): Promise<DispatchTriggerResult> => {
  const loadTrigger = () =>
    prisma.agentTrigger.findUnique({
      where: { id: input.triggerId },
      include: {
        agent: {
          select: {
            id: true,
            organizationId: true,
            projectId: true,
            teamId: true,
          },
        },
        workflowInstallation: {
          select: {
            active: true,
            channelId: true,
            id: true,
            organizationId: true,
            projectId: true,
            status: true,
            teamId: true,
          },
        },
      },
    })

  const trigger = await loadTrigger()

  if (!trigger) {
    return { kind: 'rejected', reason: 'trigger_not_found' }
  }

  if (!trigger.enabled || trigger.status !== 'active') {
    return { kind: 'rejected', reason: 'trigger_paused' }
  }

  if (trigger.workflowInstallationId) {
    return dispatchWorkflowTrigger(prisma, {
      actorContext: input.actorContext,
      dedupeKey: input.dedupeKey,
      loadTrigger,
      payload: input.payload,
      prompt: input.prompt,
      source: input.source,
      trigger,
    })
  }

  if (!trigger.agentId || !trigger.agent) {
    return { kind: 'rejected', reason: 'agent_not_bound' }
  }
  const agentId = trigger.agentId
  const agent = trigger.agent

  if (!trigger.targetChannelId || !trigger.targetThreadId) {
    return { kind: 'rejected', reason: 'agent_not_bound' }
  }

  const thread = await prisma.thread.findUnique({
    where: { id: trigger.targetThreadId },
    select: {
      channelId: true,
      channel: {
        select: {
          organizationId: true,
        },
      },
      id: true,
    },
  })
  if (!thread) {
    return { kind: 'rejected', reason: 'agent_not_bound' }
  }
  if (thread.channelId !== trigger.targetChannelId) {
    return { kind: 'rejected', reason: 'agent_not_bound' }
  }

  const binding = await prisma.agentBinding.findFirst({
    where: {
      agentId,
      channelId: trigger.targetChannelId,
    },
    select: { id: true },
  })
  if (!binding) {
    return { kind: 'rejected', reason: 'agent_not_bound' }
  }

  const threadTarget = {
    channelId: trigger.targetChannelId,
    organizationId: thread.channel.organizationId,
    threadId: trigger.targetThreadId,
  }

  if (input.dedupeKey) {
    const existing = await loadExistingDeliveryRun(prisma, {
      dedupeKey: input.dedupeKey,
      triggerId: input.triggerId,
    })

    if (existing?.runId) {
      return {
        kind: 'queued',
        delivery: mapTriggerDeliveryRecord({
          ...existing.delivery,
          run: existing.delivery.run,
        }),
        existing: true,
        runId: parseRunId(existing.runId),
        trigger: mapTriggerRecord(trigger),
      }
    }
  }

  const actorContext =
    input.actorContext ??
    ({
      actor: {
        actorId: agentId,
        actorType: 'agent',
        roles: ['system'],
      },
      actionContext: {
        agentId: parseAgentId(agentId),
        channelId: parseChannelId(threadTarget.channelId),
        requestId: randomUUID(),
        sessionId: undefined,
        threadId: parseThreadId(threadTarget.threadId),
      },
      tenant: {
        organizationId: parseOrganizationId(
          agent.organizationId ?? threadTarget.organizationId,
        ),
        projectId: agent.projectId ? parseProjectId(agent.projectId) : undefined,
        teamId: agent.teamId ? parseTeamId(agent.teamId) : undefined,
      },
    })

  const normalizedPayload = normalizePayload(input.payload)
  const content = buildTriggerPrompt({
    payload: input.payload,
    prompt: input.prompt,
    source: input.source,
    triggerType: trigger.type,
  })

  try {
    const result = await prisma.$transaction(async (tx) => {
      const delivery = await tx.agentTriggerDelivery.create({
        data: {
          payload: normalizedPayload,
          dedupeKey: input.dedupeKey,
          source: input.source,
          status: 'pending',
          triggerId: trigger.id,
        },
        include: {
          run: {
            select: { id: true },
          },
        },
      })

      const message = await tx.message.create({
        data: {
          content,
          role: 'user',
          threadId: threadTarget.threadId,
        },
      })

      const run = await tx.run.create({
        data: {
          agentId,
          status: 'pending',
          threadId: threadTarget.threadId,
          triggerId: trigger.id,
          triggerDeliveryId: delivery.id,
        },
      })

      const task = await tx.task.create({
        data: {
          agentId,
          organizationId: agent.organizationId ?? threadTarget.organizationId,
          purpose: content.slice(0, 200),
          runId: run.id,
          status: 'inbox',
        },
      })

      const queuePayload = {
        actorContext: {
          ...actorContext,
          actionContext: {
            ...actorContext.actionContext,
            agentId: parseAgentId(agentId),
            channelId: parseChannelId(threadTarget.channelId),
            taskId: parseTaskId(task.id),
            threadId: parseThreadId(threadTarget.threadId),
          },
        },
        agentId: parseAgentId(agentId),
        messageId: message.id,
        runId: parseRunId(run.id),
        taskId: parseTaskId(task.id),
        threadId: parseThreadId(threadTarget.threadId),
      }

      await enqueueRunExecution(tx, queuePayload, `run:${run.id}`)

      const completedDelivery = await tx.agentTriggerDelivery.update({
        where: { id: delivery.id },
        data: {
          deliveredAt: new Date(),
          status: 'delivered',
        },
        include: {
          run: {
            select: { id: true },
          },
        },
      })

      await tx.agentTrigger.update({
        where: { id: trigger.id },
        data: {
          lastFiredAt: new Date(),
        },
      })

      return { completedDelivery, run }
    })

    return {
      kind: 'queued',
      delivery: mapTriggerDeliveryRecord(result.completedDelivery),
      existing: false,
      runId: parseRunId(result.run.id),
      trigger: mapTriggerRecord(trigger),
    }
  } catch (error) {
    if (
      input.dedupeKey &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      isTriggerDeliveryDedupeConflict(error)
    ) {
      const existing = await loadExistingDeliveryRun(prisma, {
        dedupeKey: input.dedupeKey,
        triggerId: input.triggerId,
      })

      if (existing?.runId) {
        const latestTrigger = await loadTrigger()
        if (!latestTrigger) {
          return { kind: 'rejected', reason: 'trigger_not_found' }
        }

        return {
          kind: 'queued',
          delivery: mapTriggerDeliveryRecord({
            ...existing.delivery,
            run: existing.delivery.run,
          }),
          existing: true,
          runId: parseRunId(existing.runId),
          trigger: mapTriggerRecord(latestTrigger),
        }
      }
    }

    throw error
  }
}
