import type {
  ChannelDirectoryEntry,
  ProjectDirectoryEntry,
} from '@nessie/schemas'

import type { GlobalSearchMode, GlobalSearchResults } from '../../../facades/search/hooks'
import type { SearchMarkerSubject } from './SearchResultMarker'
import { appDetailHref } from '../apps/app-card-presentation'
import { selectBestPassage } from '../../../lib/highlight-passage'
import i18n from '../../../i18n/i18n'

const searchText = (key: string, fallback: string, values?: Record<string, string>): string => {
  if (!i18n.isInitialized) {
    return Object.entries(values ?? {}).reduce(
      (text, [name, value]) => text.replaceAll(`{{${name}}}`, value),
      fallback,
    )
  }
  return i18n.t(key, { ns: 'search', ...values })
}

export const SEARCH_SECTION_ORDER = [
  'Channels',
  'Projects',
  'Tickets',
  'Messages',
  'Knowledge',
  'People',
  'Agents',
  'Apps',
  'Memory',
] as const

export type SearchSectionTitle = (typeof SEARCH_SECTION_ORDER)[number]

export type SearchResultItem = {
  href?: string
  id: string
  primary: string
  secondary?: string
  section: SearchSectionTitle
  subject: SearchMarkerSubject
}

const excerpt = (value: string | null | undefined, query: string, length = 180): string | null => {
  const text = value?.trim()
  if (!text) return null
  if (text.length <= length) return text
  const needle = query.trim().toLowerCase()
  const match = needle ? text.toLowerCase().indexOf(needle) : -1
  const start = match < 0 ? 0 : Math.max(0, match - Math.floor(length / 3))
  const end = Math.min(text.length, start + length)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

const channelParts = (entry: ChannelDirectoryEntry) => entry.access === 'full'
  ? {
      description: entry.channel.description,
      id: entry.channel.id,
      label: entry.channel.label,
      projectName: entry.channel.projectName,
      visibility: entry.channel.visibility,
    }
  : {
      description: entry.description,
      id: entry.id,
      label: entry.label,
      projectName: entry.projectName,
      visibility: entry.visibility,
    }

const projectParts = (entry: ProjectDirectoryEntry) => ({
  description: entry.description,
  id: entry.id,
  name: entry.name,
  project: entry.access === 'full' ? entry.project : null,
  visibility: entry.visibility,
})

const matchedAppContext = (
  app: GlobalSearchResults['apps'][number],
  query: string,
): string => {
  const needle = query.trim().toLowerCase()
  const alias = app.aliases.find((value) => value.toLowerCase().includes(needle))
  if (alias) return searchText('alias', 'Alias: {{value}}', { value: alias })
  const tag = app.tags.find((value) => value.toLowerCase().includes(needle))
  if (tag) return searchText('tag', 'Tag: {{value}}', { value: tag })
  return app.shortDescription
}

const takePerSection = (
  items: SearchResultItem[],
  limitPerSection: number | undefined,
): SearchResultItem[] => {
  if (!limitPerSection) return items
  const counts = new Map<SearchSectionTitle, number>()
  return items.filter((item) => {
    const count = counts.get(item.section) ?? 0
    if (count >= limitPerSection) return false
    counts.set(item.section, count + 1)
    return true
  })
}

/** One presentation map for the autocomplete and the full Search surface. */
export const buildSearchResultItems = (
  results: GlobalSearchResults,
  query: string,
  mode: GlobalSearchMode,
  options: { limitPerSection?: number } = {},
): SearchResultItem[] => {
  const items: SearchResultItem[] = []

  for (const entry of results.channels) {
    const channel = channelParts(entry)
    items.push({
      // The Channels surface reads its entitled channel list. A protected
      // discovery card is informative but cannot be opened there until the
      // person is added; navigating would silently show a different room.
      ...(entry.access === 'full' ? { href: `/channels/${channel.id}` } : {}),
      id: `channel:${channel.id}`,
      primary: channel.label,
      secondary: excerpt(channel.description, query)
        ?? (entry.access === 'limited'
          ? `${channel.projectName} · ${searchText('protected', 'Protected')}`
          : channel.projectName),
      section: 'Channels',
      subject: { kind: 'channel', visibility: channel.visibility },
    })
  }

  for (const entry of results.projects) {
    const project = projectParts(entry)
    items.push({
      // Public projects are readable even when the directory returns its
      // limited non-member shape. Protected discovery cards stay informative
      // rather than routing into a project surface the caller cannot load.
      ...(entry.access === 'full' || project.visibility === 'public'
        ? { href: `/projects/${project.id}` }
        : {}),
      id: `project:${project.id}`,
      primary: project.name,
      secondary: excerpt(project.description, query)
        ?? (entry.access === 'limited' && project.visibility === 'protected'
          ? searchText('protectedAskMember', 'Protected · Ask a member to add you')
          : undefined),
      section: 'Projects',
      subject: {
        kind: 'project',
        project: project.project,
        visibility: project.visibility,
      },
    })
  }

  for (const task of results.tasks) {
    const context = [task.externalLink?.externalKey, task.purpose, task.detail]
      .map((value) => excerpt(value, query))
      .find((value) => value?.toLowerCase().includes(query.trim().toLowerCase()))
      ?? excerpt(task.externalLink?.externalKey ?? task.purpose ?? task.detail, query)
      ?? undefined
    items.push({
      ...(task.projectId
        ? { href: `/projects/${task.projectId}/board?task=${encodeURIComponent(task.id)}` }
        : {}),
      id: `task:${task.id}`,
      primary: task.title ?? searchText('untitledTicket', 'Untitled ticket'),
      secondary: context,
      section: 'Tickets',
      subject: { kind: 'task' },
    })
  }

  for (const message of results.messages) {
    items.push({
      href: `/channels/${message.channelId}/threads/${message.threadId}`
        + `?messageId=${encodeURIComponent(message.id)}`,
      id: `message:${message.id}`,
      primary: message.snippet,
      secondary: `${message.authorName} · ${message.channelLabel}`,
      section: 'Messages',
      subject: { kind: 'message' },
    })
  }

  for (const hit of results.knowledge) {
    const passage = selectBestPassage(hit.passages)?.content
    items.push({
      href: `/knowledge-base?spaceId=${hit.page.spaceId}&pageId=${hit.page.id}`,
      id: `knowledge:${hit.page.id}`,
      primary: hit.page.title,
      secondary: passage ?? hit.snippet,
      section: 'Knowledge',
      subject: { kind: 'knowledge' },
    })
  }

  for (const person of results.people) {
    const dm = person.channelIds.find((id) => id.length > 0)
    items.push({
      href: dm ? `/channels/${dm}` : '/channels',
      id: `person:${person.id}`,
      primary: person.displayName,
      secondary: person.email,
      section: 'People',
      subject: { kind: 'person', user: person, displayName: person.displayName },
    })
  }

  for (const agent of results.agents) {
    items.push({
      href: `/agents/${agent.id}`,
      id: `agent:${agent.id}`,
      primary: agent.name,
      secondary: agent.role,
      section: 'Agents',
      subject: { kind: 'agent', agent },
    })
  }

  for (const app of results.apps) {
    items.push({
      href: appDetailHref(app),
      id: `app:${app.id}`,
      primary: app.displayName,
      secondary: matchedAppContext(app, query),
      section: 'Apps',
      subject: { kind: 'app', app },
    })
  }

  for (const thought of results.thoughts) {
    items.push({
      id: `thought:${thought.id}`,
      primary: thought.content,
      secondary: searchText(
        mode === 'semantic' ? 'memoryHybridMatch' : 'memoryFullTextMatch',
        mode === 'semantic' ? 'Memory · Hybrid match' : 'Memory · Full text match',
      ),
      section: 'Memory',
      subject: { kind: 'thought' },
    })
  }

  return takePerSection(items, options.limitPerSection)
}
