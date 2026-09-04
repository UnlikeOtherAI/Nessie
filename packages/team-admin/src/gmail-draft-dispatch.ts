import type { PrismaClient } from '@prisma/client'
import { getGmailDraft, sendGmailMessage } from '@nessie/comms-google'

import {
  GmailDraftError,
  type GmailDraftDeps,
  type SendDraftResult,
  gmailFetch,
  loadCredential,
} from './gmail-drafts.js'
import { toRecord } from './gmail-draft-record.js'
import { fingerprintOf } from './gmail-draft-fingerprint.js'

/** A stalled provider request is ambiguous, never eligible for another send. */
export const STALE_CLAIM_WINDOW_MS = 2 * 60 * 1000

/**
 * Make abandoned create/send attempts visible without guessing whether Gmail
 * accepted them. This is deliberately a terminal state, not a reclaim.
 */
export const resolveStaleGmailDispatches = async (
  prisma: PrismaClient,
  deps: Pick<GmailDraftDeps, 'now'> = {},
): Promise<Array<{ id: string; organizationId: string }>> => {
  const now = deps.now?.() ?? new Date()
  const staleAt = new Date(now.getTime() - STALE_CLAIM_WINDOW_MS)
  const candidates = await prisma.gmailDraftAction.findMany({
    where: {
      state: { in: ['creating', 'dispatching'] },
      claimedAt: { lt: staleAt },
    },
    orderBy: { claimedAt: 'asc' },
    select: { id: true, organizationId: true },
    take: 50,
  })
  const resolved: Array<{ id: string; organizationId: string }> = []
  for (const candidate of candidates) {
    const result = await prisma.gmailDraftAction.updateMany({
      where: {
        id: candidate.id,
        state: { in: ['creating', 'dispatching'] },
        claimedAt: { lt: staleAt },
      },
      data: { state: 'delivery_unknown', claimedAt: null, sendAfter: null },
    })
    if (result.count === 1) resolved.push(candidate)
  }
  return resolved
}

/**
 * Only an edit still before Gmail's PUT boundary is recoverable. Once an edit
 * enters `update_unknown`, Gmail may have accepted the replacement and the
 * draft stays locked until a person resolves it in Gmail.
 */
export const resolveStaleGmailDraftUpdates = async (
  prisma: PrismaClient,
  deps: Pick<GmailDraftDeps, 'now'> = {},
): Promise<number> => {
  const now = deps.now?.() ?? new Date()
  const staleAt = new Date(now.getTime() - STALE_CLAIM_WINDOW_MS)
  const recovered = await prisma.gmailDraftAction.updateMany({
    where: { state: 'updating', claimedAt: { lt: staleAt } },
    data: { state: 'draft', claimedAt: null },
  })
  return recovered.count
}

/** A stalled validation has not started Gmail send, so release it safely. */
export const resolveStaleGmailDraftValidations = async (
  prisma: PrismaClient,
  deps: Pick<GmailDraftDeps, 'now'> = {},
): Promise<number> => {
  const now = deps.now?.() ?? new Date()
  const staleAt = new Date(now.getTime() - STALE_CLAIM_WINDOW_MS)
  const recovered = await prisma.gmailDraftAction.updateMany({
    where: { state: 'sending', sendAfter: null, claimedAt: { lt: staleAt } },
    data: { state: 'draft', claimedAt: null },
  })
  return recovered.count
}

/**
 * Claim then send exactly once. Once a Gmail send request starts, any failure
 * is externally ambiguous: retaining a retryable draft could duplicate mail.
 */
export const dispatchClaimedDraft = async (
  prisma: PrismaClient,
  draftActionId: string,
  deps: GmailDraftDeps,
  validationClaimedAt?: Date,
): Promise<SendDraftResult> => {
  const now = deps.now?.() ?? new Date()
  const claimed = await prisma.gmailDraftAction.updateMany({
    where: {
      id: draftActionId,
      state: 'sending',
      ...(validationClaimedAt ? { claimedAt: validationClaimedAt, sendAfter: null } : {}),
    },
    data: { state: 'dispatching', claimedAt: now },
  })
  if (claimed.count !== 1) throw new GmailDraftError('DRAFT_NOT_SENDABLE')
  const row = await prisma.gmailDraftAction.findUniqueOrThrow({ where: { id: draftActionId } })
  if (!row.providerDraftId) {
    await prisma.gmailDraftAction.updateMany({
      where: { id: row.id, state: 'dispatching' },
      data: { state: 'delivery_unknown', claimedAt: null, sendAfter: null },
    })
    throw new GmailDraftError('DELIVERY_UNKNOWN')
  }
  let credential
  try {
    credential = await loadCredential(prisma, {
      organizationId: row.organizationId,
      userId: row.ownerUserId,
      connectionId: row.connectionId,
      capabilityId: 'gmail.compose',
    }, deps)
  } catch (error) {
    // No provider request has started, so returning to draft cannot duplicate.
    await prisma.gmailDraftAction.updateMany({
      where: { id: row.id, state: 'dispatching' },
      data: { state: 'draft', claimedAt: null },
    })
    throw error
  }
  const fetchImpl = gmailFetch(deps)
  let captured: Awaited<ReturnType<typeof getGmailDraft>>
  try {
    captured = await getGmailDraft(fetchImpl, credential.credential.accessToken, row.providerDraftId)
    if (!captured.editable) {
      throw new GmailDraftError('DRAFT_NOT_SENDABLE', 'edit this unsupported draft in Gmail')
    }
    if (fingerprintOf(captured) !== row.contentFingerprint) {
      throw new GmailDraftError('DRAFT_CHANGED')
    }
  } catch (error) {
    // A failed validation/read never started a send. Returning to draft is
    // safe, and forces the next attempt to validate the provider version.
    await prisma.gmailDraftAction.updateMany({
      where: { id: row.id, state: 'dispatching' },
      data: { state: 'draft', claimedAt: null, sendAfter: null },
    })
    if (error instanceof GmailDraftError) throw error
    throw new GmailDraftError('PROVIDER_FAILED', (error as Error).message)
  }
  let sent
  try {
    // Send the bytes we just verified, rather than asking Gmail to send its
    // mutable draft id. A later Gmail edit therefore cannot alter this send.
    sent = await sendGmailMessage(fetchImpl, credential.credential.accessToken, {
      to: captured.to,
      cc: captured.cc,
      bcc: captured.bcc,
      subject: captured.subject,
      body: captured.body,
      ...(captured.inReplyTo ? { inReplyTo: captured.inReplyTo } : {}),
      ...(captured.references.length > 0 ? { references: captured.references } : {}),
    }, captured.threadId ?? row.providerThreadId ?? undefined)
  } catch (error) {
    await prisma.gmailDraftAction.updateMany({
      where: { id: row.id, state: 'dispatching' },
      data: { state: 'delivery_unknown', sendAfter: null, claimedAt: null },
    })
    throw new GmailDraftError('DELIVERY_UNKNOWN', (error as Error).message)
  }
  const settled = await prisma.gmailDraftAction.updateMany({
    where: { id: row.id, state: 'dispatching', claimedAt: now },
    data: {
      state: 'sent', sentAt: now, sentMessageId: sent.messageId,
      sendAfter: null, claimedAt: null,
    },
  })
  if (settled.count !== 1) throw new GmailDraftError('DELIVERY_UNKNOWN')
  const updated = await prisma.gmailDraftAction.findUniqueOrThrow({ where: { id: row.id } })
  // Gmail has no conditional draft DELETE. Keeping this provider draft is the
  // only safe choice: an owner can edit it between any read and DELETE, and a
  // best-effort cleanup must not erase their newer words after older bytes sent.
  return { status: 'sent', sentMessageId: sent.messageId, action: toRecord(updated) }
}
