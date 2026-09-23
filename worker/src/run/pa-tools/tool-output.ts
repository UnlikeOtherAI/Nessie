import { buildChannelMessagePath } from '@nessie/schemas'

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

export type ChannelScopeSource = {
  label: string
  team: {
    name: string
    project: {
      name: string
    }
  } | null
}

export const formatChannelScope = (channel: ChannelScopeSource): string => {
  const projectName = channel.team?.project.name ?? 'Unknown project'
  const teamName = channel.team?.name ?? 'Unknown team'
  return `${projectName} / ${teamName}`
}

export const formatChannelRef = (channel: ChannelScopeSource): string =>
  `#${channel.label} (${formatChannelScope(channel)})`

// The one place a search-tool result becomes a clickable admin path, so the
// model never has to assemble route segments itself — it copies `link=`
// verbatim. Relative (no origin): every caller renders these inside the
// admin app that posted the message, where a relative href already resolves
// correctly (see MessageMarkdown's plain <a> renderer).
export const buildChannelLink = (channelId: string): string => `/channels/${channelId}`

// A name inside markdown link text: a bracket would end the text early.
const markdownLinkText = (text: string): string =>
  text.replace(/[[\]\\]/g, (character) => `\\${character}`)

// What a tool that just placed something says about where it is: a link a
// model can hand to a person as it is. A bare `channelId=<uuid>` was copied
// into the reply verbatim, so the person read a UUID where a room should be.
export const formatChannelMarkdownLink = (channel: { id: string; label: string }): string =>
  `[#${markdownLinkText(channel.label)}](${buildChannelLink(channel.id)})`

export const formatAgentMarkdownLink = (agent: { id: string; name: string }): string =>
  `[${markdownLinkText(agent.name)}](/agents/${agent.id})`

export const formatProjectMarkdownLink = (project: { id: string; name: string }): string =>
  `[${markdownLinkText(project.name)}](/projects/${project.id})`

// The Triggers page's own detail route. Its last segment is the triggerId
// agent_trigger_update and agent_trigger_delete take, as an agent link's is
// the agentId.
export const formatTriggerMarkdownLink = (trigger: { id: string; name: string }): string =>
  `[${markdownLinkText(trigger.name)}](/agents/triggers/${trigger.id})`

// A reply-thread deep link is always anchored to the ROOT of its thread
// (`Message.rootMessageId ?? Message.id` — the same resolution the worker
// uses to place a run's own reply, `resolveReplyRootMessageId`), never to an
// arbitrary reply within it: there is no URL form for "highlight this one
// reply" today (only in-app navigation state can do that).
export const buildMessageLink = (input: {
  channelId: string
  messageId: string
  rootMessageId: string | null
  threadId: string
}): string =>
  buildChannelMessagePath(input)

export const buildSnippet = (
  content: string,
  query: string,
  maxLength = 180,
): string => {
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

export const formatMessageLine = (input: {
  author: string
  channelId: string
  channelLabel: string
  createdAt: string
  messageId: string
  rootMessageId: string | null
  snippet: string
  threadLabel: string | null
  threadId: string
}) =>
  [
    `- ${input.author} | ${input.channelLabel}${input.threadLabel ? ` / ${input.threadLabel}` : ''}`,
    `  ${input.createdAt} | messageId=${input.messageId} | threadId=${input.threadId}`,
    `  link=${buildMessageLink(input)}`,
    `  ${input.snippet}`,
  ].join('\n')
