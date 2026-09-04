import { randomUUID } from 'node:crypto'

import { STRUCTURALLY_APPROVAL_GATED_TOOL_IDS } from '@nessie/runtime'
import { Prisma, type PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { hashJsonValue, summarizeToolInput } from '../tool-util.js'
import type { RunContext } from './types.js'

const DEFAULT_APPROVAL_EXPIRY_MS = 30 * 60 * 1000
const MAILBOX_APPROVAL_EXPIRY_MS = 24 * 60 * 60 * 1000

const approvalExpiryFor = (toolName: string): number =>
  STRUCTURALLY_APPROVAL_GATED_TOOL_IDS.has(toolName)
    ? MAILBOX_APPROVAL_EXPIRY_MS
    : DEFAULT_APPROVAL_EXPIRY_MS

const mailboxSendAudience = (args: Record<string, unknown>): string => {
  const recipientCount = ['to', 'cc', 'bcc'].reduce(
    (count, key) => count + (Array.isArray(args[key]) ? args[key].length : 0),
    0,
  )
  return recipientCount === 1
    ? '1 recipient will receive it'
    : `${recipientCount} recipients will receive it`
}

const describeGatedAction = (
  toolName: string,
  args: Record<string, unknown>,
): { headline: string; audience: string } => {
  const guests = Array.isArray(args.attendees) ? args.attendees.length : 0
  const guestLine = guests > 0
    ? `${guests} ${guests === 1 ? 'guest' : 'guests'} will be emailed`
    : 'Nobody outside is contacted'
  const title = typeof args.title === 'string' ? args.title : null

  if (toolName === 'calendar_event_create') {
    return { headline: title ? `Create “${title}”` : 'Create a calendar event', audience: guestLine }
  }
  if (toolName === 'calendar_event_update') {
    return {
      headline: title ? `Change “${title}”` : 'Change a calendar event',
      audience: guests > 0 ? guestLine : 'Guests on the event will be told',
    }
  }
  if (toolName === 'calendar_event_cancel') {
    return { headline: 'Cancel a calendar event', audience: 'Guests on the event will be told it is cancelled' }
  }
  if (toolName === 'gmail_draft_send') {
    return { headline: 'Send an email as you', audience: 'The recipients will receive it' }
  }
  if (toolName === 'mailbox_send') {
    return { audience: mailboxSendAudience(args), headline: 'Send an email from a connected mailbox' }
  }
  return { headline: `Run ${toolName}`, audience: 'This acts on your account' }
}

/** Posts the receipt for a standing rule without letting a failed receipt stop the allowed action. */
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
        content: described.headline,
        role: 'assistant',
        agentId: context.agent.id,
        threadId: context.run.threadId,
        metadata: {
          card: {
            kind: 'allowed_by_rule',
            audience: described.audience,
            details: summarizeToolInput(input.args),
            headline: described.headline,
            rule: input.rule,
          },
        } as Prisma.InputJsonValue,
      },
    })
  } catch (error) {
    console.error('[worker.allowed-by-rule] could not post receipt', error)
  }
}

export type CreateToolApprovalRequestInput = {
  actorContext: AuthorizedActionContext
  approvalActionType?: string
  args: Record<string, unknown>
  context: RunContext
  contextExtra?: Record<string, unknown>
  interactive: boolean
  messageId: string
  policyRuleId?: string
  reason?: string
  requiredApproverUserId?: string | null
  toolCallId: string
  toolName: string
  boundaryReason?: string
}

/** Persists a one-time approval and the exact frozen invocation it resumes. */
export const createToolApprovalRequest = async (
  prisma: PrismaClient,
  input: CreateToolApprovalRequestInput,
): Promise<{ id: string }> => {
  const existing = await prisma.approvalRequest.findFirst({
    where: { runId: input.context.run.id, toolCallId: input.toolCallId },
    select: { id: true },
  })
  if (existing) return existing

  const approvalContext = input.toolName === 'mailbox_send'
    ? {
        audience: mailboxSendAudience(input.args),
        externalDisclosureSources: Array.isArray(input.contextExtra?.externalDisclosureSources)
          ? input.contextExtra.externalDisclosureSources.filter(
              (source): source is string => typeof source === 'string',
            )
          : [],
        headline: 'Send an email from a connected mailbox',
        ...(typeof input.contextExtra?.mailboxConnectionId === 'string'
          ? { mailboxConnectionId: input.contextExtra.mailboxConnectionId }
          : {}),
      }
    : input.toolName === 'gmail_draft_send'
      ? {
          audience: 'The recipients will receive it',
          externalDisclosureSources: Array.isArray(input.contextExtra?.externalDisclosureSources)
            ? input.contextExtra.externalDisclosureSources.filter(
                (source): source is string => typeof source === 'string',
              )
            : [],
          headline: 'Send an email as you',
          // The exact words, addresses and blind copies are intentionally
          // absent here. Approval rows are otherwise visible to organization
          // owners; the pinned preview endpoint reads the frozen resume args.
        }
      : {
        approvalActionType: input.approvalActionType ?? null,
        boundaryReason: input.boundaryReason ?? null,
        inputSummary: summarizeToolInput(input.args),
        policyRuleId: input.policyRuleId ?? null,
        toolName: input.toolName,
        ...describeGatedAction(input.toolName, input.args),
        ...(input.contextExtra ?? {}),
      }

  const data = {
    action: 'tool.invoke',
    agentId: input.context.agent.id,
    argsHash: hashJsonValue(input.args),
    channelId: input.context.channel.id,
    context: approvalContext as Prisma.InputJsonValue,
    continuationToken: randomUUID(),
    expiresAt: new Date(Date.now() + approvalExpiryFor(input.toolName)),
    organizationId: input.context.channel.organizationId,
    projectId: input.context.channel.projectId,
    reason: input.toolName === 'mailbox_send'
      ? 'Approval is required before sending from a connected mailbox.'
      : input.reason ?? `Tool ${input.toolName} requires approval before it can run.`,
    requesterId: input.context.agent.id,
    requiredApproverUserId:
      STRUCTURALLY_APPROVAL_GATED_TOOL_IDS.has(input.toolName)
        ? input.requiredApproverUserId
          ?? input.actorContext.actionContext.effectiveUserId
          ?? null
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
    return await prisma.approvalRequest.create({ data, select: { id: true } })
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error
    }
    const raced = await prisma.approvalRequest.findFirst({
      where: { runId: input.context.run.id, toolCallId: input.toolCallId },
      select: { id: true },
    })
    if (!raced) throw error
    return raced
  }
}
