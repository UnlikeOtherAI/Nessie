import type { PrismaClient } from '@prisma/client'
import { bindExecutorCandidateBundleInTransaction } from '@nessie/executor-manage'
import { enqueueRunExecution, isThreadRunSlotBusy } from '@nessie/db'
import { followReplyThread } from '@nessie/runtime'
import {
  parseAgentId,
  parseChannelId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  withActionContext,
  type AuthorizedActionContext,
  type ImplementedExecutorOperationKey,
} from '@nessie/schemas'

import { mapMessageRecord, messageInclude } from './messages.js'

export type ExecutorRunLaunchResult =
  | { kind: 'agent_unavailable' }
  | { kind: 'thread_busy' }
  | { kind: 'thread_not_found' }
  | {
    kind: 'launched'
    agentId: string
    bindings: Array<{
      bindingId: string
      capabilityRevision: number
      fence: string
      operationKey: ImplementedExecutorOperationKey
      runId: string
    }>
    channelId: string
    message: ReturnType<typeof mapMessageRecord>
    runId: string
    taskId: string
  }

/**
 * A direct human launch is intentionally separate from normal message
 * orchestration: the target agent and opaque availability choice are explicit,
 * so the message, run, binding, task, and queue job can commit together.
 */
export const launchExecutorRun = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: {
    agentId: string
    candidateHandle: string
    content: string
    operationKeys: ImplementedExecutorOperationKey[]
    threadId: string
  },
): Promise<ExecutorRunLaunchResult> => {
  return prisma.$transaction(async (tx) => {
    const thread = await tx.thread.findFirst({
      where: {
        id: input.threadId,
        channel: {
          organizationId: actorContext.tenant.organizationId,
          OR: [{ visibility: 'public' }, { members: { some: { userId: actorContext.actor.actorId } } }],
        },
      },
      select: { channel: { select: { id: true } }, id: true },
    })
    if (!thread) return { kind: 'thread_not_found' as const }

    const agent = await tx.agent.findFirst({
      where: {
        id: input.agentId,
        organizationId: actorContext.tenant.organizationId,
        bindings: { some: { channelId: thread.channel.id } },
      },
      select: { id: true },
    })
    if (!agent) return { kind: 'agent_unavailable' as const }
    if (await isThreadRunSlotBusy(tx, { agentId: agent.id, threadId: thread.id })) {
      return { kind: 'thread_busy' as const }
    }

    const message = await tx.message.create({
      data: {
        content: input.content,
        metadata: { executorLaunch: { operationKeys: input.operationKeys } },
        role: 'user',
        threadId: thread.id,
        userId: actorContext.actor.actorId,
      },
      include: messageInclude,
    })
    await followReplyThread(tx, { rootMessageId: message.id, userIds: [actorContext.actor.actorId] })
    const run = await tx.run.create({
      data: {
        agentId: agent.id,
        status: 'pending',
        threadId: thread.id,
        triggerMessageId: message.id,
      },
      select: { id: true },
    })
    const task = await tx.task.create({
      data: {
        agentId: agent.id,
        organizationId: actorContext.tenant.organizationId,
        purpose: input.content.slice(0, 200),
        runId: run.id,
        status: 'inbox',
      },
      select: { id: true },
    })
    const bindings = await bindExecutorCandidateBundleInTransaction(tx, {
      actorUserId: actorContext.actor.actorId,
      candidateHandle: input.candidateHandle,
      operationKeys: input.operationKeys,
      runId: run.id,
    })
    const isBrowserRun = input.operationKeys.includes('browser.open')
    const isCodingRun = input.operationKeys.includes('coding.launch')
    if (isBrowserRun || isCodingRun) {
      const executorId = bindings[0]?.executorId
      if (!executorId || bindings.some((binding) => binding.executorId !== executorId)) {
        throw new Error('Isolated executor bundle must bind one executor.')
      }
      const session = await tx.executorSession.create({
        data: {
          executorId,
          profile: isCodingRun ? 'coding_session' : 'workspace_sandbox',
          runId: run.id,
        },
        select: { id: true },
      })
      await tx.executorBinding.updateMany({
        where: { id: { in: bindings.map((binding) => binding.bindingId) } },
        data: { sessionId: session.id },
      })
    }
    const queued = await enqueueRunExecution(
      tx,
      {
        actorContext: withActionContext(actorContext, {
          agentId: parseAgentId(agent.id),
          channelId: parseChannelId(thread.channel.id),
          taskId: parseTaskId(task.id),
          threadId: parseThreadId(thread.id),
        }),
        agentId: parseAgentId(agent.id),
        interactive: true,
        messageId: message.id,
        runId: parseRunId(run.id),
        taskId: parseTaskId(task.id),
        threadId: parseThreadId(thread.id),
      },
      `run:${message.id}:${agent.id}`,
    )
    if (!queued) throw new Error('Executor run enqueue conflict')

    return {
      agentId: agent.id,
      bindings: bindings.map((binding) => ({
        bindingId: binding.bindingId,
        capabilityRevision: binding.capabilityRevision,
        fence: binding.fence,
        operationKey: binding.operationKey,
        runId: binding.runId,
      })),
      channelId: thread.channel.id,
      kind: 'launched' as const,
      message: mapMessageRecord(message, 0),
      runId: run.id,
      taskId: task.id,
    }
  })
}
