export const parseChannelIdFromPath = (pathname: string): string | undefined => {
  const match = pathname.match(/^\/channels(?:\/([^/]+))?$/)
  return match?.[1]
}
