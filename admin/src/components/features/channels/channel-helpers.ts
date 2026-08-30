import type { AgentRecord, ThreadMessageRecord } from '../../../lib/api-client'
export { getAgentGlyph } from '../../shared/AgentAvatar'

export type OptimisticMessage = {
  clientId: string
  content: string
  createdAt: string
  status: 'sending' | 'failed'
}

export type MessageUserIdentity = {
  avatarAttachmentId?: string | null
  avatarUrl?: string | null
  displayName: string
  id: string
}

export type ChannelTab = 'agents' | 'automations' | 'files' | 'messages'

export type FeedItem =
  | { kind: 'date'; key: string; label: string }
  | { kind: 'message'; message: ThreadMessageRecord }

export const toolbarButtonClass = [
  'admin-compose-action flex h-7 w-7 items-center justify-center rounded text-[color:var(--tx3)]',
  'hover:bg-[var(--overlay)]',
].join(' ')

// The Agents tab only exists where it has something to say: any ordinary
// channel, or a conversation surface that carries the Personal Assistant config
// or at least one bound agent. A person-to-person DM shows Messages + Files
// only. One predicate drives both the tab button and the fallback to Messages,
// so a tab can never be selected without a panel behind it.
export const isAgentsTabAvailable = (input: {
  boundAgentCount: number
  isConversationSurface: boolean
  isPersonalAssistantConversation: boolean
}): boolean =>
  !input.isConversationSurface ||
  input.isPersonalAssistantConversation ||
  input.boundAgentCount > 0

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

export const getDisplayName = (
  entry: ThreadMessageRecord,
  meDisplayName: string,
  agentMap: Map<string, AgentRecord>,
  assistantFallbackName = 'Agent',
): string => {
  if (entry.role === 'assistant') {
    return agentMap.get(entry.agentId ?? '')?.name ?? assistantFallbackName
  }

  if (entry.role === 'system') {
    return 'System'
  }

  // Prefer the message's embedded author so every sender shows their own name
  // (not the viewer's). Fall back to the viewer's name for optimistic messages
  // and any legacy row that predates author hydration.
  return entry.author?.displayName ?? meDisplayName
}
