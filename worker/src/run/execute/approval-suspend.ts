import { Prisma } from '@prisma/client'
import { parseAgentId, parseRunId, parseTaskId, type RunExecuteJobPayload } from '@nessie/schemas'
import type { InvocationRecord } from '@nessie/runtime'
import { persistInvocationLedgerEvents } from '../inference.js'
import { createAgentMessage, runReplyBasis } from './agent-message.js'
import { persistRunCheckpoint } from './checkpoint.js'
import { applyRunReplyBookkeeping, setAgentStatus, updateRunStatus, updateTaskStatus } from './lifecycle.js'
import { publishAgentStatus, publishMessageCreated, publishRunUpdated, publishTaskUpdated } from './realtime.js'
import { generateCheckpointNote } from './run-stop.js'
import { buildScopes } from './scopes.js'
import type { RunInference } from './run-inference.js'
import type { ExecutionDependencies, RunContext } from './types.js'

export type ApprovalSuspendPlan = {
  approvalId: string
  checkpointId: string
  notice: string
  toolName: string
}

/**
 * Persist the same checkpoint shape budget stops use, but classify it as an
 * approval gate. The model-authored note remains untrusted; the exact tool
 * call and original actor identity are server-authored on ApprovalRequest.
 */
export const prepareApprovalSuspend = async (
  deps: ExecutionDependencies,
  context: RunContext,
  input: {
    approval: { id: string; toolName: string }
    goal: string
    inference: RunInference
    invocationSink: InvocationRecord[]
    lastAssistantText: string
    messages: Parameters<typeof generateCheckpointNote>[2]['messages']
    priorGeneration: number
  },
): Promise<ApprovalSuspendPlan> => {
  const { note, sources } = await generateCheckpointNote(input.inference, input.invocationSink, {
    goal: input.goal,
    lastAssistantText: input.lastAssistantText,
    messages: input.messages,
  })
  const checkpointId = await persistRunCheckpoint(deps.prisma, {
    agentId: context.agent.id,
    basis: runReplyBasis(context),
    generation: input.priorGeneration + 1,
    note,
    organizationId: context.channel.organizationId,
    reason: 'approval_required',
    rootMessageId: context.replyRootMessageId ?? null,
    runId: context.run.id,
    sources,
    taskId: context.task.id,
    threadId: context.run.threadId,
  })
  await deps.prisma.taskEvent.create({
    data: {
      eventType: 'run.suspended',
      payload: {
        approvalId: input.approval.id,
        checkpointId,
        reason: 'approval_required',
        runId: context.run.id,
        toolName: input.approval.toolName,
      },
      taskId: parseTaskId(context.task.id),
    },
  })
  return {
    approvalId: input.approval.id,
    checkpointId,
    notice: `⚠️ I need approval before I can run ${input.approval.toolName}.`,
    toolName: input.approval.toolName,
  }
}

/**
 * Deliver a basis-stamped approval card and transition the run without
 * terminalizing it. `waiting_approval` deliberately keeps the thread slot and
 * working marker held until an approval exit chooses the next run.
 */
export const suspendRunForApproval = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  input: ApprovalSuspendPlan & {
    invocations: InvocationRecord[]
    responseText: string
  },
): Promise<void> => {
  await persistInvocationLedgerEvents(deps.prisma, {
    actorContext: payload.actorContext,
    agentId: context.agent.id,
    invocations: input.invocations,
    runId: context.run.id,
  })

  const content = input.responseText.trim()
    ? `${input.responseText}\n\n${input.notice}`
    : input.notice
  const message = await createAgentMessage(deps.prisma, context, {
    agentId: context.agent.id,
    content,
    metadata: {
      approvalGate: {
        approvalId: input.approvalId,
        checkpointId: input.checkpointId,
        runId: context.run.id,
        status: 'pending',
        toolName: input.toolName,
      },
    } as Prisma.InputJsonValue,
    role: 'assistant',
    threadId: context.run.threadId,
    ...(context.replyRootMessageId ? { rootMessageId: context.replyRootMessageId } : {}),
  })
  const reply = context.replyRootMessageId
    ? await applyRunReplyBookkeeping(deps.prisma, context, message.createdAt)
    : undefined
  const restricted = message.basis.length > 0
  await publishMessageCreated(deps.realtimeTransport, context, {
    content: message.content,
    messageId: message.id,
    role: message.role,
    ...(restricted ? { restricted: true } : {}),
    ...(reply ? { reply } : {}),
  })
  await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.done', {
    agentId: parseAgentId(context.agent.id),
    content: restricted ? '' : message.content,
    createdAt: message.createdAt.toISOString(),
    messageId: message.id,
    runId: parseRunId(context.run.id),
    ...(restricted ? { restricted: true } : {}),
    ...(context.replyRootMessageId ? { rootMessageId: context.replyRootMessageId } : {}),
  })

  await updateRunStatus(deps.prisma, context.run.id, 'waiting_approval')
  await updateTaskStatus(deps.prisma, context.task.id, 'awaiting_approval')
  await setAgentStatus(deps.prisma, context.agent.id, 'waiting_approval')
  await publishRunUpdated(deps.realtimeTransport, context, 'waiting_approval')
  await publishTaskUpdated(
    deps.realtimeTransport,
    buildScopes(context),
    context.task.id,
    'awaiting_approval',
  )
  await publishAgentStatus(deps.realtimeTransport, context, {
    currentRunId: context.run.id,
    status: 'waiting_approval',
  })
  await deps.realtimeTransport.publishWs(buildScopes(context), {
    data: {
      action: 'tool.invoke',
      agentId: parseAgentId(context.agent.id),
      approvalId: input.approvalId,
      reason: input.notice,
      taskId: context.task.id,
    },
    event: 'approval.needed',
  })
}
