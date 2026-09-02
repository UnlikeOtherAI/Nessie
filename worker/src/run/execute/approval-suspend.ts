import { Prisma } from '@prisma/client'
import { STRUCTURALLY_APPROVAL_GATED_TOOL_IDS } from '@nessie/runtime'
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
    approval: { id: string; notice: string; toolName: string }
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
    notice: input.approval.notice,
    toolName: input.approval.toolName,
  }
}

/**
 * Suspend the run rather than terminalizing it. `waiting_approval` deliberately
 * keeps the thread slot and working marker held until an approval exit chooses
 * the next run.
 */
/**
 * One durable alert per approval, for the exact person who must resolve it.
 *
 * Best-effort: a failed alert must never lose the suspension itself, which is
 * the part that keeps the action from happening. Uniqueness comes from the
 * existing `(user_id, event_key)` constraint, so a redelivered job cannot
 * double-alert.
 */
const raiseApprovalAlert = async (
  deps: ExecutionDependencies,
  input: {
    approvalId: string
    channelId: string
    organizationId: string
    toolName: string
    userId: string | null
  },
): Promise<void> => {
  if (!input.userId) return
  if (!STRUCTURALLY_APPROVAL_GATED_TOOL_IDS.has(input.toolName)) return
  try {
    await deps.prisma.userAlert.create({
      data: {
        approvalRequestId: input.approvalId,
        channelId: input.channelId,
        eventKey: `approval:${input.approvalId}`,
        kind: 'approval_requested',
        organizationId: input.organizationId,
        userId: input.userId,
      },
    })
  } catch (error) {
    console.error('[worker.approval-alert] could not raise alert', input.approvalId, error)
  }
}

export const suspendRunForApproval = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  input: ApprovalSuspendPlan & {
    invocations: InvocationRecord[]
    responseText: string
  },
): Promise<void> => {
  // A suspension notice for a mailbox action must carry the acting person's
  // basis explicitly. The gate fires BEFORE the handler runs, so nothing has
  // fed the run's consumed-source sink yet — and an empty basis means
  // unrestricted, which would post "your assistant wants to send an email" and
  // the approval affordance into whatever room the run is answering in.
  if (STRUCTURALLY_APPROVAL_GATED_TOOL_IDS.has(input.toolName)) {
    const actingUserId = payload.actorContext.actionContext.effectiveUserId
    if (actingUserId) {
      context.consumedSources?.add({ scopeType: 'user', scopeId: actingUserId })
    }
  }

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
  // The card is only seen by somebody already looking at the thread. A mailbox
  // approval raised by a schedule at 06:00 needs the bell, or it expires
  // unseen — the failure the plan named and the reason this is durable rather
  // than push-only.
  await raiseApprovalAlert(deps, {
    approvalId: input.approvalId,
    channelId: context.channel.id,
    organizationId: context.channel.organizationId,
    toolName: input.toolName,
    userId: payload.actorContext.actionContext.effectiveUserId ?? null,
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
