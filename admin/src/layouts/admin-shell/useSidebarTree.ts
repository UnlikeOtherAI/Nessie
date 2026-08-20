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
}: UseSidebarTreeArgs) => {
  const standardChannels = channels.filter((channel) => channel.type !== 'dm')
  const standaloneChannels = standardChannels.filter((channel) => channel.scope === 'standalone')
  const projectChannels = standardChannels.filter((channel) => channel.scope !== 'standalone')
  const channelsByProject = new Map<string, ChannelRecord[]>()
  const sourceProjectsById = new Map<string, ProjectRecord>()

  for (const project of projects) {
    sourceProjectsById.set(project.id, project)
  }

  for (const channel of projectChannels) {
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

  for (const channel of projectChannels) {
    if (!teamIdByProjectId.has(channel.projectId)) {
      teamIdByProjectId.set(channel.projectId, channel.teamId)
    }
  }

  // Standalone channels live in one hidden, system-owned project per
  // organization. They are deliberately rendered here rather than under that
  // implementation container; every other channel remains under its real
  // project, including the active UOA workspace.
  const visibleStandaloneChannels = standaloneChannels.filter(
    (channel) => !starredChannelIds.has(channel.id),
  )
  const visibleSidebarProjects = sidebarProjects
    .filter((project) => !starredProjectIds.has(project.id))
    .map((project) => ({
      ...project,
      channels: project.channels.filter((channel) => !starredChannelIds.has(channel.id)),
    }))
    .filter(
      (project) =>
        project.channels.length > 0
        || projectById.get(project.id)?.channels.length === 0,
    )

  return {
    channelById,
    projectById,
    sidebarProjects,
    standardChannels,
    teamIdByProjectId,
    visibleSidebarProjects,
    standaloneChannels: visibleStandaloneChannels,
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
  ],
)
