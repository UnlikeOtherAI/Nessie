export type ChannelComposeLocationState = {
  returnTo?: string
}

const isInternalRoute = (path: string): boolean => path.startsWith('/') && !path.startsWith('//')
const isComposeRoute = (path: string): boolean =>
  path === '/channels/new' || path.startsWith('/channels/new?') || path.startsWith('/channels/new#')

export const newChannelComposeLocationState = (
  returnTo: string,
): ChannelComposeLocationState => ({ returnTo })

// A compose route can be opened from a bookmark or notification, where there
// is no in-app history to return to. Keep its exit inside Nessie in either case.
export const readChannelComposeReturnTo = (state: unknown): string => {
  if (
    state &&
    typeof state === 'object' &&
    'returnTo' in state &&
    typeof state.returnTo === 'string' &&
    isInternalRoute(state.returnTo) &&
    !isComposeRoute(state.returnTo)
  ) {
    return state.returnTo
  }
  return '/channels'
}
