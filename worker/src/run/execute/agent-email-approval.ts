import {
  EmailSendToolInputSchema,
  SealedEmailSendToolInputSchema,
} from '@nessie/runtime'
import type { PrismaClient } from '@prisma/client'

import { resolveOutboundRecipients } from '../pa-tools/agent-email-context.js'
import { liveApproverOrNull } from './approver.js'
import type { RunContext } from './types.js'

/**
 * Bind a hosted-mail proposal before an approval or a queue row exists.
 *
 * The public tool input is deliberately incomplete for replies: recipients and
 * subject come from the mailbox conversation. This resolves them once, writes
 * that exact proposal only to the approval's server-owned resume state, and
 * lets a later continuation dispatch it without consulting inference or the
 * mutable conversation again.
 */
export const bindAgentEmailApprovalProposal = async (
  prisma: PrismaClient,
  context: RunContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | null> => {
  const modelArgs = { ...args }
  delete modelArgs.approvalProposal
  const parsed = EmailSendToolInputSchema.safeParse(modelArgs)
  if (!parsed.success) return null

  const mailbox = await prisma.agentMailbox.findFirst({
    select: { address: true, id: true },
    where: {
      agentId: context.agent.id,
      organizationId: context.channel.organizationId,
      retiredAt: null,
      status: 'active',
    },
  })
  if (!mailbox) return null

  try {
    const resolved = await resolveOutboundRecipients(
      { prisma, runContext: context },
      mailbox,
      parsed.data,
    )
    return SealedEmailSendToolInputSchema.parse({
      ...parsed.data,
      approvalProposal: {
        bcc: resolved.bcc,
        cc: resolved.cc,
        conversationId: resolved.conversationId,
        mailboxId: mailbox.id,
        subject: resolved.subject,
        to: resolved.to,
      },
    })
  } catch {
    // Recipient resolution reads externally authored correspondence. A broken
    // or stale conversation must not put any of that content into an audit or
    // approval row merely to explain why the proposal was refused.
    return null
  }
}

/**
 * A sealed continuation must still act through the mailbox that was reviewed.
 * This is deliberately a structural existence/ownership check, not a second
 * recipient lookup: the approved target is immutable until a new proposal.
 */
export const sealedAgentEmailProposalIsLive = async (
  prisma: PrismaClient,
  context: RunContext,
  args: Record<string, unknown>,
): Promise<boolean> => {
  const parsed = SealedEmailSendToolInputSchema.safeParse(args)
  if (!parsed.success || !context.agent.ownerUserId) return false
  const [mailbox, steward] = await Promise.all([
    prisma.agentMailbox.findFirst({
      select: { id: true },
      where: {
        agentId: context.agent.id,
        id: parsed.data.approvalProposal.mailboxId,
        organizationId: context.channel.organizationId,
        retiredAt: null,
        status: 'active',
      },
    }),
    prisma.agent.findFirst({
      select: { ownerUserId: true },
      where: {
        id: context.agent.id,
        organizationId: context.channel.organizationId,
        ownerUserId: context.agent.ownerUserId,
      },
    }),
  ])
  if (!mailbox || !steward?.ownerUserId) return false
  return Boolean(await liveApproverOrNull(prisma, {
    organizationId: context.channel.organizationId,
    userId: steward.ownerUserId,
  }))
}
