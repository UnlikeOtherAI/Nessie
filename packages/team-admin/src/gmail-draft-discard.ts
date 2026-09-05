import type { PrismaClient } from '@prisma/client'
import { deleteGmailDraft } from '@nessie/comms-google'

import {
  GmailDraftError,
  type GmailDraftActionRecord,
  type GmailDraftDeps,
  gmailFetch,
  loadCredential,
} from './gmail-drafts.js'
import { toRecord } from './gmail-draft-record.js'

/** Discard only an editable draft; held sends are cancelled through Undo. */
export const discardDraftForUser = async (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string; draftActionId: string },
  deps: GmailDraftDeps,
): Promise<GmailDraftActionRecord> => {
  const existing = await prisma.gmailDraftAction.findFirst({
    where: {
      id: input.draftActionId,
      organizationId: input.organizationId,
      ownerUserId: input.userId,
    },
  })
  if (!existing) throw new GmailDraftError('DRAFT_NOT_FOUND')
  if (existing.state !== 'draft') throw new GmailDraftError('DRAFT_NOT_SENDABLE')
  if (!existing.providerDraftId) throw new GmailDraftError('DELIVERY_UNKNOWN')
  const credential = await loadCredential(prisma, {
    organizationId: input.organizationId,
    userId: input.userId,
    connectionId: existing.connectionId,
    capabilityId: 'gmail.compose',
  }, deps)

  // Claim before touching Gmail. A send/undo/discard race therefore has one
  // winner, and a discard can never overwrite an actively dispatching row.
  const claimed = await prisma.gmailDraftAction.updateMany({
    where: {
      id: existing.id,
      organizationId: input.organizationId,
      ownerUserId: input.userId,
      state: 'draft',
    },
    data: { state: 'discarded', sendAfter: null, claimedAt: null },
  })
  if (claimed.count !== 1) throw new GmailDraftError('DRAFT_NOT_SENDABLE')
  try {
    await deleteGmailDraft(
      gmailFetch(deps),
      credential.credential.accessToken,
      existing.providerDraftId,
    )
  } catch {
    // Local send authority is already revoked. A provider draft that was
    // already gone—or could not be deleted during an outage—cannot be sent by
    // Nessie's worker because the durable row is terminal.
  }
  const row = await prisma.gmailDraftAction.findUniqueOrThrow({ where: { id: existing.id } })
  return toRecord(row)
}
