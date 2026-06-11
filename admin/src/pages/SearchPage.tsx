import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type {
  ChannelRecord,
  MessageSearchResult,
  ProjectRecord,
  UserRecord,
} from '../lib/api-client'
import { useGlobalSearch, type KnowledgeSearchHit } from '../facades/search/hooks'
import { MobileMenuButton } from '../layouts/admin-shell/MobileMenuButton'
import { sectionTitleClass } from './settings/settings-shared'

const rowClass = [
  'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left',
  'transition-colors hover:bg-[color:var(--overlay-weak)]',
].join(' ')

const markerClass = [
  'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg',
  'bg-[color:var(--overlay-weak)] text-[13px] font-semibold text-[color:var(--tx2)]',
].join(' ')

interface SearchResultRowProps {
  marker: ReactNode
  primary: string
  secondary?: string | null
  onClick: () => void
}

const SearchResultRow = ({ marker, primary, secondary, onClick }: SearchResultRowProps) => (
  <button className={rowClass} onClick={onClick} type="button">
    <span className={markerClass}>{marker}</span>
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-medium text-[color:var(--tx)]">{primary}</span>
      {secondary ? (
        <span className="block truncate text-xs text-[color:var(--tx3)]">{secondary}</span>
      ) : null}
    </span>
  </button>
)

interface SearchSectionProps {
  title: string
  children: ReactNode
}

const SearchSection = ({ title, children }: SearchSectionProps) => (
  <section className="space-y-1">
    <h2 className={`${sectionTitleClass} px-3`}>{title}</h2>
    <div className="space-y-0.5">{children}</div>
  </section>
)

const initial = (value: string): string => value.trim().charAt(0).toUpperCase() || '?'

export const SearchPage = () => {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const results = useGlobalSearch(query)

  const active = query.trim().length >= 2
  const hasResults =
    results.channels.length > 0 ||
    results.people.length > 0 ||
    results.projects.length > 0 ||
    results.messages.length > 0 ||
    results.knowledge.length > 0

  const openChannel = (channel: ChannelRecord) => navigate(`/channels/${channel.id}`)
  const openProject = (project: ProjectRecord) => navigate(`/projects/${project.id}`)
  const openMessage = (message: MessageSearchResult) => navigate(`/channels/${message.channelId}`)
  const openKnowledge = (_hit: KnowledgeSearchHit) => navigate('/knowledge-base')

  // A person row jumps to their DM channel when one is already loaded for the
  // current user; otherwise it falls back to the channels list.
  const openPerson = (person: UserRecord) => {
    const dmChannelId = person.channelIds.find((id) => id.length > 0)
    navigate(dmChannelId ? `/channels/${dmChannelId}` : '/channels')
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex h-[50px] items-center gap-3 border-b border-[color:var(--sep)] px-5">
        <MobileMenuButton />
        <h1 className="text-[17px] font-bold text-[color:var(--tx)]">Search</h1>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-[color:var(--sep)] p-5">
          <input
            autoFocus
            className="admin-input w-full"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search channels, people, projects, messages, knowledge…"
            type="search"
            value={query}
          />
        </div>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
          {!active ? (
            <p className="px-3 text-sm text-[color:var(--tx3)]">
              Search channels, people, projects, messages, and knowledge.
            </p>
          ) : !hasResults && !results.isLoading ? (
            <p className="px-3 text-sm text-[color:var(--tx3)]">No results</p>
          ) : (
            <>
              {results.channels.length > 0 ? (
                <SearchSection title="Channels">
                  {results.channels.map((channel) => (
                    <SearchResultRow
                      key={channel.id}
                      marker="#"
                      onClick={() => openChannel(channel)}
                      primary={channel.label}
                      secondary={channel.projectName}
                    />
                  ))}
                </SearchSection>
              ) : null}

              {results.people.length > 0 ? (
                <SearchSection title="People">
                  {results.people.map((person) => (
                    <SearchResultRow
                      key={person.id}
                      marker={initial(person.displayName)}
                      onClick={() => openPerson(person)}
                      primary={person.displayName}
                      secondary={person.email}
                    />
                  ))}
                </SearchSection>
              ) : null}

              {results.projects.length > 0 ? (
                <SearchSection title="Projects">
                  {results.projects.map((project) => (
                    <SearchResultRow
                      key={project.id}
                      marker={initial(project.name)}
                      onClick={() => openProject(project)}
                      primary={project.name}
                    />
                  ))}
                </SearchSection>
              ) : null}

              {results.messages.length > 0 ? (
                <SearchSection title="Messages">
                  {results.messages.map((message) => (
                    <SearchResultRow
                      key={message.id}
                      marker="💬"
                      onClick={() => openMessage(message)}
                      primary={message.snippet}
                      secondary={`${message.authorName} · ${message.channelLabel}`}
                    />
                  ))}
                </SearchSection>
              ) : null}

              {results.knowledge.length > 0 ? (
                <SearchSection title="Knowledge">
                  {results.knowledge.map((hit) => (
                    <SearchResultRow
                      key={hit.page.id}
                      marker="📄"
                      onClick={() => openKnowledge(hit)}
                      primary={hit.page.title}
                      secondary={hit.snippet}
                    />
                  ))}
                </SearchSection>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  )
}
