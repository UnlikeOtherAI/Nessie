import type { SurfaceParent } from './page-types'

export const toChannels = (): SurfaceParent => ({ label: 'Back to Channels', pathname: '/channels' })
export const toProjects = (): SurfaceParent => ({ label: 'Back to Projects', pathname: '/projects' })
export const toKnowledge = (): SurfaceParent => ({ label: 'Back to Knowledge', pathname: '/knowledge-base' })
export const toAdmin = (): SurfaceParent => ({ label: 'Back to Admin', pathname: '/settings' })
export const toApps = (): SurfaceParent => ({ label: 'Apps', pathname: '/apps' })
export const toAgents = (): SurfaceParent => ({ label: 'Back to Agents', pathname: '/agents' })
export const toExecutors = (): SurfaceParent => ({
  label: 'Back to Executors',
  pathname: '/agents/executors',
})
export const toTools = (): SurfaceParent => ({
  label: 'Back to Tools',
  pathname: '/agents/tools',
})
export const toTriggers = (): SurfaceParent => ({
  label: 'Back to Triggers',
  pathname: '/agents/triggers',
})
export const toWorkflows = (): SurfaceParent => ({
  label: 'Back to Workflows',
  pathname: '/agents/workflows',
})
export const toConnections = (): SurfaceParent => ({
  label: 'Back to Connected accounts',
  pathname: '/settings/connections',
})
export const toPairedAgents = (): SurfaceParent => ({
  label: 'Back to Paired agents',
  pathname: '/settings/paired-agents',
})
export const toOrganizationPairedAgents = (): SurfaceParent => ({
  label: 'Back to Paired agents',
  pathname: '/settings/organization/paired-agents',
})
export const toStatuses = (): SurfaceParent => ({
  label: 'Back to Statuses',
  pathname: '/settings/statuses',
})
