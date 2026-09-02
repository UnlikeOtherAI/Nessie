import { Prisma } from '@prisma/client'
import { parseAgentId, type RunExecuteJobPayload } from '@nessie/schemas'
import type { InvocationRecord } from '@nessie/runtime'

import {
  applySuspendedState,
  persistSuspensionCheckpoint,
  postSuspensionNotice,
} from './run-suspend.js'
import { buildScopes } from './scopes.js'
import { generateCheckpointNote } from './run-stop.js'
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
  const checkpointId = await persistSuspensionCheckpoint(deps, context, {
    eventPayload: { approvalId: input.approval.id, toolName: input.approval.toolName },
    goal: input.goal,
    inference: input.inference,
    invocationSink: input.invocationSink,
    lastAssistantText: input.lastAssistantText,
    messages: input.messages,
    priorGeneration: input.priorGeneration,
    reason: 'approval_required',
  })
  return {
    approvalId: input.approval.id,
    checkpointId,
    notice: `⚠️ I need approval before I can run ${input.approval.toolName}.`,
    toolName: input.approval.toolName,
  }
}

/**
 * Suspend the run rather than terminalizing it. `waiting_approval` deliberately
 * keeps the thread slot and working marker held until an approval exit chooses
 * the next run.
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
  const content = input.responseText.trim()
    ? `${input.responseText}\n\n${input.notice}`
    : input.notice
  await postSuspensionNotice(deps, context, {
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
  })
  await applySuspendedState(deps, payload, context, {
    agentStatus: 'waiting_approval',
    invocations: input.invocations,
    runStatus: 'waiting_approval',
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
