import type { PrismaClient } from '@prisma/client'
import { EMAIL_SEND_TOOL_ID } from '@nessie/runtime'

import { liveApproverOrNull } from './approver.js'
import { EMAIL_SCOPE_TYPE, subtractImpliedScopes, type BasisScope } from './disclosure-basis.js'
import type { RunContext } from './types.js'

/**
 * Whether a proposed `email_send` needs a human before it leaves the building.
 *
 * The requirement is **structural**, stated here rather than in `PolicyRule`
 * rows, because `evaluateToolInvokePolicy` defaults to *allow* when no rule
 * matches and default seeding writes no rule for sending mail — a policy-only
 * gate would therefore be absent in every organisation that never configured
 * one, which is the fail-open this whole feature cannot afford.
 *
 * Four independent reasons to require approval, in the order they are checked:
 *
 *  1. the mailbox's own `sendPolicy` says so (the default);
 *  2. an unattended run is opening a *new* conversation — nobody asked for it
 *     and nobody is watching;
 *  3. the mailbox has already sent its hourly allowance, so the overflow parks
 *     for a person instead of being dropped or blasted out;
 *  4. the run consumed a privileged source beyond its own mailbox and thread,
 *     so somebody must decide whether that material may leave the team.
 *
 * (4) is the one that cannot be expressed as a policy at all: it is a property
 * of what this particular run happened to read.
 */

export type EmailSendGateDecision = {
  required: boolean
  reason:
    | 'policy_approval'
    | 'unattended_new_conversation'
    | 'rate_limited'
    | 'external_disclosure'
    | null
  /** Privileged scopes beyond the mailbox and the thread, named for the approver. */
  externalSources: BasisScope[]
}

/**
 * Why the person is being asked, in their words. Rendered on the approval card
 * beside the draft, because "approval required" alone does not tell somebody
 * whether to read the message carefully or just press send. Deliberately names
 * no address: the card's row is readable by an org owner.
 */
const gateReason = (decision: EmailSendGateDecision): string => {
  switch (decision.reason) {
    case 'policy_approval':
      return 'This mailbox asks you to approve every message before it leaves.'
    case 'unattended_new_conversation':
      return 'Nobody asked for this — the agent is starting a new conversation on its own.'
    case 'rate_limited':
      return 'This mailbox has already sent its hourly allowance.'
    case 'external_disclosure':
      return (
        'This reply was built from material the recipient cannot reach: '
        + decision.externalSources.map((scope) => `${scope.scopeType}:${scope.scopeId}`).join(', ')
      )
    default:
      return 'This message needs your approval before it leaves.'
  }
}

export const evaluateEmailSendGate = async (
  prisma: PrismaClient,
  context: RunContext,
  input: {
    args: Record<string, unknown>
    interactive: boolean
  },
): Promise<EmailSendGateDecision> => {
  const mailbox = await prisma.agentMailbox.findFirst({
    select: { id: true, sendPolicy: true },
    where: {
      agentId: context.agent.id,
      organizationId: context.channel.organizationId,
      retiredAt: null,
      status: 'active',
    },
  })
  // No mailbox: the tool itself will refuse. Nothing to gate.
  if (!mailbox) return { externalSources: [], reason: null, required: false }

  // What the run read that neither its own mailbox nor the room it is answering
  // in already implies. Computed first because it is reported even when another
  // reason triggers the gate — the approver should see it either way.
  const externalSources = subtractImpliedScopes(context.consumedSources.list(), [
    { scopeId: mailbox.id, scopeType: EMAIL_SCOPE_TYPE },
    { scopeId: context.channel.organizationId, scopeType: 'organization' },
    { scopeId: context.channel.projectId, scopeType: 'project' },
    { scopeId: context.channel.teamId, scopeType: 'team' },
    { scopeId: context.channel.id, scopeType: 'channel' },
    ...context.boundAgentIds.map((scopeId) => ({ scopeId, scopeType: 'agent' })),
  ])

  const startsNewConversation =
    Array.isArray(input.args.to) && (input.args.to as unknown[]).length > 0

  if (mailbox.sendPolicy === 'approval') {
    return { externalSources, reason: 'policy_approval', required: true }
  }

  // An unattended run may reply under auto_reply/auto, but opening new
  // correspondence with the outside world is never automatic.
  if (!input.interactive && startsNewConversation) {
    return { externalSources, reason: 'unattended_new_conversation', required: true }
  }

  if (externalSources.length > 0) {
    return { externalSources, reason: 'external_disclosure', required: true }
  }

  const sentInLastHour = await prisma.emailMessage.count({
    where: {
      createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
      direction: 'outbound',
      mailboxId: mailbox.id,
    },
  })
  const limit = emailSendRateLimit()
  if (sentInLastHour >= limit) {
    return { externalSources, reason: 'rate_limited', required: true }
  }

  return { externalSources, reason: null, required: false }
}

const emailSendRateLimit = (): number => {
  const configured = Number(process.env.NESSIE_AGENT_MAIL_MAX_SENDS_PER_HOUR)
  return Number.isFinite(configured) && configured > 0 ? configured : 30
}

/**
 * The `structuralGate` hook the agentic loop hands to tool authorization.
 *
 * Returning non-null makes this family authoritative for that tool, so
 * `email_send` never falls through to the send-as-you standing-consent path:
 * nobody's account is being borrowed by an agent mailbox, and its reasons to
 * stop are its own. Every other tool returns null and pays one comparison.
 */
export const buildEmailSendApprovalHook = (
  prisma: PrismaClient,
  context: RunContext,
  interactive: boolean,
) =>
  async (input: { toolName: string; args: Record<string, unknown> }) => {
    if (input.toolName !== EMAIL_SEND_TOOL_ID) return null
    const decision = await evaluateEmailSendGate(prisma, context, {
      args: input.args,
      interactive,
    })
    // Owned but not gated: `{outcome:'allow'}` still claims the decision, which
    // is what keeps this tool off the standing-consent path.
    if (!decision.required) return { outcome: 'allow' as const }
    const approverUserId = await liveApproverOrNull(prisma, {
      organizationId: context.channel.organizationId,
      userId: context.agent.ownerUserId,
    })
    if (!approverUserId) {
      return {
        message:
          'This agent mailbox has no active steward to approve sends. Reactivate or assign '
          + 'its steward before preparing another email.',
        outcome: 'deny' as const,
        reason: 'agent_mailbox_approver_unavailable',
      }
    }
    return {
      outcome: 'approval' as const,
      reason: gateReason(decision),
      // Address-free by rule: this row is readable through the approvals
      // surface by an org owner, while the sealed proposal is materialized only
      // for its pinned approver. Only the scopes that forced the ask are
      // recorded here, and a scope id names an audience, not a person's mail.
      contextExtra: {
        externalDisclosureSources: decision.externalSources.map(
          (scope) => `${scope.scopeType}:${scope.scopeId}`,
        ),
      },
      // The mailbox belongs to the agent, and the agent belongs to its steward:
      // a send acting as their agent is theirs to authorize. An unowned or
      // inactive steward is not recoverable by creating an unpinned approval.
      requiredApproverUserId: approverUserId,
    }
  }
