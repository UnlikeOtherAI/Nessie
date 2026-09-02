import type { PrismaClient } from '@prisma/client'
import { EMAIL_SEND_TOOL_ID } from '@nessie/runtime'

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
 *     so somebody must decide whether that material may leave the workspace.
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
 * Email is asynchronous, so a send approval outlives the 30-minute tool
 * default: an overnight approval that expired silently would strand the
 * conversation with nobody able to tell why.
 */
export const EMAIL_APPROVAL_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000

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
 * The `forceApproval` hook the agentic loop hands to tool authorization. Only
 * `email_send` is gated; everything else returns null and pays one comparison.
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
    if (!decision.required) return null
    return {
      approvalActionType: `email.send.${decision.reason}`,
      expiryMs: EMAIL_APPROVAL_EXPIRY_MS,
      // The mailbox belongs to the agent, and the agent belongs to its steward:
      // a send acting as their agent is theirs to authorize. Falls back to the
      // owner role when the agent is unowned or its steward is deactivated.
      requiredApproverUserId: await resolveLiveSteward(prisma, context),
    }
  }

const resolveLiveSteward = async (
  prisma: PrismaClient,
  context: RunContext,
): Promise<string | null> => {
  const ownerUserId = context.agent.ownerUserId
  if (!ownerUserId) return null
  // The FK proves the membership row exists, never that it is live — an
  // approval pinned to a deactivated person would be unanswerable.
  const live = await prisma.organizationMember.count({
    where: {
      deactivatedAt: null,
      organizationId: context.channel.organizationId,
      userId: ownerUserId,
    },
  })
  return live > 0 ? ownerUserId : null
}
