import {
  buildCanonicalMessageId,
  type EventAttachment,
  type EventMention,
  type EventReaction,
  type NormalizedEvent,
} from '@nessie/comms-connect'

import type { SlackConvType, SlackMessage } from './types.js'

/** Normalized-event visibility label per conversation kind (see spec §6). */
const EVENT_VISIBILITY: Record<SlackConvType, string> = {
  public_channel: 'public-channel',
  private_channel: 'private-channel',
  im: 'direct-message',
  mpim: 'group-direct-message',
}

/** Slack `channel_type` (message events) → the conversation kind we model. */
const CHANNEL_TYPE_TO_CONV: Record<string, SlackConvType> = {
  channel: 'public_channel',
  group: 'private_channel',
  im: 'im',
  mpim: 'mpim',
}

export const convTypeFromChannelType = (
  channelType: string | undefined,
): SlackConvType => CHANNEL_TYPE_TO_CONV[channelType ?? ''] ?? 'public_channel'

/** Convert a Slack `ts` (`seconds.microseconds`) to an ISO-8601 instant. */
export const slackTsToIso = (ts: string): string => {
  const [secondsPart, microPart = ''] = ts.split('.')
  const seconds = Number.parseInt(secondsPart ?? '', 10)
  const millisFromMicros = Math.floor(Number.parseInt(microPart.padEnd(6, '0'), 10) / 1000)
  return new Date(seconds * 1000 + (Number.isFinite(millisFromMicros) ? millisFromMicros : 0))
    .toISOString()
}

const MENTION_PATTERN = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g

const extractMentions = (text: string | undefined): EventMention[] => {
  if (!text) {
    return []
  }
  const seen = new Set<string>()
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const id = match[1]
    if (id) {
      seen.add(id)
    }
  }
  return [...seen].map((externalId) => ({ externalId }))
}

const mapAttachments = (message: SlackMessage): EventAttachment[] =>
  (message.files ?? []).map((file) => ({
    externalId: file.id,
    name: file.name,
    mimeType: file.mimetype,
    sizeBytes: file.size,
    url: file.url_private,
  }))

const mapReactions = (message: SlackMessage): EventReaction[] =>
  (message.reactions ?? []).map((reaction) => ({
    key: reaction.name,
    count: reaction.count,
    userExternalIds: reaction.users,
  }))

export type NormalizeInput = {
  teamId: string
  channelId: string
  convType: SlackConvType
  message: SlackMessage
  /** Override the message id (Slack sends `deleted_ts` on delete events). */
  messageTs?: string
  isDeleted?: boolean
}

/**
 * Turn one Slack message into the provider-agnostic {@link NormalizedEvent}.
 * Attachments are metadata only — bytes are never fetched. `version` is left at
 * 1; the persistence layer derives the real version from stored state, using
 * `editedAt`/`isDeleted` to distinguish an edit/delete from a duplicate.
 */
export const normalizeSlackMessage = (
  input: NormalizeInput,
): NormalizedEvent => {
  const { message } = input
  const ts = input.messageTs ?? message.ts ?? ''
  const isDeleted = input.isDeleted ?? false
  const editedAt = message.edited?.ts ? slackTsToIso(message.edited.ts) : undefined
  const eventType = isDeleted
    ? 'message.deleted'
    : editedAt
      ? 'message.updated'
      : 'message.created'

  return {
    canonicalMessageId: buildCanonicalMessageId(
      'slack',
      input.teamId,
      input.channelId,
      ts,
    ),
    version: 1,
    isDeleted,
    editedAt,
    provider: 'slack',
    externalTenantId: input.teamId,
    conversationId: input.channelId,
    threadId: message.thread_ts,
    messageId: ts,
    eventType,
    occurredAt: slackTsToIso(ts),
    senderExternalId: message.user ?? message.bot_id,
    participants: [],
    contentText: message.text,
    attachments: isDeleted ? [] : mapAttachments(message),
    mentions: isDeleted ? [] : extractMentions(message.text),
    reactions: isDeleted ? [] : mapReactions(message),
    visibility: EVENT_VISIBILITY[input.convType],
  }
}
