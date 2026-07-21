import type { Resource } from '@nessie/comms-connect'

import type { SlackClient } from './client.js'
import type { SlackConversation, SlackConvType } from './types.js'

const CONVERSATION_TYPES = 'public_channel,private_channel,im,mpim'
const PAGE_LIMIT = '200'
/** Safety valve so a runaway `next_cursor` cannot page forever. */
const MAX_CONVERSATION_PAGES = 100

type ConversationsResponse = {
  ok: boolean
  error?: string
  channels?: SlackConversation[]
  response_metadata?: { next_cursor?: string }
}

export const conversationType = (
  conversation: SlackConversation,
): SlackConvType => {
  if (conversation.is_im) {
    return 'im'
  }
  if (conversation.is_mpim) {
    return 'mpim'
  }
  if (conversation.is_private) {
    return 'private_channel'
  }
  return 'public_channel'
}

/** Page `users.conversations` fully into a flat list the caller can classify. */
export const fetchAllConversations = async (
  client: SlackClient,
  token: string,
): Promise<SlackConversation[]> => {
  const all: SlackConversation[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_CONVERSATION_PAGES; page += 1) {
    const response = await client.call<ConversationsResponse>({
      method: 'users.conversations',
      token,
      params: {
        types: CONVERSATION_TYPES,
        limit: PAGE_LIMIT,
        exclude_archived: 'true',
        cursor,
      },
    })
    all.push(...(response.channels ?? []))
    cursor = response.response_metadata?.next_cursor || undefined
    if (!cursor) {
      break
    }
  }
  return all
}

/**
 * Map one Slack conversation to a {@link Resource}. Channels default to
 * `syncEnabled: true`; DMs and group DMs default to `false` — the
 * privacy-conservative stance the spec (§7.3, §18) calls for.
 */
export const toResource = (conversation: SlackConversation): Resource => {
  const type = conversationType(conversation)
  const resourceType =
    type === 'im' ? 'dm' : type === 'mpim' ? 'group_dm' : 'channel'
  const isChannel = type === 'public_channel' || type === 'private_channel'
  return {
    resourceType,
    externalId: conversation.id,
    name: conversation.name ?? conversation.user,
    visibility: type === 'public_channel' ? 'public' : 'private',
    userHasAccess: true,
    syncEnabled: isChannel,
  }
}
