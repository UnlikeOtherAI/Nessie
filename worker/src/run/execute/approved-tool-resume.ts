import type { PrismaClient } from '@prisma/client'
import {
  attributionFromActorContext,
  GMAIL_DRAFT_SEND_TOOL_ID,
  recordConnectorUsage,
  type InvocationRecord,
} from '@nessie/runtime'
import {
  ToolApprovalResumeStateSchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { hashJsonValue } from '../tool-util.js'
import type { AgenticToolResult, ToolExecutionUsage } from '../tool-types.js'
import type { LoopResult } from '../agentic-loop.js'
import type { ToolAuthorizationDecision } from './tool-authorization-contract.js'
import type { RunContext } from './types.js'

/**
 * The only worker-facing view of an approved tool checkpoint. The frozen
 * arguments never enter a prompt, checkpoint, event, audit row, or queue
 * payload: the API queues only the opaque approval id and proof, and this
 * resolver reads the protected row immediately before dispatch.
 */
export type FrozenApprovedToolCall = {
  args: Record<string, unknown>
  toolCallId: string
  toolName: string
}

const FROZEN_EMAIL_TOOL_IDS = new Set([
  GMAIL_DRAFT_SEND_TOOL_ID,
  'mailbox_send',
])

export type FrozenApprovedToolOutcome =
  | { kind: 'unavailable' }
  | { durationMs: number; kind: 'denied' }
  | { durationMs: number; kind: 'dispatch_failed' }
  | { durationMs: number; kind: 'dispatched'; result: AgenticToolResult }

const approvalLoopResult = (input: {
  durationMs: number
  finalText: string
  invocationSink: InvocationRecord[]
  toolCallsUsed: number
}): LoopResult => ({
  cacheReadTokens: 0,
  cancelled: false,
  effectiveTokensUsed: 0,
  exhaustedBudget: null,
  finalText: input.finalText,
  invocations: input.invocationSink,
  iterations: 0,
  messages: [],
  pendingApproval: null,
  pendingInput: null,
  toolCallsUsed: input.toolCallsUsed,
  toolMs: input.durationMs,
  totalCostCents: 0,
  totalTokensUsed: 0,
  wallclockMs: input.durationMs,
  woundDown: false,
})

/** Persist only a content-free outcome for a sealed approved action. */
export const recordFrozenApprovedToolOutcome = async (
  prisma: PrismaClient,
  input: {
    actorContext: AuthorizedActionContext
    connectorUsage?: ToolExecutionUsage
    context: RunContext
    durationMs: number
    success: boolean
    toolName: string
  },
): Promise<void> => {
  const now = new Date()
  await prisma.toolCall.create({
    data: {
      agentId: input.context.agent.id,
      durationMs: input.durationMs,
      endedAt: now,
      inputSummary: 'Approved server-owned action',
      outputPreview: input.success
        ? 'Completed approved action.'
        : 'Approved action could not be completed.',
      runId: input.context.run.id,
      startedAt: new Date(now.getTime() - input.durationMs),
      success: input.success,
      toolName: input.toolName,
    },
  })
  if (!input.connectorUsage) return

  // A connection id, host, address, target, or provider metadata may reveal a
  // frozen argument or message context. Operational usage keeps only the
  // content-free aggregate dimensions.
  await recordConnectorUsage(prisma, {
    attribution: attributionFromActorContext(input.actorContext, {
      agentId: input.context.agent.id,
      runId: input.context.run.id,
    }),
    event: {
      calls: input.connectorUsage.calls,
      connectorType: input.connectorUsage.connectorType,
      costAmount: input.connectorUsage.costAmount,
      costCurrency: input.connectorUsage.costCurrency,
      latencyMs: input.durationMs,
      operation: input.toolName,
      success: input.success,
      unitType: input.connectorUsage.unitType,
      units: input.connectorUsage.units,
    },
  })
}

/**
 * Resolve the exact server-owned action an approval continuation may perform.
 *
 * The proof is deliberately checked again here even though the authorization
 * gate will verify and atomically claim it later. This prevents a continuation
 * from ever falling back to model-planned work when its opaque handle is stale,
 * replayed, cross-run, or malformed.
 */
export const loadFrozenApprovedToolCall = async (
  prisma: PrismaClient,
  input: {
    actorContext: AuthorizedActionContext
    context: RunContext
  },
): Promise<FrozenApprovedToolCall | null> => {
  const approvalHandle = input.actorContext.approval
  if (!approvalHandle?.approvalId || !approvalHandle.approvalProof) return null

  const approval = await prisma.approvalRequest.findFirst({
    where: {
      action: 'tool.invoke',
      continuationToken: approvalHandle.approvalProof,
      id: approvalHandle.approvalId,
      organizationId: input.context.channel.organizationId,
      proofConsumedAt: null,
      status: 'approved',
    },
    select: {
      argsHash: true,
      resumeState: true,
      runId: true,
      toolCallId: true,
      toolName: true,
    },
  })
  if (!approval?.runId || !approval.toolCallId || !approval.toolName) return null

  const resumeState = ToolApprovalResumeStateSchema.safeParse(approval.resumeState)
  if (
    !resumeState.success
    || resumeState.data.actorContext.tenant.organizationId !== input.context.channel.organizationId
    || hashJsonValue(resumeState.data.args) !== approval.argsHash
  ) return null

  const continuation = await prisma.run.findUnique({
    where: { id: input.context.run.id },
    select: { continuationOfRunId: true },
  })
  if (continuation?.continuationOfRunId !== approval.runId) return null

  // The Gmail content fingerprint proves the original draft was unchanged,
  // but it was added by the server and is not part of the model-facing input
  // schema. Final authorization re-reads and binds the current fingerprint.
  const args = approval.toolName === GMAIL_DRAFT_SEND_TOOL_ID
    ? Object.fromEntries(
      Object.entries(resumeState.data.args).filter(([key]) => key !== 'approvalFingerprint'),
    )
    : resumeState.data.args
  return {
    args,
    toolCallId: approval.toolCallId,
    toolName: approval.toolName,
  }
}

/** Does this opaque approval belong to an email action with frozen content? */
export const isFrozenEmailToolApproval = async (
  prisma: PrismaClient,
  input: { actorContext: AuthorizedActionContext; organizationId: string },
): Promise<boolean> => {
  const approvalId = input.actorContext.approval?.approvalId
  if (!approvalId) return false
  const approval = await prisma.approvalRequest.findFirst({
    where: {
      action: 'tool.invoke',
      id: approvalId,
      organizationId: input.organizationId,
      status: 'approved',
    },
    select: { toolName: true },
  })
  return Boolean(approval?.toolName && FROZEN_EMAIL_TOOL_IDS.has(approval.toolName))
}

/** Return null for every ordinary approval continuation. */
export const resumeApprovedEmailContinuation = async (input: {
  actorContext: AuthorizedActionContext
  authorize: (call: FrozenApprovedToolCall) => Promise<ToolAuthorizationDecision>
  context: RunContext
  dispatch: (
    call: FrozenApprovedToolCall,
    authorization: Extract<ToolAuthorizationDecision, { decision: 'allow' }>,
  ) => Promise<AgenticToolResult>
  invocationSink: InvocationRecord[]
  prisma: PrismaClient
}): Promise<LoopResult | null> => {
  if (!await isFrozenEmailToolApproval(input.prisma, {
    actorContext: input.actorContext,
    organizationId: input.context.channel.organizationId,
  })) return null
  return resumeFrozenApprovedTool(input)
}

/**
 * Dispatch one sealed action without giving its arguments to an inference
 * turn. The caller supplies the ordinary authorization and tool dispatch
 * seams, so this path cannot skip their live checks or proof claim.
 */
export const executeFrozenApprovedTool = async (input: {
  actorContext: AuthorizedActionContext
  authorize: (call: FrozenApprovedToolCall) => Promise<ToolAuthorizationDecision>
  context: RunContext
  dispatch: (
    call: FrozenApprovedToolCall,
    authorization: Extract<ToolAuthorizationDecision, { decision: 'allow' }>,
  ) => Promise<AgenticToolResult>
  prisma: PrismaClient
}): Promise<FrozenApprovedToolOutcome> => {
  const frozenCall = await loadFrozenApprovedToolCall(input.prisma, {
    actorContext: input.actorContext,
    context: input.context,
  })
  if (!frozenCall) return { kind: 'unavailable' }

  const startedAt = Date.now()
  const authorization = await input.authorize(frozenCall)
  if (authorization.decision !== 'allow') {
    return { durationMs: Date.now() - startedAt, kind: 'denied' }
  }

  let result: AgenticToolResult | null
  try {
    result = await input.dispatch(frozenCall, authorization)
  } catch {
    result = null
  }
  const durationMs = Date.now() - startedAt
  try {
    await recordFrozenApprovedToolOutcome(input.prisma, {
      actorContext: input.actorContext,
      ...(result?.connectorUsage ? { connectorUsage: result.connectorUsage } : {}),
      context: input.context,
      durationMs,
      success: result?.success ?? false,
      toolName: frozenCall.toolName,
    })
  } catch {
    // The proof claim remains the durable authority after an action crossed
    // its provider boundary. Never turn a telemetry failure into a retryable
    // send, and never log frozen arguments or provider text.
    console.error('[worker.approval-resume] could not record approved-action outcome')
  }
  if (!result) return { durationMs, kind: 'dispatch_failed' }
  return { durationMs, kind: 'dispatched', result }
}

/** Run the sealed action's full continuation without ever starting inference. */
export const resumeFrozenApprovedTool = async (input: {
  actorContext: AuthorizedActionContext
  authorize: (call: FrozenApprovedToolCall) => Promise<ToolAuthorizationDecision>
  context: RunContext
  dispatch: (
    call: FrozenApprovedToolCall,
    authorization: Extract<ToolAuthorizationDecision, { decision: 'allow' }>,
  ) => Promise<AgenticToolResult>
  invocationSink: InvocationRecord[]
  prisma: PrismaClient
}): Promise<LoopResult> => {
  const outcome = await executeFrozenApprovedTool(input)
  if (outcome.kind === 'unavailable') {
    return approvalLoopResult({
      durationMs: 0,
      finalText: 'The approved action is no longer available. Please ask me to prepare it again.',
      invocationSink: input.invocationSink,
      toolCallsUsed: 0,
    })
  }
  if (outcome.kind === 'denied') {
    return approvalLoopResult({
      durationMs: outcome.durationMs,
      finalText: 'The approved action is no longer allowed. Please ask me to prepare it again.',
      invocationSink: input.invocationSink,
      toolCallsUsed: 0,
    })
  }
  if (outcome.kind === 'dispatch_failed') {
    return approvalLoopResult({
      durationMs: outcome.durationMs,
      finalText: 'The approved action could not be completed. Please ask me to prepare it again.',
      invocationSink: input.invocationSink,
      toolCallsUsed: 1,
    })
  }
  return approvalLoopResult({
    durationMs: outcome.durationMs,
    finalText: outcome.result.success
      ? 'The approved action was completed.'
      : 'The approved action could not be completed. Please ask me to prepare it again.',
    invocationSink: input.invocationSink,
    toolCallsUsed: 1,
  })
}
