import type { SurfaceParent } from './page-types'

export const toChannels = (): SurfaceParent => ({ label: 'Back to Channels', pathname: '/channels' })
export const toProjects = (): SurfaceParent => ({ label: 'Back to Projects', pathname: '/projects' })
export const toKnowledge = (): SurfaceParent => ({ label: 'Back to Knowledge', pathname: '/knowledge-base' })

// ── Admin (the rail's section) ─────────────────────────────────────────────
export const toAdmin = (): SurfaceParent => ({ label: 'Back to Admin', pathname: '/admin' })
export const toAgents = (): SurfaceParent => ({ label: 'Back to Agents', pathname: '/admin/agents' })
export const toApps = (): SurfaceParent => ({ label: 'Apps', pathname: '/admin/apps' })
export const toComputers = (): SurfaceParent => ({
  label: 'Back to Computers',
  pathname: '/admin/computers',
})
export const toComputerSessions = (): SurfaceParent => ({
  label: 'Sessions',
  pathname: '/admin/computers/sessions',
})
export const toAutomations = (): SurfaceParent => ({
  label: 'Back to Automations',
  pathname: '/admin/automations',
})
export const toTeams = (): SurfaceParent => ({ label: 'Back to Teams', pathname: '/admin/teams' })
export const toOrganizationSecurity = (): SurfaceParent => ({
  label: 'Back to Security',
  pathname: '/admin/security',
})
export const toToolRegistry = (): SurfaceParent => ({
  label: 'Back to Tool registry',
  pathname: '/admin/advanced/tools',
})

// ── Your settings (the avatar menu's pages) ────────────────────────────────
export const toSettings = (): SurfaceParent => ({
  label: 'Back to Your settings',
  pathname: '/settings',
})
export const toConnectedAccounts = (): SurfaceParent => ({
  label: 'Back to Connected accounts',
  pathname: '/settings/accounts',
})
export const toSettingsSecurity = (): SurfaceParent => ({
  label: 'Back to Security',
  pathname: '/settings/security',
})
export const toStatus = (): SurfaceParent => ({
  label: 'Back to Status',
  pathname: '/settings/status',
})
