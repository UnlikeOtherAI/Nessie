export const parseChannelIdFromPath = (pathname: string): string | undefined => {
  const match = pathname.match(/^\/channels(?:\/([^/]+))?$/)
  return match?.[1]
}

export const parseChannelProjectIdFromPath = (pathname: string): string | undefined => {
  const match = pathname.match(/^\/channels\/projects\/([^/]+)$/)
  return match?.[1]
}
