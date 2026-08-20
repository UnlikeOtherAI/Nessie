import { useMemo } from 'react'
import type {
  ChannelRecord,
  ProjectRecord,
  TeamRecord,
} from '../../lib/api-client'
import type { SidebarProject } from './types'

type UseSidebarTreeArgs = {
  channels: ChannelRecord[]
  projects: ProjectRecord[]
  starredChannelIds: Set<string>
  starredProjectIds: Set<string>
  teams: TeamRecord[]
  workspaceProjectId?: string
  workspaceTeamId?: string
}

/**
 * Builds the derived sidebar project/channel tree and the lookup maps the
 * shell uses to render its navigation.
 */
export const buildSidebarTree = ({
  channels,
  projects,
  starredChannelIds,
  starredProjectIds,
  teams,
  workspaceProjectId,
  workspaceTeamId,
}: UseSidebarTreeArgs) => {
  const standardChannels = channels.filter((channel) => channel.type !== 'dm')
  const channelsByProject = new Map<string, ChannelRecord[]>()
  const sourceProjectsById = new Map<string, ProjectRecord>()

  for (const project of projects) {
    sourceProjectsById.set(project.id, project)
  }

  for (const channel of standardChannels) {
    const projectChannels = channelsByProject.get(channel.projectId) ?? []
    projectChannels.push(channel)
    channelsByProject.set(channel.projectId, projectChannels)

    if (!sourceProjectsById.has(channel.projectId)) {
      sourceProjectsById.set(channel.projectId, {
        createdAt: channel.createdAt,
        id: channel.projectId,
        memberCount: 0,
        name: channel.projectName,
        organizationId: channel.organizationId,
      })
    }
  }

  const sidebarProjects: SidebarProject[] = Array.from(sourceProjectsById.values())
    .map((project) => ({
      ...project,
      channels: (channelsByProject.get(project.id) ?? [])
        .slice()
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    }))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  const channelById = new Map(channels.map((channel) => [channel.id, channel]))
  const projectById = new Map(sidebarProjects.map((project) => [project.id, project]))
  const teamIdByProjectId = new Map<string, string>()

  for (const team of teams) {
    if (!teamIdByProjectId.has(team.projectId)) {
      teamIdByProjectId.set(team.projectId, team.id)
    }
  }

  for (const channel of standardChannels) {
    if (!teamIdByProjectId.has(channel.projectId)) {
      teamIdByProjectId.set(channel.projectId, channel.teamId)
    }
  }

  // The old bootstrap UUID is not present in UOA-provisioned workspaces. The
  // session's exact workspace is therefore the Channels section's home. This
  // changes only where authorized rows appear: every other project remains in
  // the Projects section below rather than being filtered out of the list.
  const workspaceProject = workspaceProjectId
    ? projectById.get(workspaceProjectId)
    : undefined
  const workspaceProjectChannels = workspaceProject?.channels.filter(
    (channel) => !starredChannelIds.has(channel.id),
  ) ?? []
  const workspaceProjectTeamId = workspaceTeamId
    ?? (workspaceProjectId ? teamIdByProjectId.get(workspaceProjectId) : undefined)
  const visibleSidebarProjects = sidebarProjects
    .filter((project) => !starredProjectIds.has(project.id))
    .map((project) => ({
      ...project,
      // A channel has one sidebar home. The current workspace's channels are
      // in Channels, while its project row remains the in-context doorway to
      // the project dashboard and its channel creation action.
      channels: project.id === workspaceProjectId
        ? []
        : project.channels.filter((channel) => !starredChannelIds.has(channel.id)),
    }))
    .filter(
      (project) =>
        project.id === workspaceProjectId
        || project.channels.length > 0
        || projectById.get(project.id)?.channels.length === 0,
    )

  return {
    channelById,
    projectById,
    sidebarProjects,
    standardChannels,
    teamIdByProjectId,
    visibleSidebarProjects,
    workspaceProjectChannels,
    workspaceProjectName: workspaceProject?.name,
    workspaceProjectTeamId,
  }
}

export const useSidebarTree = (args: UseSidebarTreeArgs) => useMemo(
  () => buildSidebarTree(args),
  [
    args.channels,
    args.projects,
    args.starredChannelIds,
    args.starredProjectIds,
    args.teams,
    args.workspaceProjectId,
    args.workspaceTeamId,
  ],
)
