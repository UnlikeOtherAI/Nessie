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

export const registerAgentEmailDraftRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext } = deps

  app.get('/api/agent-email/approvals/:approvalId/draft', async (request, reply) => {
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
        id: approvalId,
        organizationId: actorContext.tenant.organizationId,
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
    // Server-authored at gate time. A reply carries no `to` in its arguments,
    // so the resolved recipients live here rather than in the frozen args.
    const draft = (contextRecord.emailDraft ?? {}) as Record<string, unknown>
    const list = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

    return reply.send(
      createApiResponse({
        approvalId: approval.id,
        bcc: list(draft.bcc ?? parsed.data.args.bcc),
        cc: list(draft.cc ?? parsed.data.args.cc),
        expiresAt: approval.expiresAt.toISOString(),
        externalDisclosureSources: externalSources,
        mailboxAddress: approval.agent.mailbox?.address ?? '',
        status: approval.status,
        subject:
          typeof draft.subject === 'string' && draft.subject.length > 0
            ? draft.subject
            : parsed.data.args.subject ?? '',
        // The body IS covered by the argument hash: what is rendered here is
        // byte-for-byte what the approved call will send.
        text: parsed.data.args.text,
        to: list(draft.to ?? parsed.data.args.to),
      }),
    )
  })
}
