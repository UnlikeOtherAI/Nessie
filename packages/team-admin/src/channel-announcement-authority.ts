import { isAdminRole } from '@nessie/schemas'

/** Stable UOA IDs are references only; roles come from this request's /org/me. */
export const isAnnouncementAdministrator = (input: {
  channelType: string
  systemChannelType: string | null
  isOrganizationAdmin: boolean
  externalOrgId: string | null
  externalTeamId: string | null
  uoaTeamRoles?: Record<string, string>
  localTeamRole?: string | null
}): boolean => {
  if (input.channelType !== 'standard' || input.systemChannelType !== null) return false
  if (input.isOrganizationAdmin) return true
  if (input.externalOrgId) {
    const role = input.externalTeamId
      ? input.uoaTeamRoles?.[input.externalTeamId]?.toLowerCase()
      : undefined
    return role === 'owner' || role === 'admin'
  }
  return isAdminRole(input.localTeamRole)
}
