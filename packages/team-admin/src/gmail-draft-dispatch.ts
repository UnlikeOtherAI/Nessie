import type { PrismaClient } from '@prisma/client'
import { sendGmailDraft } from '@nessie/comms-google'

import {
  GmailDraftError,
  type GmailDraftDeps,
  type SendDraftResult,
  gmailFetch,
  loadCredential,
  toRecord,
} from './gmail-drafts.js'

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
 * Claim then send exactly once. Once a Gmail send request starts, any failure
 * is externally ambiguous: retaining a retryable draft could duplicate mail.
 */
export const dispatchClaimedDraft = async (
  prisma: PrismaClient,
  draftActionId: string,
  deps: GmailDraftDeps,
): Promise<SendDraftResult> => {
  const now = deps.now?.() ?? new Date()
  const claimed = await prisma.gmailDraftAction.updateMany({
    where: { id: draftActionId, state: 'sending' },
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
  let sent
  try {
    sent = await sendGmailDraft(gmailFetch(deps), credential.credential.accessToken, row.providerDraftId)
  } catch (error) {
    await prisma.gmailDraftAction.updateMany({
      where: { id: row.id, state: 'dispatching' },
      data: { state: 'delivery_unknown', sendAfter: null, claimedAt: null },
    })
    throw new GmailDraftError('DELIVERY_UNKNOWN', (error as Error).message)
  }
  const updated = await prisma.gmailDraftAction.update({
    where: { id: row.id },
    data: {
      state: 'sent', sentAt: now, sentMessageId: sent.messageId,
      sendAfter: null, claimedAt: null,
    },
  })
  return { status: 'sent', sentMessageId: sent.messageId, action: toRecord(updated) }
}
