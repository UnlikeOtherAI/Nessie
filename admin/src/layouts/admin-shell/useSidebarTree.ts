import { useMemo } from 'react'
import type {
  ChannelRecord,
  ProjectRecord,
  TeamRecord,
} from '../../lib/api-client'
import { DEFAULT_BOOTSTRAP_PROJECT_ID, type SidebarProject } from './types'

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
export const useSidebarTree = ({
  channels,
  projects,
  starredChannelIds,
  starredProjectIds,
  teams,
}: UseSidebarTreeArgs) => {
  const standardChannels = useMemo(
    () => channels.filter((channel) => channel.type !== 'dm'),
    [channels],
  )

  const sidebarProjects = useMemo<SidebarProject[]>(() => {
    const channelsByProject = new Map<string, ChannelRecord[]>()
    const projectById = new Map<string, ProjectRecord>()

    for (const project of projects) {
      projectById.set(project.id, project)
    }

    for (const channel of standardChannels) {
      const projectChannels = channelsByProject.get(channel.projectId) ?? []
      projectChannels.push(channel)
      channelsByProject.set(channel.projectId, projectChannels)

      if (!projectById.has(channel.projectId)) {
        projectById.set(channel.projectId, {
          createdAt: channel.createdAt,
          id: channel.projectId,
          memberCount: 0,
          name: channel.projectName,
          organizationId: channel.organizationId,
        })
      }
    }

    return Array.from(projectById.values())
      .map((project) => ({
        ...project,
        channels: (channelsByProject.get(project.id) ?? [])
          .slice()
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }, [projects, standardChannels])

  const channelById = useMemo(
    () => new Map(channels.map((channel) => [channel.id, channel])),
    [channels],
  )

  const projectById = useMemo(
    () => new Map(sidebarProjects.map((project) => [project.id, project])),
    [sidebarProjects],
  )

  const teamIdByProjectId = useMemo(() => {
    const result = new Map<string, string>()

    for (const team of teams) {
      if (!result.has(team.projectId)) {
        result.set(team.projectId, team.id)
      }
    }

    for (const channel of standardChannels) {
      if (!result.has(channel.projectId)) {
        result.set(channel.projectId, channel.teamId)
      }
    }

    return result
  }, [standardChannels, teams])

  const defaultProjectChannels = useMemo(
    () =>
      sidebarProjects.find((project) => project.id === DEFAULT_BOOTSTRAP_PROJECT_ID)?.channels.filter(
        (channel) => !starredChannelIds.has(channel.id),
      ) ?? [],
    [sidebarProjects, starredChannelIds],
  )

  const defaultProjectTeamId = useMemo(
    () =>
      teamIdByProjectId.get(DEFAULT_BOOTSTRAP_PROJECT_ID)
      ?? standardChannels.find((channel) => channel.projectId === DEFAULT_BOOTSTRAP_PROJECT_ID)
        ?.teamId,
    [standardChannels, teamIdByProjectId],
  )

  const visibleSidebarProjects = useMemo(
    () =>
      sidebarProjects
        .filter(
          (project) =>
            project.id !== DEFAULT_BOOTSTRAP_PROJECT_ID && !starredProjectIds.has(project.id),
        )
        .map((project) => ({
          ...project,
          channels: project.channels.filter((channel) => !starredChannelIds.has(channel.id)),
        }))
        .filter((project) => project.channels.length > 0 || projectById.get(project.id)?.channels.length === 0),
    [projectById, sidebarProjects, starredChannelIds, starredProjectIds],
  )

  return {
    channelById,
    defaultProjectChannels,
    defaultProjectTeamId,
    projectById,
    sidebarProjects,
    standardChannels,
    teamIdByProjectId,
    visibleSidebarProjects,
  }
}
