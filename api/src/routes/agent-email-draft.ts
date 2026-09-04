import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { createApiResponse, sendApiError } from '../lib/api.js'
import type { RouteDeps } from './types.js'

/**
 * The full email an approver is being asked to authorize.
 *
 * The generic tool gate shows `summarizeToolInput`'s 200-character redacted
 * line, which is not informed consent for recipients, blind copies, subject and
 * body. The frozen arguments already live server-side in
 * `ApprovalRequest.resumeState` — the same copy the argument hash is computed
 * over — so this route renders exactly what will be sent if the person says
 * yes, and nothing that is not covered by that hash.
 *
 * Owner-gated *and* pinned: when the approval names a required approver, only
 * that person may read the draft. A send acting as somebody's agent is theirs
 * to judge.
 */

const ResumeStateSchema = z.object({
  args: z.object({
    bcc: z.array(z.string()).optional(),
    cc: z.array(z.string()).optional(),
    subject: z.string().optional(),
    text: z.string(),
    to: z.array(z.string()).optional(),
  }),
})

const GmailResumeStateSchema = z.object({
  args: z.object({
    connectionId: z.string().uuid(),
    draftId: z.string().uuid(),
    expectedFingerprint: z.string().min(1),
    reviewed: z.object({
      bcc: z.array(z.string()),
      body: z.string(),
      cc: z.array(z.string()),
      subject: z.string(),
      to: z.array(z.string()),
    }).strict(),
  }).strict(),
})

const privateNoStore = (reply: { header: (name: string, value: string) => unknown }): void => {
  reply.header('Cache-Control', 'private, no-store')
}

const sendDraftPreview = (
  reply: { send: (payload: unknown) => unknown },
  input: {
    approvalId: string
    bcc: string[]
    cc: string[]
    expiresAt: Date
    externalDisclosureSources: string[]
    mailboxAddress: string
    status: string
    subject: string
    text: string
    to: string[]
  },
) => reply.send(createApiResponse({
  approvalId: input.approvalId,
  bcc: input.bcc,
  cc: input.cc,
  expiresAt: input.expiresAt.toISOString(),
  externalDisclosureSources: input.externalDisclosureSources,
  mailboxAddress: input.mailboxAddress,
  status: input.status,
  subject: input.subject,
  text: input.text,
  to: input.to,
}))

export const registerAgentEmailDraftRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext } = deps

  app.get('/api/agent-email/approvals/:approvalId/draft', async (request, reply) => {
    privateNoStore(reply)
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { approvalId } = request.params as { approvalId: string }

    const approval = await prisma.approvalRequest.findFirst({
      select: {
        agent: { select: { mailbox: { select: { address: true } }, name: true } },
        context: true,
        expiresAt: true,
        id: true,
        requiredApproverUserId: true,
        resumeState: true,
        status: true,
        toolName: true,
      },
      where: {
        expiresAt: { gt: new Date() },
        id: approvalId,
        organizationId: actorContext.tenant.organizationId,
        status: 'pending',
        toolName: 'email_send',
      },
    })
    if (!approval) {
      return sendApiError(reply, 404, 'NOT_FOUND', 'Approval not found.')
    }

    const isOwner = actorContext.actor.roles?.includes('owner') ?? false
    const isPinnedApprover = approval.requiredApproverUserId === actorContext.actor.actorId
    // A pinned approval is that person's alone; an unpinned one falls back to
    // the owner role, which is what the gate itself does.
    if (approval.requiredApproverUserId ? !isPinnedApprover : !isOwner) {
      // Indistinguishable from absent: an approval id is a global UUID.
      return sendApiError(reply, 404, 'NOT_FOUND', 'Approval not found.')
    }

    const parsed = ResumeStateSchema.safeParse(approval.resumeState)
    if (!parsed.success) {
      return sendApiError(reply, 409, 'INVALID_RESUME_STATE', 'This draft can no longer be read.')
    }

    const contextRecord = (approval.context ?? {}) as Record<string, unknown>
    const externalSources = Array.isArray(contextRecord.externalDisclosureSources)
      ? (contextRecord.externalDisclosureSources as string[])
      : []
    // Recipients are resolved HERE, not read from the approval row: that row is
    // readable through the approvals surface by an org owner, so it carries no
    // addresses. This route is owner-gated to the pinned approver, which is the
    // only place the actual correspondents may be shown.
    const draft = await resolveDraftRecipients(prisma, {
      args: parsed.data.args,
      conversationId:
        typeof contextRecord.emailConversationId === 'string'
          ? contextRecord.emailConversationId
          : null,
    })

    return sendDraftPreview(reply, {
      approvalId: approval.id, bcc: draft.bcc, cc: draft.cc, expiresAt: approval.expiresAt,
      externalDisclosureSources: externalSources, mailboxAddress: approval.agent.mailbox?.address ?? '',
      status: approval.status, subject: draft.subject, text: parsed.data.args.text, to: draft.to,
    })
  })

  app.get('/api/mailbox-connections/approvals/:approvalId/draft', async (request, reply) => {
    privateNoStore(reply)
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { approvalId } = request.params as { approvalId: string }

    const approval = await prisma.approvalRequest.findFirst({
      select: {
        context: true,
        expiresAt: true,
        id: true,
        requiredApproverUserId: true,
        resumeState: true,
        status: true,
      },
      where: {
        expiresAt: { gt: new Date() },
        id: approvalId,
        organizationId: actorContext.tenant.organizationId,
        status: 'pending',
        toolName: 'mailbox_send',
      },
    })
    if (!approval || approval.requiredApproverUserId !== actorContext.actor.actorId) {
      // A mailbox-send approval is always pinned. Do not disclose whether a
      // guessed UUID exists to an owner or a public-channel member.
      return sendApiError(reply, 404, 'NOT_FOUND', 'Approval not found.')
    }

    const parsed = ResumeStateSchema.safeParse(approval.resumeState)
    if (!parsed.success) {
      return sendApiError(reply, 409, 'INVALID_RESUME_STATE', 'This draft can no longer be read.')
    }

    const contextRecord = (approval.context ?? {}) as Record<string, unknown>
    const connectionId = contextRecord.mailboxConnectionId
    if (typeof connectionId !== 'string') {
      return sendApiError(reply, 409, 'INVALID_RESUME_STATE', 'This mailbox is no longer available.')
    }
    const mailbox = await prisma.mailboxConnection.findFirst({
      select: { address: true },
      where: { id: connectionId, organizationId: actorContext.tenant.organizationId },
    })
    if (!mailbox) {
      return sendApiError(reply, 409, 'INVALID_RESUME_STATE', 'This mailbox is no longer available.')
    }

    const externalSources = Array.isArray(contextRecord.externalDisclosureSources)
      ? contextRecord.externalDisclosureSources.filter(
          (source): source is string => typeof source === 'string',
        )
      : []
    return sendDraftPreview(reply, {
      approvalId: approval.id, bcc: parsed.data.args.bcc ?? [], cc: parsed.data.args.cc ?? [],
      expiresAt: approval.expiresAt, externalDisclosureSources: externalSources,
      mailboxAddress: mailbox.address, status: approval.status, subject: parsed.data.args.subject ?? '',
      text: parsed.data.args.text, to: parsed.data.args.to ?? [],
    })
  })

  app.get('/api/gmail/drafts/approvals/:approvalId/draft', async (request, reply) => {
    privateNoStore(reply)
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { approvalId } = request.params as { approvalId: string }
    const approval = await prisma.approvalRequest.findFirst({
      select: {
        context: true, expiresAt: true, id: true, requiredApproverUserId: true,
        resumeState: true, status: true,
      },
      where: {
        expiresAt: { gt: new Date() },
        id: approvalId, organizationId: actorContext.tenant.organizationId,
        status: 'pending',
        toolName: 'gmail_draft_send',
      },
    })
    // Gmail sends act as a person's account, so every one is pinned. Keep a
    // guessed id indistinguishable from another member's approval.
    if (!approval || approval.requiredApproverUserId !== actorContext.actor.actorId) {
      return sendApiError(reply, 404, 'NOT_FOUND', 'Approval not found.')
    }
    const parsed = GmailResumeStateSchema.safeParse(approval.resumeState)
    if (!parsed.success) {
      return sendApiError(reply, 409, 'INVALID_RESUME_STATE', 'This draft can no longer be read.')
    }
    const action = await prisma.gmailDraftAction.findFirst({
      select: { connection: { select: { externalUserId: true } }, id: true },
      where: {
        connectionId: parsed.data.args.connectionId,
        id: parsed.data.args.draftId,
        organizationId: actorContext.tenant.organizationId,
        ownerUserId: actorContext.actor.actorId,
      },
    })
    if (!action) return sendApiError(reply, 404, 'NOT_FOUND', 'Approval not found.')
    const contextRecord = (approval.context ?? {}) as Record<string, unknown>
    const externalSources = Array.isArray(contextRecord.externalDisclosureSources)
      ? contextRecord.externalDisclosureSources.filter(
          (source): source is string => typeof source === 'string',
        )
      : []
    return sendDraftPreview(reply, {
      approvalId: approval.id,
      bcc: parsed.data.args.reviewed.bcc,
      cc: parsed.data.args.reviewed.cc,
      expiresAt: approval.expiresAt,
      externalDisclosureSources: externalSources,
      mailboxAddress: action.connection.externalUserId,
      status: approval.status,
      subject: parsed.data.args.reviewed.subject,
      text: parsed.data.args.reviewed.body,
      to: parsed.data.args.reviewed.to,
    })
  })
}

/**
 * The recipients a send will actually use.
 *
 * Explicit `to` wins; otherwise this is a reply, whose recipients come from the
 * conversation's newest inbound message — `Reply-To` over `From`, which is what
 * that header is for. Resolved here rather than stored on the approval row
 * because that row is readable by an org owner and must carry no addresses.
 */
const resolveDraftRecipients = async (
  prisma: RouteDeps['prisma'],
  input: {
    args: { to?: string[]; cc?: string[]; bcc?: string[]; subject?: string }
    conversationId: string | null
  },
): Promise<{ to: string[]; cc: string[]; bcc: string[]; subject: string }> => {
  const explicitTo = input.args.to ?? []
  const bcc = input.args.bcc ?? []
  if (explicitTo.length > 0 || !input.conversationId) {
    return { bcc, cc: input.args.cc ?? [], subject: input.args.subject ?? '', to: explicitTo }
  }

  const [conversation, newest] = await Promise.all([
    prisma.emailConversation.findUnique({
      select: { subject: true },
      where: { id: input.conversationId },
    }),
    prisma.emailMessage.findFirst({
      orderBy: { occurredAt: 'desc' },
      select: { ccAddresses: true, fromAddress: true, replyToAddress: true },
      where: { conversationId: input.conversationId, direction: 'inbound' },
    }),
  ])

  const asList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  const primary = newest?.replyToAddress ?? newest?.fromAddress ?? null

  return {
    bcc,
    cc: asList(newest?.ccAddresses),
    subject: input.args.subject || conversation?.subject || '',
    to: primary ? [primary] : [],
  }
}
