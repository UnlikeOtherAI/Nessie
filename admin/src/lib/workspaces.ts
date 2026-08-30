import type { MeResponse } from '@nessie/schemas'

/**
 * A workspace is a team — the environment a user enters. `me.context` carries
 * only the active ids, so the human-readable label has to come from the
 * membership tree. Shared by the sidebar switcher and the workspace settings.
 */
export type Workspace = {
  organizationId: string
  projectId: string
  teamId: string
  avatarTeamId?: string
  avatarImageUrl?: string
  label: string
  orgName?: string
  active?: boolean
  uoaWorkspace?: boolean
}

/** Flatten `me.memberships` (org → projects → teams) into the workspace list. */
export const workspacesFromMe = (me: MeResponse | null): Workspace[] => {
  if (me?.auth.providerType === 'uoa' && me.uoaWorkspaces?.length) {
    const localOrganizationNames = new Map<string, string>(
      me.memberships?.flatMap((membership) => membership.organizationName
        ? [[membership.organizationId, membership.organizationName] as const]
        : []) ?? [],
    )
    return me.uoaWorkspaces.map((workspace) => ({
      organizationId: workspace.organizationId,
      projectId: '',
      teamId: workspace.teamId,
      ...(workspace.avatarTeamId ? { avatarTeamId: workspace.avatarTeamId } : {}),
      ...(workspace.avatarImageUrl ? { avatarImageUrl: workspace.avatarImageUrl } : {}),
      label: workspace.label,
      orgName: workspace.orgName ?? localOrganizationNames.get(workspace.organizationId),
      active: workspace.active,
      uoaWorkspace: true,
    }))
  }
  if (!me?.memberships) {
    return []
  }
  const list: Workspace[] = []
  for (const org of me.memberships) {
    for (const project of org.projects) {
      for (const team of project.teams) {
        list.push({
          organizationId: org.organizationId,
          projectId: project.projectId,
          teamId: team.teamId,
          label: team.teamName ?? project.projectName ?? 'Workspace',
          orgName: org.organizationName,
        })
      }
    }
  }
  return list
}

/** Keep UOA's directory order, but surface the current workspace first. */
export const orderWorkspacesWithActiveFirst = (
  workspaces: Workspace[],
  activeTeamId: string | null,
): Workspace[] => [
  ...workspaces.filter((workspace) => workspace.active || workspace.teamId === activeTeamId),
  ...workspaces.filter((workspace) => !workspace.active && workspace.teamId !== activeTeamId),
]

/** The workspace the session is currently scoped to, if it is still listed. */
export const activeWorkspace = (me: MeResponse | null): Workspace | null =>
  workspacesFromMe(me).find(
    (workspace) => workspace.active || workspace.teamId === me?.context.teamId,
  )
  ?? null
