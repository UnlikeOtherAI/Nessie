import { originalHumanAuthorId } from '@nessie/runtime'
import type { Pool } from 'pg'
import type { PrivateConversationSource } from './disclosure-sources.js'

type ConsolidationMessage = {
  agent_id: string | null
  id: string
  metadata?: unknown
  on_behalf_of_user_id?: string | null
  role: string
  user_id: string | null
}

type StoredSource = PrivateConversationSource & { messageId: string }

type SourceCarrier = ConsolidationMessage & {
  privateConversationSources?: PrivateConversationSource[]
}

const addSource = (
  sources: Map<string, PrivateConversationSource[]>,
  messageId: string,
  source: PrivateConversationSource,
): void => {
  const existing = sources.get(messageId) ?? []
  if (!existing.some((item) =>
    item.sourceChannelId === source.sourceChannelId
    && item.sourceAuthorUserId === source.sourceAuthorUserId,
  )) existing.push(source)
  sources.set(messageId, existing)
}

/**
 * Source rows are authoritative for derived messages. A raw human turn has no
 * row of its own, so its stored structural authorship is the sole proof. Every
 * other unproven row carries an explicit unknown source to prevent another B
 * row from making the whole consolidation candidate look attributable to B.
 */
export const attachConsolidationDisclosureSources = async <T extends SourceCarrier>(
  db: Pick<Pool, 'query'>,
  input: {
    channelId: string
    channelVisibility: string | null
    messages: readonly T[]
  },
): Promise<T[]> => {
  if (input.messages.length === 0 || input.channelVisibility === 'public') {
    return [...input.messages]
  }

  const result = await db.query(
    `SELECT
       message_id AS "messageId",
       source_channel_id AS "sourceChannelId",
       source_author_user_id AS "sourceAuthorUserId"
     FROM message_disclosure_sources
     WHERE message_id = ANY($1::uuid[])`,
    [input.messages.map((message) => message.id)],
  )
  const sources = new Map<string, PrivateConversationSource[]>()
  for (const source of result.rows as StoredSource[]) {
    addSource(sources, source.messageId, {
      sourceAuthorUserId: source.sourceAuthorUserId,
      sourceChannelId: source.sourceChannelId,
    })
  }

  return input.messages.map((message) => {
    const persisted = sources.get(message.id)
    if (persisted && persisted.length > 0) {
      return { ...message, privateConversationSources: persisted }
    }
    const sourceAuthorUserId = originalHumanAuthorId({
      agentId: message.agent_id,
      metadata: message.metadata,
      onBehalfOfUserId: message.on_behalf_of_user_id ?? null,
      role: message.role,
      userId: message.user_id,
    })
    return {
      ...message,
      privateConversationSources: [{
        sourceAuthorUserId,
        sourceChannelId: input.channelId,
      }],
    }
  })
}
