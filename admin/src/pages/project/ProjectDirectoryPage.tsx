import { Link, useNavigate } from 'react-router-dom'
import type { ProjectDirectoryEntry } from '@nessie/schemas'

import { EmptyState } from '../../components/shared/EmptyState'
import { PageBody } from '../../components/shared/PageBody'
import { QueryState } from '../../components/shared/QueryState'
import { ProjectLockMarker } from '../../components/shared/RoomVisibilityGlyph'
import { ScreenHeader } from '../../components/shared/ScreenHeader'
import { UserAvatar } from '../../components/shared/UserAvatar'
import { useProjectDirectory } from '../../facades/projects/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'

/**
 * Every project in the organisation, reachable from the Projects sidebar
 * ("Browse all projects").
 *
 * A project the viewer is not in shows its name, description and members only
 * — the server sends nothing else for it (`ProjectDirectoryEntrySchema`) — so a
 * person can see it exists and whom to ask to be added. There are no modify
 * controls on this page at all; a project the viewer may open links to itself.
 */
export const ProjectDirectoryPage = () => {
  const navigate = useNavigate()
  const directoryQuery = useProjectDirectory()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScreenHeader
        backLabel="Back to Projects"
        onBack={() => void navigate('/projects')}
        subtitle="Every project in your organisation. Ask a member to add you to one you are not in."
        title="All projects"
      />
      <PageBody>
        <QueryState
          errorLabel="Projects could not be loaded."
          loadingLabel="Loading projects…"
          query={directoryQuery}
        >
          {() => {
            const entries = directoryQuery.data ?? []
            return entries.length === 0
              ? <EmptyState>There are no projects in this organisation yet.</EmptyState>
              : (
                <ul className="grid gap-3" aria-label="Projects in this organisation">
                  {entries.map((entry) => <ProjectDirectoryRow entry={entry} key={entry.id} />)}
                </ul>
              )
          }}
        </QueryState>
      </PageBody>
    </div>
  )
}

const ProjectDirectoryRow = ({ entry }: { entry: ProjectDirectoryEntry }) => {
  const { token } = useAuthSession()
  const canOpen = entry.access === 'full'

  return (
    <li className="grid gap-2 rounded-xl border border-[color:var(--sep)] bg-[color:var(--main)] p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5">
          {/* Derived from `visibility`, never a `locked` field on the wire. */}
          <ProjectLockMarker visibility={entry.visibility} />
          {canOpen ? (
            <Link className="text-sm font-semibold text-[color:var(--tx)] hover:underline" to={`/projects/${entry.id}`}>
              {entry.name}
            </Link>
          ) : (
            <span className="text-sm font-semibold text-[color:var(--tx)]">{entry.name}</span>
          )}
        </span>
        <span className="text-xs text-[color:var(--tx3)]">
          {entry.access === 'full'
            ? (entry.viewerIsMember ? 'You are a member' : 'You can open this as an organisation admin')
            : entry.visibility === 'protected'
              ? 'Protected — ask a member to add you'
              : 'You are not a member'}
        </span>
      </div>
      {entry.description ? (
        <p className="text-sm text-[color:var(--tx2)]">{entry.description}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2" aria-label={`Members of ${entry.name}`}>
        {entry.members.length === 0 ? (
          <span className="text-xs text-[color:var(--tx3)]">No members</span>
        ) : entry.members.map((member) => (
          <span className="flex items-center gap-1.5 text-xs text-[color:var(--tx2)]" key={member.userId}>
            <UserAvatar
              displayName={member.displayName}
              size={20}
              token={token}
              userId={member.userId}
              {...(member.avatarUrl ? { avatarUrl: member.avatarUrl } : {})}
              {...(member.avatarAttachmentId ? { avatarAttachmentId: member.avatarAttachmentId } : {})}
            />
            {member.displayName}
          </span>
        ))}
      </div>
    </li>
  )
}
