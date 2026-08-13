import { matchesAdminRoute } from './nav-items'

export type PhoneNavigationDirection = 'back' | 'forward'

export type PhoneNavigationBackTarget = {
  label: string
  pathname: string
}

type PhoneNavigationScreen = {
  depth: 0 | 1
  key: string
  section: 'admin' | 'channels' | 'knowledge' | 'projects'
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
  if (matchesAdminRoute(normalized)) {
    return phoneBackTarget('/settings', 'Back to Admin')
  }

  return phoneBackTarget('/channels', 'Back to Channels')
}

// Phone navigation is a two-level stack: each section's contextual list is the
// root and its selected destination is the detail. Nested channel inspectors,
// project sections, and sibling detail selections stay on the same screen, so
// changing a tab or query does not replay the route-level transition.
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

  if (normalized === '/knowledge-base') {
    return { depth: 0, key: 'knowledge:root', section: 'knowledge' }
  }

  const knowledgeSpace = normalized.match(/^\/knowledge-base\/spaces\/([^/]+)$/)
  if (knowledgeSpace?.[1]) {
    return {
      depth: 1,
      key: `knowledge:space:${knowledgeSpace[1]}`,
      section: 'knowledge',
    }
  }

  const knowledgeView = normalized.match(/^\/knowledge-base\/views\/([^/]+)$/)
  if (knowledgeView?.[1]) {
    return {
      depth: 1,
      key: `knowledge:view:${knowledgeView[1]}`,
      section: 'knowledge',
    }
  }

  if (normalized === '/settings') {
    return { depth: 0, key: 'admin:root', section: 'admin' }
  }

  if (matchesAdminRoute(normalized)) {
    return {
      depth: 1,
      key: `admin:detail:${normalized}`,
      section: 'admin',
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

// A phone Knowledge root is the space picker, not an open space. Retain the
// provider's selection so a detail can restore its workspace, but don't leave
// that prior choice painted as active after Back returns to the picker.
export const shouldHighlightKnowledgeSidebarSelection = (
  pathname: string,
  phoneLayout: boolean,
): boolean => !phoneLayout || normalizePathname(pathname) !== '/knowledge-base'
