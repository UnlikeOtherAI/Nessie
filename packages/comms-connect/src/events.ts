import type { CommsProviderId } from './provider.js'

/**
 * One participant of a conversation event (author, recipient, cc, member).
 * Providers fill whatever identity fields they have; `externalId` is the only
 * required field.
 */
export type EventParticipant = {
  externalId: string
  displayName?: string
  email?: string
  role?: 'from' | 'to' | 'cc' | 'bcc' | 'member'
}

export type EventAttachment = {
  externalId?: string
  name?: string
  mimeType?: string
  sizeBytes?: number
  url?: string
}

export type EventMention = {
  externalId: string
  displayName?: string
}

export type EventReaction = {
  key: string
  count?: number
  userExternalIds?: string[]
}

/**
 * The provider-agnostic normalized event. Mirrors the `CommsEvent` table one
 * for one so the worker can persist it directly. `canonicalMessageId` is the
 * deterministic dedupe key built by {@link buildCanonicalMessageId};
 * `version`/`isDeleted`/`editedAt` model edit history separately from the
 * message identity.
 */
export type NormalizedEvent = {
  canonicalMessageId: string
  version: number
  isDeleted: boolean
  editedAt?: string
  provider: CommsProviderId
  externalTenantId: string
  conversationId: string
  threadId?: string
  messageId: string
  eventType: string
  occurredAt: string
  senderExternalId?: string
  senderDisplayName?: string
  senderEmail?: string
  participants: EventParticipant[]
  subject?: string
  contentText?: string
  contentHtml?: string
  attachments: EventAttachment[]
  mentions: EventMention[]
  reactions: EventReaction[]
  visibility: string
  sourceUrl?: string
  rawPayloadRef?: string
}
