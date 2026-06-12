export type ChannelScopeSource = {
  label: string
  team: {
    name: string
    project: {
      name: string
    }
  } | null
}

export const MAX_SEARCH_RESULTS = 5

export const truncate = (value: string, maxLength = 220): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`

export const clampLimit = (value: unknown, fallback: number): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), 20)
}

export const buildSnippet = (content: string, query: string, maxLength = 180): string => {
  const trimmedQuery = query.trim()
  if (!trimmedQuery) {
    return truncate(content, maxLength)
  }

  const lowerContent = content.toLowerCase()
  const lowerQuery = trimmedQuery.toLowerCase()
  const index = lowerContent.indexOf(lowerQuery)
  if (index < 0) {
    return truncate(content, maxLength)
  }

  const halfWindow = Math.floor(maxLength / 2)
  const start = Math.max(0, index - halfWindow)
  const end = Math.min(content.length, index + trimmedQuery.length + halfWindow)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < content.length ? '…' : ''
  return `${prefix}${content.slice(start, end)}${suffix}`
}

export const formatSection = (title: string, lines: string[]): string => {
  if (lines.length === 0) {
    return ''
  }

  return [title, ...lines].join('\n')
}

export const formatChannelScope = (channel: ChannelScopeSource): string => {
  const projectName = channel.team?.project.name ?? 'Unknown project'
  const teamName = channel.team?.name ?? 'Unknown team'
  return `${projectName} / ${teamName}`
}

export const formatChannelRef = (channel: ChannelScopeSource): string =>
  `#${channel.label} (${formatChannelScope(channel)})`

export const formatMessageLine = (input: {
  author: string
  channelLabel: string
  createdAt: string
  messageId: string
  snippet: string
  threadLabel: string | null
  threadId: string
}) =>
  [
    `- ${input.author} | ${input.channelLabel}${input.threadLabel ? ` / ${input.threadLabel}` : ''}`,
    `  ${input.createdAt} | messageId=${input.messageId} | threadId=${input.threadId}`,
    `  ${input.snippet}`,
  ].join('\n')
