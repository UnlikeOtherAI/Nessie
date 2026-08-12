export const parseChannelIdFromPath = (pathname: string): string | undefined => {
  const match = pathname.match(/^\/channels\/([^/]+)(?:\/|$)/)
  const candidate = match?.[1]
  return candidate === 'new' || candidate === 'projects' ? undefined : candidate
}

export const parseThreadIdFromPath = (pathname: string): string | undefined => {
  const match = pathname.match(/^\/channels\/[^/]+\/threads\/([^/]+)\/replies\/[^/]+\/?$/)
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
