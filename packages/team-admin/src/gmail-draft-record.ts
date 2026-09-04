import type { OutboundMessage } from '@nessie/comms-google'

export type ComposeDraftInput = {
  organizationId: string
  userId: string
  connectionId?: string
  message: OutboundMessage
  providerThreadId?: string
  idempotencyKey?: string
}

export type GmailDraftActionRecord = {
  id: string
  providerDraftId: string | null
  revision: number
  state: 'creating' | 'draft' | 'updating' | 'update_unknown' | 'sending' | 'dispatching' | 'delivery_unknown' | 'sent' | 'discarded'
  contentFingerprint: string
  connectionId: string
  ownerUserId: string
  sendAfter: Date | null
}

export const toRecord = (row: {
  id: string
  providerDraftId: string | null
  revision: number
  state: string
  contentFingerprint: string
  connectionId: string
  ownerUserId: string
  sendAfter: Date | null
}): GmailDraftActionRecord => ({
  id: row.id,
  providerDraftId: row.providerDraftId,
  revision: row.revision,
  state: row.state as GmailDraftActionRecord['state'],
  contentFingerprint: row.contentFingerprint,
  connectionId: row.connectionId,
  ownerUserId: row.ownerUserId,
  sendAfter: row.sendAfter,
})

export type SendDraftInput = {
  organizationId: string
  userId: string
  draftActionId: string
  connectionId?: string
  expectedFingerprint?: string
  holdMs?: number
}

export type SendDraftResult =
  | { status: 'held'; sendAfter: Date; action: GmailDraftActionRecord }
  | { status: 'sent'; sentMessageId: string; action: GmailDraftActionRecord }
