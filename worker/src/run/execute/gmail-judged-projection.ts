import { fingerprintDraft, readDraftForUser } from '@nessie/team-admin'
import type { PrismaClient } from '@prisma/client'

import type { RunContext } from './types.js'

/** Correspondence admitted only to the single bounded boundary-judge prompt. */
export type GmailJudgedProjection = {
  contentFingerprint: string
  proposal: string
  request: string
}

/**
 * Read the exact Gmail draft and the request that caused this run.
 *
 * This deliberately returns an in-memory value rather than a tool result,
 * event, approval payload, or run-context entry. The caller gives it only to
 * the silent boundary judge; no durable or viewer-visible surface receives it.
 */
export const loadGmailJudgedProjection = async (input: {
  connectionId: string
  context: RunContext
  expectedFingerprint: string
  messageId: string
  prisma: PrismaClient
  requestingUserId: string
  draftActionId: string
}): Promise<GmailJudgedProjection | null> => {
  try {
    const [draft, request] = await Promise.all([
      readDraftForUser(input.prisma, {
        draftActionId: input.draftActionId,
        organizationId: input.context.channel.organizationId,
        userId: input.requestingUserId,
      }, { encryptionSecret: process.env.NESSIE_AUTH_SECRET ?? '' }),
      input.prisma.message.findFirst({
        where: { id: input.messageId, role: 'user', threadId: input.context.run.threadId },
        select: { content: true },
      }),
    ])
    if (!request?.content || draft.action.connectionId !== input.connectionId) return null
    const contentFingerprint = fingerprintDraft({
      attachmentIdentities: draft.attachments,
      bcc: draft.bcc,
      body: draft.body,
      cc: draft.cc,
      subject: draft.subject,
      to: draft.to,
    })
    if (contentFingerprint !== input.expectedFingerprint) return null
    return {
      contentFingerprint,
      proposal: JSON.stringify({
        attachments: draft.attachments?.map(({ filename, mimeType, sizeBytes }) => ({
          filename, mimeType, sizeBytes,
        })),
        bcc: draft.bcc,
        body: draft.body,
        cc: draft.cc,
        subject: draft.subject,
        to: draft.to,
      }),
      request: request.content,
    }
  } catch {
    return null
  }
}
