export type PhoneNavigationDirection = 'back' | 'forward'

type PhoneNavigationScreen = {
  depth: 0 | 1
  key: string
  section: 'channels' | 'projects'
}

const normalizePathname = (pathname: string): string => {
  const normalized = pathname.replace(/\/+$/, '')
  return normalized || '/'
}

// Phone navigation is a two-level stack: each tab's contextual list is the
// root and a selected project/channel is its detail. Nested channel inspectors
// and project sections stay on the same screen, so changing a tab or query does
// not replay the route-level transition.
export const getPhoneNavigationScreen = (
  pathname: string,
): PhoneNavigationScreen | null => {
  const normalized = normalizePathname(pathname)

  if (normalized === '/channels') {
    return { depth: 0, key: 'channels:root', section: 'channels' }
  }

  const channelProject = normalized.match(/^\/channels\/projects\/([^/]+)$/)
  if (channelProject?.[1]) {
    return {
      depth: 1,
      key: `channels:project:${channelProject[1]}`,
      section: 'channels',
    }
  }

  const channel = normalized.match(/^\/channels\/([^/]+)(?:\/.*)?$/)
  if (channel?.[1] && channel[1] !== 'new' && channel[1] !== 'projects') {
    return {
      depth: 1,
      key: `channels:channel:${channel[1]}`,
      section: 'channels',
    }
  }

  if (normalized === '/projects') {
    return { depth: 0, key: 'projects:root', section: 'projects' }
  }

  const project = normalized.match(
    /^\/projects\/([^/]+)(?:\/(?:board|backlog|insights|docs|executors|settings))?$/,
  )
  if (project?.[1]) {
    return {
      depth: 1,
      key: `projects:project:${project[1]}`,
      section: 'projects',
    }
  }

  return null
}

export const getPhoneNavigationDirection = (
  fromPathname: string,
  toPathname: string,
): PhoneNavigationDirection | null => {
  const from = getPhoneNavigationScreen(fromPathname)
  const to = getPhoneNavigationScreen(toPathname)

  if (!from || !to || from.section !== to.section || from.depth === to.depth) {
    return null
  }

  return to.depth > from.depth ? 'forward' : 'back'
}
