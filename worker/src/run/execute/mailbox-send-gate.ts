import type { PrismaClient } from '@prisma/client'
import { MAILBOX_SEND_TOOL_ID } from '@nessie/runtime'
import { listReachableMailboxes, type ReachableMailbox } from '@nessie/team-admin'

import { liveApproverOrNull } from './approver.js'
import { subtractImpliedScopes } from './disclosure-basis.js'
import type { RunContext } from './types.js'

/**
 * Whether a proposed `mailbox_send` needs a person before it leaves.
 *
 * It always does, and that is a decision rather than an omission. A connected
 * mailbox is somebody's real address — a person's own, or a team's shared
 * `support@` — and the credential behind it is a password that reads and sends
 * everything. The Gmail lane can offer standing consent because a grant there
 * is the mailbox owner's to give about their own account; a shared team mailbox
 * has no such single owner, and building one grant table that means two
 * different things is how the exact-key discipline gets lost. Standing grants
 * for connected mailboxes are therefore a later, separate decision, and until
 * then every send is asked.
 *
 * What this gate adds beyond "ask" is *who* is asked and *why*. Without a
 * pinned approver the request is answerable by every member who can read the
 * channel, which is the wrong audience for a message going out as somebody's
 * address.
 */

export type MailboxSendGateDecision = {
  externalDisclosureSources: string[]
  mailboxConnectionId: string
  requiredApproverUserId: string
  reason: string
}

const describe = (mailbox: ReachableMailbox, externalSources: string[]): string => {
  const who =
    mailbox.scope === 'user'
      ? `This would go out as ${mailbox.connection.address}, a personal mailbox.`
      : `This would go out as ${mailbox.connection.address}, a shared team mailbox.`
  if (externalSources.length === 0) return who
  return (
    `${who} It was also built from material the recipient cannot reach: `
    + `${externalSources.join(', ')}.`
  )
}

export const evaluateMailboxSendGate = async (
  prisma: PrismaClient,
  context: RunContext,
  input: { connectionId: string | null; effectiveUserId: string | null },
): Promise<MailboxSendGateDecision | null> => {
  const reachable = await listReachableMailboxes(prisma, {
    agentId: context.agent.id,
    effectiveUserId: input.effectiveUserId,
    organizationId: context.channel.organizationId,
  })
  // Resolve exactly as the tool will. If the call cannot name one mailbox the
  // tool refuses in words, and asking somebody to approve a send that cannot
  // happen would be worse than useless.
  const mailbox = input.connectionId
    ? reachable.find((entry) => entry.connection.id === input.connectionId)
    : reachable.length === 1
      ? reachable[0]
      : undefined
  if (!mailbox) return null

  // What the run read that the recipient has no claim to. The mailbox's own
  // scope is implied — answering the correspondence you were reading is the
  // ordinary case and must not be reported as a disclosure.
  const externalSources = subtractImpliedScopes(context.consumedSources.list(), [
    mailbox.basis,
    { scopeId: context.channel.organizationId, scopeType: 'organization' },
    { scopeId: context.channel.projectId, scopeType: 'project' },
    { scopeId: context.channel.teamId, scopeType: 'team' },
    { scopeId: context.channel.id, scopeType: 'channel' },
    ...context.boundAgentIds.map((scopeId) => ({ scopeId, scopeType: 'agent' })),
  ]).map((scope) => `${scope.scopeType}:${scope.scopeId}`)

  const requiredApproverUserId = await liveApproverOrNull(prisma, {
    organizationId: context.channel.organizationId,
    userId: mailbox.connection.ownerUserId ?? mailbox.connection.createdByUserId,
  })
  if (!requiredApproverUserId) {
    throw new Error(
      'This mailbox has no active accountable owner. Reconnect it before sending.',
    )
  }

  return {
    externalDisclosureSources: externalSources,
    mailboxConnectionId: mailbox.connection.id,
    reason: describe(mailbox, externalSources),
    requiredApproverUserId,
  }
}

/**
 * The `structuralGate` contribution for connected mailboxes. Returning non-null
 * claims the decision, which keeps `mailbox_send` off the send-as-you standing
 * consent path — nobody's Google account is being borrowed here.
 */
export const buildMailboxSendApprovalHook = (
  prisma: PrismaClient,
  context: RunContext,
  effectiveUserId: string | null,
) =>
  async (input: { toolName: string; args: Record<string, unknown> }) => {
    if (input.toolName !== MAILBOX_SEND_TOOL_ID) return null
    const connectionId =
      typeof input.args.connectionId === 'string' ? input.args.connectionId : null
    const decision = await evaluateMailboxSendGate(prisma, context, {
      connectionId,
      effectiveUserId,
    })
    if (!decision) return null
    return {
      escalate: true as const,
      reason: decision.reason,
      requiredApproverUserId: decision.requiredApproverUserId,
      contextExtra: {
        externalDisclosureSources: decision.externalDisclosureSources,
        mailboxConnectionId: decision.mailboxConnectionId,
      },
    }
  }
