import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import { buildTriggerPrompt } from '@nessie/runtime'
import {
  prepareScheduledAgentTodoTrigger,
} from '@nessie/team-admin'
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
import { claimThreadRunOrPend, enqueueRunExecution } from '@nessie/db'
import { createSystemAuthoredMessage } from './system-authored-message.js'
import { dispatchWorkflowTrigger } from './trigger-dispatch-workflow.js'
import {
  type DispatchTriggerResult,
  isTriggerDeliveryDedupeConflict,
  loadExistingDeliveryRun,
  mapTriggerDeliveryRecord,
  mapTriggerRecord,
  normalizePayload,
  recordTriggerDeliveryFailure,
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
  // Dedupe keys share one per-trigger namespace, and the scheduler's are
  // predictable: `scheduled:<triggerId>:<next run ISO>`. A caller who supplied
  // that exact string could pre-create the delivery for a future occurrence,
  // and the sweep's existing-delivery short-circuit would then skip that run —
  // silently cancelling a schedule from a member-level endpoint. Callers only
  // ever name a key *within* their own route's namespace.
  const dedupeKey = input.dedupeKey
    ? `${input.source}:${input.dedupeKey}`
    : undefined

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
      dedupeKey,
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

  if (dedupeKey) {
    const existing = await loadExistingDeliveryRun(prisma, {
      dedupeKey,
      triggerId: input.triggerId,
    })

    if (existing) {
      return {
        kind: 'queued',
        delivery: mapTriggerDeliveryRecord({
          ...existing.delivery,
          run: existing.delivery.run,
        }),
        existing: true,
        runId: existing.runId ? parseRunId(existing.runId) : undefined,
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
  const scheduledTodo = prepareScheduledAgentTodoTrigger({
    config: trigger.config,
    triggerId: trigger.id,
  })

  try {
    const result = await prisma.$transaction(async (tx) => {
      const delivery = await tx.agentTriggerDelivery.create({
        data: {
          payload: normalizedPayload,
          dedupeKey,
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

      const message = await createSystemAuthoredMessage(tx, {
        content,
        // Follower decision: nobody. A kickoff is hidden from the feed
        // entirely, so there is no conversation here for anyone to follow —
        // the trigger fire replies top-level (see the `replyPlacement` note
        // below), and *that* reply is what a person can join.
        followedByUserIds: [],
        ...(scheduledTodo ? { metadata: scheduledTodo.metadata } : {}),
        // Internal kickoff, not a post a human made — see the matching
        // comment in `worker/src/control/trigger-run.ts`. `system` keeps the
        // row for audit and restart replay while excluding it from the
        // channel feed and later model context; the run still gets this
        // content as its prompt via `payload.messageId`, which ignores role.
        role: 'system',
        threadId: threadTarget.threadId,
      })

      // Same per-(agent, thread) claim as the worker's chat/trigger paths:
      // with a run already in flight the kickoff message pends for the batched
      // follow-up instead of spawning a concurrent run — the fire is batched,
      // not dropped. The pending row carries the trigger linkage so the drain
      // can attach it to the follow-up run.
      const claim = await claimThreadRunOrPend(tx, {
        agentId,
        threadId: threadTarget.threadId,
        pending: {
          actorContext,
          channelId: threadTarget.channelId,
          // A trigger fire is automation, never a live human turn.
          interactive: false,
          messageId: message.id,
          triggerId: trigger.id,
          triggerDeliveryId: delivery.id,
          ...(scheduledTodo ? { todoTemplateId: scheduledTodo.todoTemplateId } : {}),
        },
      })

      let run: { id: string } | null = null
      if (claim === 'claimed') {
        run = await tx.run.create({
          data: {
            agentId,
            // A trigger fire is a standalone contribution to the room, not an
            // answer owed to the kickoff. Paired with the `system` message
            // above: threading under a hidden root would drop the reply out
            // of the channel entirely.
            replyPlacement: 'channel',
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
      }

      // The fire itself is durably recorded in both outcomes: claimed (run
      // created above) or pended (pending marker + this delivered delivery;
      // the drain attaches the follow-up run).
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
      runId: result.run ? parseRunId(result.run.id) : undefined,
      trigger: mapTriggerRecord(trigger),
    }
  } catch (error) {
    if (
      dedupeKey &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      isTriggerDeliveryDedupeConflict(error)
    ) {
      const existing = await loadExistingDeliveryRun(prisma, {
        dedupeKey,
        triggerId: input.triggerId,
      })

      if (existing) {
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
          runId: existing.runId ? parseRunId(existing.runId) : undefined,
          trigger: mapTriggerRecord(latestTrigger),
        }
      }
    }

    // sp-webhook: persist a retryable failed delivery so the worker retry poller
    // can re-attempt with backoff, then surface the error to the caller.
    await recordTriggerDeliveryFailure(prisma, {
      dedupeKey,
      error,
      payload: normalizedPayload,
      source: input.source,
      triggerId: trigger.id,
    })

    throw error
  }
}
