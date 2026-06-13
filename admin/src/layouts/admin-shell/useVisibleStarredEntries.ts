import { useMemo } from 'react'

import type { AgentRecord, ChannelRecord } from '../../lib/api-client'
import {
  DEFAULT_BOOTSTRAP_PROJECT_ID,
  type SidebarPerson,
  type SidebarProject,
  type StarredItem,
  type VisibleStarredEntry,
} from './types'

type UseVisibleStarredEntriesInput = {
  agentById: Map<string, AgentRecord>
  channelById: Map<string, ChannelRecord>
  projectById: Map<string, SidebarProject>
  sidebarPeople: SidebarPerson[]
  starred: StarredItem[]
  starredProjectIds: Set<string>
}

export const useVisibleStarredEntries = ({
  agentById,
  channelById,
  projectById,
  sidebarPeople,
  starred,
  starredProjectIds,
}: UseVisibleStarredEntriesInput): VisibleStarredEntry[] =>
  useMemo(() => {
    const entries: VisibleStarredEntry[] = []
    const projectEntryById = new Map<string, Extract<VisibleStarredEntry, { type: 'project' }>>()

    const addProjectEntry = (
      project: SidebarProject,
      channelsToShow: ChannelRecord[],
      starredProject: boolean,
    ) => {
      const existing = projectEntryById.get(project.id)
      if (existing) {
        if (starredProject) {
          existing.channels = channelsToShow
          existing.starred = true
          return
        }

        const existingChannelIds = new Set(existing.channels.map((channel) => channel.id))
        existing.channels = [
          ...existing.channels,
          ...channelsToShow.filter((channel) => !existingChannelIds.has(channel.id)),
        ]
        return
      }

      const entry: Extract<VisibleStarredEntry, { type: 'project' }> = {
        channels: channelsToShow,
        project,
        starred: starredProject,
        type: 'project',
      }
      projectEntryById.set(project.id, entry)
      entries.push(entry)
    }

    for (const item of starred) {
      if (item.type === 'project') {
        if (item.id === DEFAULT_BOOTSTRAP_PROJECT_ID) continue
        const project = projectById.get(item.id)
        if (project) {
          addProjectEntry(project, project.channels, true)
        }
        continue
      }

      if (item.type === 'channel') {
        const channel = channelById.get(item.id)
        if (!channel) continue

        if (channel.projectId === DEFAULT_BOOTSTRAP_PROJECT_ID) {
          entries.push({ channel, type: 'channel' })
          continue
        }

        if (starredProjectIds.has(channel.projectId)) continue

        const project = projectById.get(channel.projectId)
        if (project) {
          addProjectEntry(project, [channel], false)
        }
        continue
      }

      if (item.type === 'agent') {
        const agent = agentById.get(item.id)
        if (agent) {
          entries.push({ agent, type: 'agent' })
        }
        continue
      }

      const person = sidebarPeople.find((candidate) => candidate.id === item.id)
      if (person) {
        entries.push({ person, type: 'user' })
      }
    }

    return entries
  }, [agentById, channelById, projectById, sidebarPeople, starred, starredProjectIds])
