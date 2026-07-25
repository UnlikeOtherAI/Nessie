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
  label: string
  orgName?: string
}

/** Flatten `me.memberships` (org → projects → teams) into the workspace list. */
export const workspacesFromMe = (me: MeResponse | null): Workspace[] => {
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

/** The workspace the session is currently scoped to, if it is still listed. */
export const activeWorkspace = (me: MeResponse | null): Workspace | null =>
  workspacesFromMe(me).find((workspace) => workspace.teamId === me?.context.teamId)
  ?? null
