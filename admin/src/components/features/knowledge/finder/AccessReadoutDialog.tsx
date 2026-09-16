import type { ReactNode } from 'react'
import type { KnowledgeAccessSummary } from '@nessie/schemas'
import { useProjectMembers } from '../../../../facades/projects/hooks'
import { useUsers } from '../../../../facades/users/hooks'
import { useAuthSession } from '../../../../providers/AuthSessionProvider'
import { Dialog } from '../../../shared/Dialog'
import { SectionLabel } from '../../../primitives/SectionLabel'
import { UserAvatar } from '../../../shared/UserAvatar'
import {
  agentReadout,
  projectReadout,
  sharedToMeReadout,
  spaceReadout,
  type AccessReadout,
} from './sharing-copy'

/**
 * "Who can see this" — the sharing surface for everything a person cannot
 * hand out (menus-and-dialogs.md §4.2–4.5).
 *
 * **Nothing in this dialog writes.** Project documents are seen by the
 * project's members and by nobody else, a shared folder's audience is its
 * visibility plus whoever was added to it, and a row somebody shared with you
 * is theirs to change. Each of those is a fact about the container, so the
 * honest surface is a report with the container's own doorway in the footer —
 * offering a "Share" here would be offering an edit the server will refuse,
 * which the design system names as the failure and this as the cure.
 *
 * The menu's label is the same word ("Sharing…") as the grant surface's, so
 * nobody hunts for a Share that is not there; the *title* is what differs.
 */

// The first 50 people, then a count: a 400-member organisation's list is not
// the answer to "who can see this", and the doorway below it is.
const MEMBER_CAP = 50

type AccessReadoutDialogProps = {
  access: KnowledgeAccessSummary
  onClose: () => void
  /** The container's own edit surface, where the viewer may open one. */
  onOpenAgent?: () => void
  onOpenProjectMembers?: () => void
  onRemoveShare?: () => void
  onSpaceSettings?: () => void
  open: boolean
  /** Names the shared folder in the sentence when the summary cannot. */
  projectName?: string | null
}

const PersonRow = ({
  displayName,
  token,
  trailing,
  userId,
}: {
  displayName: string
  token: string | null
  trailing?: ReactNode
  userId: string
}) => (
  <li className="flex items-center gap-2 py-1">
    <UserAvatar displayName={displayName} size={20} token={token} userId={userId} />
    <span className="min-w-0 flex-1 truncate text-sm text-[color:var(--tx)]">{displayName}</span>
    {trailing}
  </li>
)

const ProjectMembers = ({ projectId }: { projectId: string }) => {
  const { me, token } = useAuthSession()
  const query = useProjectMembers(projectId)
  const members = query.data ?? []

  if (query.isLoading) {
    return <p className="text-sm text-[color:var(--tx3)]">Reading members…</p>
  }
  return (
    <>
      <ul className="max-h-56 overflow-y-auto">
        {members.slice(0, MEMBER_CAP).map((member) => (
          <PersonRow
            displayName={member.userId === me?.user.id
              ? `${member.displayName} (you)`
              : member.displayName}
            key={member.userId}
            token={token}
            userId={member.userId}
          />
        ))}
      </ul>
      {members.length > MEMBER_CAP ? (
        <p className="text-xs text-[color:var(--tx3)]">
          {`and ${members.length - MEMBER_CAP} more`}
        </p>
      ) : null}
    </>
  )
}

const readoutFor = (
  access: KnowledgeAccessSummary,
  sharerName: string,
  projectName: string | null | undefined,
): AccessReadout => {
  switch (access.mode) {
    case 'project':
      return projectReadout(access.projectName)
    case 'space':
      return spaceReadout({
        projectName,
        spaceName: access.spaceName,
        visibility: access.visibility,
        writeRestricted: access.writeRestricted,
      })
    case 'agent':
      return agentReadout(access.agentName, access.memberUserCount)
    case 'shared_to_me':
      return sharedToMeReadout(sharerName, access.access)
    default:
      return {
        body: 'Use Sharing to add a person.',
        headline: 'Only you can see this.',
      }
  }
}

export const AccessReadoutDialog = ({
  access,
  onClose,
  onOpenAgent,
  onOpenProjectMembers,
  onRemoveShare,
  onSpaceSettings,
  open,
  projectName,
}: AccessReadoutDialogProps) => {
  const usersQuery = useUsers(open && access.mode === 'shared_to_me')
  const sharerName = access.mode === 'shared_to_me'
    ? (usersQuery.data ?? []).find((user) => user.id === access.sharedByUserId)?.displayName
      ?? 'The person who shared it'
    : ''
  const readout = readoutFor(access, sharerName, projectName)

  return (
    <Dialog onClose={onClose} open={open} title="Who can see this">
      <div className="grid gap-4">
        <div className="grid gap-1.5">
          <p
            className="text-sm font-semibold text-[color:var(--tx)]"
            data-testid="access-readout-headline"
          >
            {readout.headline}
          </p>
          {readout.body ? (
            <p className="text-sm text-[color:var(--tx2)]">{readout.body}</p>
          ) : null}
        </div>

        {access.mode === 'project' ? (
          <div className="grid gap-1.5">
            <SectionLabel size="sm">In the project</SectionLabel>
            <ProjectMembers projectId={access.projectId} />
          </div>
        ) : null}

        {access.mode === 'space' ? (
          <div className="grid gap-1.5">
            <SectionLabel size="sm">Added to this folder</SectionLabel>
            <p className="text-sm text-[color:var(--tx3)]">
              {access.memberUserCount === 0 && access.memberAgentCount === 0
                ? 'Nobody has been added directly.'
                : `${access.memberUserCount} ${access.memberUserCount === 1 ? 'person' : 'people'}`
                  + `${access.memberAgentCount > 0
                    ? `, and ${access.memberAgentCount} ${access.memberAgentCount === 1 ? 'agent' : 'agents'}`
                    : ''}.`}
            </p>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap justify-end gap-2 pt-5">
        {access.mode === 'project' && onOpenProjectMembers ? (
          <button
            className="admin-button admin-button-secondary"
            onClick={onOpenProjectMembers}
            type="button"
          >
            Open project members
          </button>
        ) : null}
        {access.mode === 'agent' && onOpenAgent ? (
          <button className="admin-button admin-button-secondary" onClick={onOpenAgent} type="button">
            Open agent
          </button>
        ) : null}
        {(access.mode === 'space' || access.mode === 'agent') && onSpaceSettings ? (
          <button
            className="admin-button admin-button-secondary"
            onClick={onSpaceSettings}
            type="button"
          >
            Sharing &amp; settings…
          </button>
        ) : null}
        {access.mode === 'shared_to_me' && onRemoveShare ? (
          <button className="admin-button admin-button-danger" onClick={onRemoveShare} type="button">
            Remove from Shared with me
          </button>
        ) : null}
        <button className="admin-button admin-button-primary" onClick={onClose} type="button">
          Done
        </button>
      </div>
    </Dialog>
  )
}
