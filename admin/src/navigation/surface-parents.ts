import type { SurfaceParent } from './page-types'

export const toChannels = (): SurfaceParent => ({ label: 'Back to Channels', pathname: '/channels' })
export const toProjects = (): SurfaceParent => ({ label: 'Back to Projects', pathname: '/projects' })
export const toKnowledge = (): SurfaceParent => ({ label: 'Back to Knowledge', pathname: '/knowledge-base' })
export const toDashboards = (): SurfaceParent => ({ label: 'Back to Dashboards', pathname: '/dashboards' })
export const toAdmin = (): SurfaceParent => ({ label: 'Back to Admin', pathname: '/settings' })
export const toApps = (): SurfaceParent => ({ label: 'Apps', pathname: '/apps' })
export const toAgents = (): SurfaceParent => ({ label: 'Back to Agents', pathname: '/agents' })
export const toWorkflows = (): SurfaceParent => ({
  label: 'Back to Workflows',
  pathname: '/agents/workflows',
})
export const toStatuses = (): SurfaceParent => ({
  label: 'Back to Statuses',
  pathname: '/settings/statuses',
})
