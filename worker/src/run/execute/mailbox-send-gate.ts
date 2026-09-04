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

export type MailboxSendGateDecision =
  | {
      outcome: 'approval'
      requiredApproverUserId: string
      reason: string
    }
  | {
      outcome: 'deny'
      message: string
      reason: 'mailbox_approver_unavailable' | 'mailbox_unavailable'
    }

const describe = (mailbox: ReachableMailbox, externalSources: string[]): string => {
  const who =
    mailbox.scope === 'user'
      ? 'This would go out from your personal connected mailbox.'
      : 'This would go out from a shared team mailbox.'
  if (externalSources.length === 0) return who
  return (
    `${who} It was also built from material the recipient cannot reach: `
    + `${externalSources.join(', ')}.`
  )
}

export const evaluateMailboxSendGate = async (
  prisma: PrismaClient,
  context: RunContext,
  input: { connectionId: string; effectiveUserId: string | null },
): Promise<MailboxSendGateDecision> => {
  const reachable = await listReachableMailboxes(prisma, {
    agentId: context.agent.id,
    effectiveUserId: input.effectiveUserId,
    organizationId: context.channel.organizationId,
  })
  // Sending must name the same exact mailbox in the durable approval and at
  // dispatch. A sole reachable connection is not a stable identity: another
  // connection can appear while the person is deciding.
  const mailbox = reachable.find((entry) => entry.connection.id === input.connectionId)
  if (!mailbox) {
    return {
      message:
        'The selected connected mailbox is unavailable or you no longer have access. '
        + 'Choose an active mailbox connection and try again.',
      outcome: 'deny',
      reason: 'mailbox_unavailable',
    }
  }

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

  const accountableUserId = mailbox.connection.ownerUserId ?? mailbox.connection.createdByUserId
  if (!accountableUserId) {
    return {
      message:
        'This shared mailbox has no assigned approver. An owner or admin must reconnect '
        + 'it under an active approver before it can send.',
      outcome: 'deny',
      reason: 'mailbox_approver_unavailable',
    }
  }
  const liveApprover = await liveApproverOrNull(prisma, {
    organizationId: context.channel.organizationId,
    userId: accountableUserId,
  })

  if (!liveApprover) {
    return {
      message: mailbox.scope === 'team'
        ? 'The person assigned to approve shared mailbox sends is no longer active. '
          + 'An owner or admin must reconnect it under an active approver before it can send.'
        : 'The personal mailbox owner is no longer active. Reactivate its owner or '
          + 'reconnect the mailbox under an active owner before it can send.',
      outcome: 'deny',
      reason: 'mailbox_approver_unavailable',
    }
  }

  return {
    outcome: 'approval',
    reason: describe(mailbox, externalSources),
    // The person accountable for the mailbox: its owner for a personal one,
    // and whoever connected a shared one.
    requiredApproverUserId: liveApprover,
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
    const connectionId = input.args.connectionId as string
    const decision = await evaluateMailboxSendGate(prisma, context, {
      connectionId,
      effectiveUserId,
    })
    if (decision.outcome === 'deny') return decision
    return {
      outcome: 'approval' as const,
      reason: decision.reason,
      requiredApproverUserId: decision.requiredApproverUserId,
      // Address-free by the same rule the hosted mailbox follows: this row is
      // readable through the approvals surface, and the message itself is shown
      // to the pinned approver from the frozen tool arguments.
      contextExtra: {
        mailboxConnectionId: connectionId,
      },
    }
  }
