import type { AgentRecord, ThreadMessageRecord } from '../../../lib/api-client'

export type OptimisticMessage = {
  clientId: string
  content: string
  createdAt: string
  status: 'sending' | 'failed'
}

export type ChannelTab = 'agents' | 'files' | 'info' | 'messages' | 'runs'

export type FeedItem =
  | { kind: 'date'; label: string }
  | { kind: 'message'; message: ThreadMessageRecord }

export const toolbarButtonClass = [
  'flex h-7 w-7 items-center justify-center rounded text-[color:var(--tx3)]',
  'hover:bg-[var(--overlay)]',
].join(' ')

export const runsCardClass = [
  'admin-card flex items-start gap-3 p-3 text-left',
  'hover:bg-[color:var(--main-hover)]',
].join(' ')

export const isOperationsTab = (tab: ChannelTab): boolean =>
  tab === 'agents' || tab === 'runs'

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

export const formatClock = (value: string): string =>
  new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

export const buildFeedItems = (messages: ThreadMessageRecord[]): FeedItem[] => {
  const items: FeedItem[] = []
  let previousDateLabel: string | null = null

  for (const message of messages) {
    const dateLabel = formatDayLabel(message.createdAt)
    if (dateLabel !== previousDateLabel) {
      items.push({ kind: 'date', label: dateLabel })
      previousDateLabel = dateLabel
    }
    items.push({ kind: 'message', message })
  }

  return items
}

export const getAgentGlyph = (agent?: AgentRecord | null): string => {
  if (!agent) {
    return '⚡'
  }

  const role = agent.role.toLowerCase()
  if (role.includes('research')) {
    return '🔍'
  }
  if (role.includes('write')) {
    return '📝'
  }
  return '⚡'
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

  return meDisplayName
}
