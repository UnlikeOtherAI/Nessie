import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import { STRUCTURALLY_APPROVAL_GATED_TOOL_IDS } from '@nessie/runtime'
import { type AuthorizedActionContext } from '@nessie/schemas'
import { consumeToolApprovalProof } from '@nessie/team-admin'

import {
  buildSendBoundaryPrompt,
  readSendBoundaryVerdict,
  type SendBoundaryVerdict,
} from './send-boundary-judge.js'
import type { AutoReviewResult, ReviewableToolSurface } from './auto-review.js'
import type { RunContext } from './types.js'
import { emitWorkerAuditEvent } from './policy.js'
import { hashJsonValue, summarizeToolInputForTool } from '../tool-util.js'

export type ToolApprovalAuditEmitter = (
  actorContext: AuthorizedActionContext,
  input: Parameters<typeof emitWorkerAuditEvent>[2],
) => Promise<void>

export const auditToolAuthorizationDenial = async (
  emitAudit: ToolApprovalAuditEmitter,
  actorContext: AuthorizedActionContext,
  context: RunContext,
  toolName: string,
  metadata: Record<string, unknown>,
  reason: string,
): Promise<void> => {
  await emitAudit(actorContext, {
    action: 'policy.evaluated',
    metadata: {
      agentId: context.agent.id,
      runId: context.run.id,
      taskId: context.task.id,
      toolId: toolName,
      ...metadata,
    },
    outcome: 'denied',
    reason,
    resourceId: toolName,
    resourceType: 'tool',
  })
}

/** Atomically mark a verified proof spent and record the single winning claim. */
export const claimVerifiedToolApprovalProof = async (input: {
  actorContext: AuthorizedActionContext
  approval: { approvalId?: string; approvalProof?: string } | undefined
  args: Record<string, unknown>
  context: RunContext
  emitAudit: ToolApprovalAuditEmitter
  prisma: PrismaClient
  toolName: string
  verifiedApproval: { id: string; requiredApproverUserId: string | null } | null
}): Promise<boolean> => {
  const { actorContext, approval, args, context, emitAudit, prisma, toolName, verifiedApproval } = input
  if (
    !verifiedApproval
    || !approval?.approvalId
    || !approval.approvalProof
    || !await consumeToolApprovalProof(prisma, {
      approvalId: verifiedApproval.id,
      argsHash: hashJsonValue(args),
      continuationRunId: context.run.id,
      organizationId: context.channel.organizationId,
      proof: approval.approvalProof,
      toolName,
    })
  ) return false

  await emitAudit(actorContext, {
    action: 'policy.evaluated',
    metadata: {
      agentId: context.agent.id,
      approvalId: verifiedApproval.id,
      approvalProofClaimed: true,
      continuationRunId: context.run.id,
      runId: context.run.id,
      taskId: context.task.id,
      toolId: toolName,
    },
    outcome: 'success',
    resourceId: toolName,
    resourceType: 'tool',
  })
  return true
}

/** One bounded decision against a mailbox owner's standing boundary. */
export const judgeAgainstSendBoundary = async (input: {
  args: Record<string, unknown>
  boundary: string
  runUtility?: (prompt: string) => Promise<string | null>
  toolName: string
}): Promise<SendBoundaryVerdict> => {
  if (!input.runUtility) {
    return { verdict: 'ask', reason: 'I could not check this against your note.' }
  }
  try {
    const raw = await input.runUtility(buildSendBoundaryPrompt({
      boundary: input.boundary,
      proposal: `${input.toolName} with ${summarizeToolInputForTool(input.toolName, input.args)}`,
      request: 'See the conversation this action came from.',
    }))
    return readSendBoundaryVerdict(raw)
  } catch {
    return { verdict: 'ask', reason: 'I could not check this against your note.' }
  }
}

export const runAutoReview = async (
  reviewProposedAction: ((input: {
    args: Record<string, unknown>
    surface: ReviewableToolSurface
    toolName: string
  }) => Promise<AutoReviewResult>) | undefined,
  input: { args: Record<string, unknown>; surface: ReviewableToolSurface; toolName: string },
): Promise<AutoReviewResult> => {
  if (!reviewProposedAction) {
    return {
      reason: 'The automated reviewer was unavailable, so a human must decide.',
      reviewerModel: null,
      verdict: 'require_approval',
    }
  }
  try {
    return await reviewProposedAction(input)
  } catch {
    return {
      reason: 'The automated reviewer was unavailable, so a human must decide.',
      reviewerModel: null,
      verdict: 'require_approval',
    }
  }
}

export const recordAutoReview = async (
  prisma: PrismaClient,
  emitAudit: ToolApprovalAuditEmitter,
  actorContext: AuthorizedActionContext,
  context: RunContext,
  toolName: string,
  surface: ReviewableToolSurface,
  review: AutoReviewResult,
): Promise<void> => {
  await prisma.taskEvent.create({
    data: {
      eventType: 'tool.auto_reviewed',
      payload: { surface, toolName, verdict: review.verdict },
      taskId: context.task.id,
    },
  })
  await emitAudit(actorContext, {
    action: 'policy.evaluated',
    metadata: {
      agentId: context.agent.id,
      autoReview: { reviewerModel: review.reviewerModel, verdict: review.verdict },
      runId: context.run.id,
      surface,
      taskId: context.task.id,
      toolId: toolName,
    },
    outcome: review.verdict === 'deny' ? 'denied' : 'success',
    ...(review.verdict === 'deny' ? { reason: 'auto_review_denied' } : {}),
    resourceId: toolName,
    resourceType: 'tool',
  })
}

/** Addresses never travel to an ApprovalRequest: counts and ids are enough. */
export const describeGatedAction = (
  toolName: string,
  args: Record<string, unknown>,
): { headline: string; audience: string } => {
  const guests = Array.isArray(args.attendees) ? args.attendees.length : 0
  const guestLine = guests > 0
    ? `${guests} ${guests === 1 ? 'guest' : 'guests'} will be emailed`
    : 'Nobody outside is contacted'
  const title = typeof args.title === 'string' ? args.title : null
  if (toolName === 'calendar_event_create') return {
    headline: title ? `Create “${title}”` : 'Create a calendar event', audience: guestLine,
  }
  if (toolName === 'calendar_event_update') return {
    headline: title ? `Change “${title}”` : 'Change a calendar event',
    audience: guests > 0 ? guestLine : 'Guests on the event will be told',
  }
  if (toolName === 'calendar_event_cancel') return {
    headline: 'Cancel a calendar event', audience: 'Guests on the event will be told it is cancelled',
  }
  if (toolName === 'gmail_draft_send') return {
    headline: 'Send an email as you', audience: 'The recipients will receive it',
  }
  if (toolName === 'mailbox_send') {
    const recipients = Array.isArray(args.to) ? args.to.length : 0
    return {
      audience: recipients > 0
        ? `${recipients} ${recipients === 1 ? 'recipient' : 'recipients'} will receive it`
        : 'The recipients will receive it',
      headline: 'Send an email from a connected mailbox',
    }
  }
  if (toolName === 'email_send') {
    return {
      audience: 'The recipients will receive it',
      headline: 'Send an email from the agent mailbox',
    }
  }
  if (toolName === 'email_account_disconnect') {
    const accountKind = args.accountKind === 'mailbox' ? 'IMAP/SMTP mailbox' : 'provider account'
    const accountId = typeof args.accountId === 'string' ? args.accountId : ''
    const suffix = accountId.length >= 8 ? ` …${accountId.slice(-8)}` : ''
    return {
      audience: 'Its connection credentials will be removed',
      headline: `Disconnect ${accountKind}${suffix}`,
    }
  }
  return { headline: `Run ${toolName}`, audience: 'This acts on your account' }
}

export const postAllowedByRuleCard = async (
  prisma: PrismaClient,
  context: RunContext,
  actorContext: AuthorizedActionContext,
  input: { args: Record<string, unknown>; rule: string | null; toolName: string },
): Promise<void> => {
  const actingUserId = actorContext.actionContext.effectiveUserId
  if (!actingUserId) return
  const described = describeGatedAction(input.toolName, input.args)
  try {
    context.consumedSources?.add({ scopeType: 'user', scopeId: actingUserId })
    await prisma.message.create({
      data: {
        agentId: context.agent.id,
        content: described.headline,
        metadata: { card: {
          audience: described.audience,
          details: summarizeToolInputForTool(input.toolName, input.args),
          headline: described.headline,
          kind: 'allowed_by_rule',
          rule: input.rule,
        } } as Prisma.InputJsonValue,
        role: 'assistant',
        threadId: context.run.threadId,
      },
    })
  } catch (error) {
    console.error('[worker.allowed-by-rule] could not post receipt', error)
  }
}

const DEFAULT_APPROVAL_EXPIRY_MS = 30 * 60 * 1000
const MAILBOX_APPROVAL_EXPIRY_MS = 24 * 60 * 60 * 1000

/**
 * A send proposal's exact correspondence belongs only in its frozen resume
 * state. The review route materializes that state for the required approver;
 * public approval context must not retain even an argument summary for it.
 */
const hasPrivateEmailProposal = (toolName: string): boolean =>
  toolName === 'email_send' || toolName === 'gmail_draft_send' || toolName === 'mailbox_send'

const approvalExpiryFor = (toolName: string): number =>
  STRUCTURALLY_APPROVAL_GATED_TOOL_IDS.has(toolName)
    ? MAILBOX_APPROVAL_EXPIRY_MS
    : DEFAULT_APPROVAL_EXPIRY_MS

export const createToolApprovalRequest = async (
  prisma: PrismaClient,
  input: {
    actorContext: AuthorizedActionContext
    approvalActionType?: string
    args: Record<string, unknown>
    boundaryReason?: string
    context: RunContext
    contextExtra?: Record<string, unknown>
    interactive: boolean
    messageId: string
    policyRuleId?: string
    reason?: string
    requiredApproverUserId?: string | null
    toolCallId: string
    toolName: string
  },
): Promise<{ id: string; requiredApproverUserId: string | null }> => {
  const argsHash = hashJsonValue(input.args)
  const existing = await prisma.approvalRequest.findFirst({
    where: { runId: input.context.run.id, toolCallId: input.toolCallId },
    select: { argsHash: true, id: true, requiredApproverUserId: true, toolName: true },
  })
  if (existing) {
    if (existing.argsHash !== argsHash || existing.toolName !== input.toolName) {
      throw new Error('A tool-call id was reused with a different action or arguments.')
    }
    return { id: existing.id, requiredApproverUserId: existing.requiredApproverUserId }
  }
  const data = {
    action: 'tool.invoke',
    agentId: input.context.agent.id,
    argsHash,
    channelId: input.context.channel.id,
    context: {
      approvalActionType: input.approvalActionType ?? null,
      boundaryReason: hasPrivateEmailProposal(input.toolName)
        ? null
        : input.boundaryReason ?? null,
      policyRuleId: input.policyRuleId ?? null,
      toolName: input.toolName,
      ...describeGatedAction(input.toolName, input.args),
      ...(!hasPrivateEmailProposal(input.toolName)
        ? { inputSummary: summarizeToolInputForTool(input.toolName, input.args) }
        : {}),
      ...(input.contextExtra ?? {}),
    } as Prisma.InputJsonValue,
    continuationToken: randomUUID(),
    expiresAt: new Date(Date.now() + approvalExpiryFor(input.toolName)),
    organizationId: input.context.channel.organizationId,
    projectId: input.context.channel.projectId,
    reason: hasPrivateEmailProposal(input.toolName)
      ? 'Review the email before deciding whether to send it.'
      : input.reason ?? `Tool ${input.toolName} requires approval before it can run.`,
    requesterId: input.context.agent.id,
    requiredApproverUserId: STRUCTURALLY_APPROVAL_GATED_TOOL_IDS.has(input.toolName)
      ? input.requiredApproverUserId
        ?? input.actorContext.actionContext.effectiveUserId
        ?? (input.actorContext.actor.actorType === 'user'
          ? input.actorContext.actor.actorId
          : null)
      : null,
    resumeState: {
      actorContext: input.actorContext,
      args: input.args,
      interactive: input.interactive,
      messageId: input.messageId,
    } as Prisma.InputJsonValue,
    runId: input.context.run.id,
    taskId: input.context.task.id,
    teamId: input.context.channel.teamId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
  }
  try {
    return await prisma.approvalRequest.create({
      data,
      select: { id: true, requiredApproverUserId: true },
    })
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
    const raced = await prisma.approvalRequest.findFirst({
      where: { runId: input.context.run.id, toolCallId: input.toolCallId },
      select: { argsHash: true, id: true, requiredApproverUserId: true, toolName: true },
    })
    if (!raced) throw error
    if (raced.argsHash !== argsHash || raced.toolName !== input.toolName) {
      throw new Error('A tool-call id was reused with a different action or arguments.')
    }
    return { id: raced.id, requiredApproverUserId: raced.requiredApproverUserId }
  }
}
