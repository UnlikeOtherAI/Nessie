import type { FastifyInstance } from 'fastify'
import {
  AuthorizedGmailDraftSendToolInputSchema,
  MailboxSendToolInputSchema,
  SealedEmailSendToolInputSchema,
} from '@nessie/runtime'
import {
  currentMailboxConnectionApprover,
  fingerprintDraft,
  GmailDraftError,
  readDraftForUser,
} from '@nessie/team-admin'
import { z } from 'zod'

import { createApiResponse, sendApiError } from '../lib/api.js'
import type { RouteDeps } from './types.js'

/**
 * The proposal is intentionally absent from ApprovalRequest's public
 * presenter. This narrow route is the only way an email's recipients, subject
 * and body leave the frozen resume state, and it is reachable by the exact
 * active approver while the decision is still pending.
 */

const REVIEWABLE_EMAIL_TOOL_NAMES = ['email_send', 'gmail_draft_send', 'mailbox_send']

const ResumeStateSchema = z.object({
  args: z.record(z.string(), z.unknown()),
}).passthrough()

/** Never disclose provider attachment identities in the approver's browser. */
export const projectEmailReviewAttachments = (
  attachments: Array<{ filename: string; mimeType: string; sizeBytes: number }>,
) => attachments.map(({ filename, mimeType, sizeBytes }) => ({ filename, mimeType, sizeBytes }))

const unavailable = (reply: Parameters<typeof sendApiError>[0]) =>
  sendApiError(reply, 409, 'EMAIL_REVIEW_UNAVAILABLE', 'This email can no longer be reviewed.')

const gmailChanged = (reply: Parameters<typeof sendApiError>[0]) =>
  sendApiError(
    reply,
    409,
    'EMAIL_ACTION_CHANGED',
    'The Gmail draft changed after this approval. Ask the agent to propose it again.',
  )

export const registerApprovalEmailReviewRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { authSecret, prisma, requireActorContext } = deps

  app.get('/api/approvals/:approvalId/email-review', async (request, reply) => {
    // This response contains exact correspondence. Set the policy before
    // authentication or lookup so every success and every error is uncacheable.
    reply.header('Cache-Control', 'private, no-store')
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { approvalId } = request.params as { approvalId: string }

    const activeApprover = await prisma.organizationMember.count({
      where: {
        deactivatedAt: null,
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
      },
    })
    if (activeApprover !== 1) {
      return sendApiError(reply, 404, 'NOT_FOUND', 'Approval request not found.')
    }

    // This is intentionally stricter than approvalVisibilityWhere: an org
    // owner may administer a source channel, but may not inspect a message
    // sent as somebody else's mailbox. Pending-only makes the detail transient
    // rather than a second durable email archive.
    const approval = await prisma.approvalRequest.findFirst({
      select: {
        agentId: true,
        expiresAt: true,
        id: true,
        resumeState: true,
        toolName: true,
      },
      where: {
        expiresAt: { gt: new Date() },
        id: approvalId,
        organizationId: actorContext.tenant.organizationId,
        requiredApproverUserId: actorContext.actor.actorId,
        status: 'pending',
        toolName: { in: REVIEWABLE_EMAIL_TOOL_NAMES },
      },
    })
    if (!approval) {
      // An approval id is a global UUID. Conceal wrong user, wrong tenant,
      // already-resolved and non-email cases behind the same answer.
      return sendApiError(reply, 404, 'NOT_FOUND', 'Approval request not found.')
    }

    const resumeState = ResumeStateSchema.safeParse(approval.resumeState)
    if (!resumeState.success) return unavailable(reply)

    if (approval.toolName === 'email_send') {
      const args = SealedEmailSendToolInputSchema.safeParse(resumeState.data.args)
      if (!args.success) return unavailable(reply)
      const mailbox = await prisma.agentMailbox.findFirst({
        select: { address: true, displayName: true },
        where: {
          agentId: approval.agentId,
          id: args.data.approvalProposal.mailboxId,
          organizationId: actorContext.tenant.organizationId,
          retiredAt: null,
          status: 'active',
        },
      })
      if (!mailbox) return unavailable(reply)

      return createApiResponse({
        approvalId: approval.id,
        attachments: [],
        bcc: args.data.approvalProposal.bcc,
        cc: args.data.approvalProposal.cc,
        expiresAt: approval.expiresAt.toISOString(),
        kind: 'agent',
        mailboxLabel: mailbox.displayName || mailbox.address,
        senderAddress: mailbox.address,
        subject: args.data.approvalProposal.subject,
        text: args.data.text,
        to: args.data.approvalProposal.to,
      })
    }

    if (approval.toolName === 'mailbox_send') {
      const args = MailboxSendToolInputSchema.safeParse(resumeState.data.args)
      if (!args.success) return unavailable(reply)
      const mailbox = await prisma.mailboxConnection.findFirst({
        select: {
          address: true,
          createdByUserId: true,
          label: true,
          organizationId: true,
          ownerUserId: true,
          teamId: true,
        },
        where: {
          id: args.data.connectionId,
          organizationId: actorContext.tenant.organizationId,
        },
      })
      if (!mailbox) return unavailable(reply)
      // A reconnect can transfer a shared mailbox to a new accountable
      // manager. The old pin must not continue to materialize correspondence
      // while the transaction invalidates its stale approval.
      if (await currentMailboxConnectionApprover(prisma, mailbox) !== actorContext.actor.actorId) {
        return unavailable(reply)
      }

      return createApiResponse({
        approvalId: approval.id,
        attachments: [],
        bcc: args.data.bcc ?? [],
        cc: args.data.cc ?? [],
        expiresAt: approval.expiresAt.toISOString(),
        kind: 'mailbox',
        mailboxLabel: mailbox.label || mailbox.address,
        senderAddress: mailbox.address,
        subject: args.data.subject,
        text: args.data.text,
        to: args.data.to,
      })
    }

    const args = AuthorizedGmailDraftSendToolInputSchema.safeParse(resumeState.data.args)
    if (!args.success) return unavailable(reply)

    try {
      const draft = await readDraftForUser(
        prisma,
        {
          draftActionId: args.data.draftId,
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
        },
        { encryptionSecret: authSecret ?? '' },
      )
      if (fingerprintDraft({
        attachmentIdentities: draft.attachments,
        bcc: draft.bcc,
        body: draft.body,
        cc: draft.cc,
        subject: draft.subject,
        to: draft.to,
      }) !== args.data.approvalFingerprint) {
        return gmailChanged(reply)
      }
      const connection = await prisma.commsConnection.findFirst({
        select: { externalUserId: true },
        where: {
          id: draft.action.connectionId,
          organizationId: actorContext.tenant.organizationId,
          ownerUserId: actorContext.actor.actorId,
          provider: 'google',
        },
      })
      if (!connection) return unavailable(reply)

      return createApiResponse({
        approvalId: approval.id,
        attachments: projectEmailReviewAttachments(draft.attachments),
        bcc: draft.bcc,
        cc: draft.cc,
        expiresAt: approval.expiresAt.toISOString(),
        kind: 'gmail',
        mailboxLabel: connection.externalUserId || 'Gmail account',
        senderAddress: connection.externalUserId,
        subject: draft.subject,
        text: draft.body,
        to: draft.to,
      })
    } catch (error) {
      if (error instanceof GmailDraftError && error.code === 'DRAFT_CHANGED') {
        return gmailChanged(reply)
      }
      // Provider and credential details are useful only to support staff, not
      // in a browser response. The approver can safely decline or have the
      // agent re-propose the action.
      return unavailable(reply)
    }
  })
}
