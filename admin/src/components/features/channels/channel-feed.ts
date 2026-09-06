import type { ThreadMessageRecord, AgentRecord } from '../../../lib/api-client'

/**
 * The message feed as data: the optimistic rows the composer adds, the
 * date-separated item list the feed renders, and the two formatters every row
 * shares.
 */

export type OptimisticMessage = {
  clientId: string
  content: string
  createdAt: string
  status: 'sending' | 'failed'
}

export type FeedItem =
  | { kind: 'date'; key: string; label: string }
  | { kind: 'message'; message: ThreadMessageRecord }

const formatDayLabel = (value: string): string => {
  const date = new Date(value)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)

  const sameDay = (left: Date, right: Date) =>
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()

  if (sameDay(date, today)) {
    return 'Today'
  }

  if (sameDay(date, yesterday)) {
    return 'Yesterday'
  }

  return date.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

const formatDayKey = (value: string): string => {
  const date = new Date(value)
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

export const formatClock = (value: string): string =>
  new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

export const buildFeedItems = (messages: ThreadMessageRecord[]): FeedItem[] => {
  const items: FeedItem[] = []
  let previousDateKey: string | null = null

  for (const message of messages) {
    const dateKey = formatDayKey(message.createdAt)
    const dateLabel = formatDayLabel(message.createdAt)
    if (dateKey !== previousDateKey) {
      items.push({ kind: 'date', key: dateKey, label: dateLabel })
      previousDateKey = dateKey
    }
    items.push({ kind: 'message', message })
  }

  return items
}

/**
 * `messageAgent` is the caller's already-resolved author, not a map to look one
 * up in. It used to take the channel's `agentMap`, which comes from
 * `useAgents()`'s default scope and therefore omits every system-managed agent
 * — so an Agent Designer message fell through to the `'Agent'` last resort. The
 * lookup belongs at the call site, where the identity directory is reachable.
 */
export const getDisplayName = (
  entry: ThreadMessageRecord,
  meDisplayName: string,
  messageAgent: Pick<AgentRecord, 'name'> | null | undefined,
  assistantFallbackName = 'Agent',
  personalAssistantDisplayName?: string,
): string => {
  if (entry.role === 'assistant') {
    return personalAssistantDisplayName ?? messageAgent?.name ?? assistantFallbackName
  }

  if (entry.role === 'system') {
    return 'System'
  }

  // Prefer the message's embedded author so every sender shows their own name
  // (not the viewer's). Fall back to the viewer's name for optimistic messages
  // and any legacy row that predates author hydration.
  return entry.author?.displayName ?? meDisplayName
}
