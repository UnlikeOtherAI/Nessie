export type PhoneNavigationDirection = 'back' | 'forward'

export type PhoneNavigationBackTarget = {
  label: string
  pathname: string
}

type PhoneNavigationScreen = {
  depth: 0 | 1
  key: string
  section: 'channels' | 'projects'
}

const normalizePathname = (pathname: string): string => {
  const normalized = pathname.replace(/\/+$/, '')
  return normalized || '/'
}

const phoneBackTarget = (pathname: string, label: string): PhoneNavigationBackTarget => ({
  label,
  pathname,
})

// Phone tab roots own the contextual navigation list, so they keep the menu
// control. Every other routed surface gets an explicit parent destination;
// this keeps a cold deep link inside Nessie instead of depending on browser
// history being available.
export const getPhoneNavigationBackTarget = (
  pathname: string,
): PhoneNavigationBackTarget | null => {
  const normalized = normalizePathname(pathname)

  if (
    normalized === '/channels'
    || normalized === '/projects'
    || normalized === '/dashboards'
    || normalized === '/knowledge-base'
    || normalized === '/agents'
    || normalized === '/settings'
    || normalized === '/search'
  ) {
    return null
  }

  if (normalized.startsWith('/channels/')) {
    return phoneBackTarget('/channels', 'Back to Channels')
  }
  if (normalized.startsWith('/projects/')) {
    return phoneBackTarget('/projects', 'Back to Projects')
  }
  if (normalized.startsWith('/dashboards/')) {
    return phoneBackTarget('/dashboards', 'Back to Dashboards')
  }
  if (normalized.startsWith('/knowledge-base/')) {
    return phoneBackTarget('/knowledge-base', 'Back to Knowledge')
  }
  if (normalized.startsWith('/agents/')) {
    return phoneBackTarget('/agents', 'Back to Agents')
  }
  if (
    normalized.startsWith('/settings/')
    || normalized === '/mcp-app-store'
    || normalized.startsWith('/mcp-app-store/')
    || normalized === '/approvals'
    || normalized === '/audit'
    || normalized === '/tokens'
    || normalized === '/policy'
    || normalized === '/ops'
    || normalized.startsWith('/ops/')
  ) {
    return phoneBackTarget('/settings', 'Back to Admin')
  }

  return phoneBackTarget('/channels', 'Back to Channels')
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
