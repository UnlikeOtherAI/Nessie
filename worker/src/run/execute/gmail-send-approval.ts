import {
  GmailDraftError,
  fingerprintDraft,
  readDraftForUser,
  verifyToolApprovalProof,
} from '@nessie/team-admin'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'
import { z } from 'zod'

import { subtractImpliedScopes } from './disclosure-basis.js'
import { hashJsonValue } from '../tool-util.js'
import type { RunContext } from './types.js'

/**
 * These are deliberately part of the approval's hashed arguments, rather than
 * merely preview data. Gmail's draft id is mutable provider state; a later
 * edit must not be able to turn an approval for one email into authority for
 * another one.
 */
export const FrozenGmailSendArgsSchema = z.object({
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
}).strict()

type FrozenGmailSendArgs = z.infer<typeof FrozenGmailSendArgsSchema>

const RequestedGmailSendSchema = z.object({
  connectionId: z.string().uuid().optional(),
  draftId: z.string().uuid(),
  expectedFingerprint: z.string().min(1).optional(),
}).passthrough()

const ApprovalResumeSchema = z.object({ args: FrozenGmailSendArgsSchema }).passthrough()

export class GmailApprovalResumeError extends Error {
  constructor() {
    super('This approval is no longer bound to a complete Gmail draft.')
    this.name = 'GmailApprovalResumeError'
  }
}

const externalDisclosureSources = (context: RunContext, userId: string): string[] =>
  subtractImpliedScopes(context.consumedSources.list(), [
    { scopeId: userId, scopeType: 'user' },
    { scopeId: context.channel.organizationId, scopeType: 'organization' },
    { scopeId: context.channel.projectId, scopeType: 'project' },
    { scopeId: context.channel.teamId, scopeType: 'team' },
    { scopeId: context.channel.id, scopeType: 'channel' },
    ...context.boundAgentIds.map((scopeId) => ({ scopeId, scopeType: 'agent' as const })),
  ]).map((scope) => `${scope.scopeType}:${scope.scopeId}`)

/** Freeze the exact Gmail message at the approval boundary. */
export const freezeGmailSendApproval = async (
  prisma: PrismaClient,
  context: RunContext,
  actorContext: AuthorizedActionContext,
  args: Record<string, unknown>,
): Promise<{ args: FrozenGmailSendArgs; contextExtra: Record<string, unknown> }> => {
  const draftId = typeof args.draftId === 'string' ? args.draftId : null
  const userId = actorContext.actionContext.effectiveUserId
  if (!draftId || !userId) throw new GmailApprovalResumeError()
  // This provider read enters the approval view and must therefore be part of
  // the same provenance ledger as a tool read. The owner's own mailbox is
  // implied when deciding what must be disclosed on this approval.
  context.consumedSources.add({ scopeId: userId, scopeType: 'user' })
  const draft = await readDraftForUser(prisma, {
    draftActionId: draftId,
    organizationId: context.channel.organizationId,
    userId,
  }, { encryptionSecret: process.env.NESSIE_AUTH_SECRET ?? '' })
  if (!draft.editable || draft.attachments.length > 0 || !draft.hasPlainTextBody) {
    throw new GmailDraftError('DRAFT_NOT_SENDABLE', 'edit this draft in Gmail')
  }
  const liveFingerprint = fingerprintDraft({
    attachmentIds: draft.attachments.map((attachment) => `${attachment.filename}:${attachment.sizeBytes}`),
    bcc: draft.bcc,
    body: draft.body,
    cc: draft.cc,
    inReplyTo: draft.inReplyTo,
    references: draft.references,
    subject: draft.subject,
    threadId: draft.threadId,
    to: draft.to,
  })
  if (liveFingerprint !== draft.action.contentFingerprint) throw new GmailDraftError('DRAFT_CHANGED')
  return {
    args: {
      connectionId: draft.action.connectionId,
      draftId,
      expectedFingerprint: draft.action.contentFingerprint,
      reviewed: {
        bcc: draft.bcc,
        body: draft.body,
        cc: draft.cc,
        subject: draft.subject,
        to: draft.to,
      },
    },
    contextExtra: { externalDisclosureSources: externalDisclosureSources(context, userId) },
  }
}

export const approvalInputFor = async (
  prisma: PrismaClient,
  context: RunContext,
  actorContext: AuthorizedActionContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ args: Record<string, unknown>; contextExtra?: Record<string, unknown> }> =>
  toolName === 'gmail_draft_send'
    ? freezeGmailSendApproval(prisma, context, actorContext, args)
    : { args }

/**
 * An approved resumed inference may repeat only a draft id. Replace that
 * untrusted model input with the approval's server-frozen invocation before
 * hashing or dispatching it. Missing or malformed historical rows deliberately
 * fail closed; they cannot silently fall back to a live Gmail draft.
 */
export const resolveFrozenGmailSendApproval = async (
  prisma: PrismaClient,
  context: RunContext,
  actorContext: AuthorizedActionContext,
  args: Record<string, unknown>,
): Promise<{
  authorizationArgs: FrozenGmailSendArgs
  executionArgs: Record<string, unknown>
} | null> => {
  const approval = actorContext.approval
  if (!approval?.approvalId || !approval.approvalProof) return null
  const requested = RequestedGmailSendSchema.safeParse(args)
  if (!requested.success) throw new GmailApprovalResumeError()
  const row = await prisma.approvalRequest.findFirst({
    select: { continuationToken: true, resumeState: true },
    where: {
      action: 'tool.invoke',
      continuationToken: approval.approvalProof,
      id: approval.approvalId,
      organizationId: context.channel.organizationId,
      proofConsumedAt: null,
      status: 'approved',
      toolName: 'gmail_draft_send',
    },
  })
  const frozen = row && ApprovalResumeSchema.safeParse(row.resumeState)
  if (!row || !frozen?.success) throw new GmailApprovalResumeError()
  const value = frozen.data.args
  if (
    requested.data.draftId !== value.draftId
    || (requested.data.connectionId && requested.data.connectionId !== value.connectionId)
    || (requested.data.expectedFingerprint && requested.data.expectedFingerprint !== value.expectedFingerprint)
  ) {
    throw new GmailApprovalResumeError()
  }
  const argsHash = hashJsonValue(value)
  const verified = await verifyToolApprovalProof(prisma, {
    approvalId: approval.approvalId,
    argsHash,
    continuationRunId: context.run.id,
    organizationId: context.channel.organizationId,
    proof: approval.approvalProof,
    toolName: 'gmail_draft_send',
  })
  if (!verified) throw new GmailApprovalResumeError()
  return {
    authorizationArgs: value,
    executionArgs: {
      connectionId: value.connectionId,
      draftId: value.draftId,
      expectedFingerprint: value.expectedFingerprint,
    },
  }
}
