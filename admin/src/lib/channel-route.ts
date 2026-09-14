export const parseChannelIdFromPath = (pathname: string): string | undefined => {
  const match = pathname.match(/^\/channels\/([^/]+)(?:\/|$)/)
  const candidate = match?.[1]
  return candidate === 'new' || candidate === 'projects' ? undefined : candidate
}

/**
 * The thread a channel route names, whatever hangs off it: the conversation
 * itself (`/channels/:id/threads/:threadId`), a reply panel or a presented
 * dashboard over it. A bare channel route names no thread — its thread is the
 * room's General one, which only the channel record knows
 * (docs/plans/2026-09-08-agent-conversations.md).
 */
export const parseThreadIdFromPath = (pathname: string): string | undefined => {
  const match = pathname.match(/^\/channels\/[^/]+\/threads\/([^/]+)(?:\/|$)/)
  return match?.[1]
}

export const parseReplyRootMessageIdFromPath = (pathname: string): string | undefined => {
  const match = pathname.match(/^\/channels\/[^/]+\/threads\/[^/]+\/replies\/([^/]+)\/?$/)
  return match?.[1]
}

export const parseChannelProjectIdFromPath = (pathname: string): string | undefined => {
  const match = pathname.match(/^\/channels\/projects\/([^/]+)$/)
  return match?.[1]
}
