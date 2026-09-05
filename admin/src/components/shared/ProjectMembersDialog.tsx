import { useState } from 'react'
import {
  useAddProjectMember,
  useProjectMembers,
  useRemoveProjectMember,
} from '../../facades/projects/hooks'
import { useUsers } from '../../facades/users/hooks'
import type { ProjectRecord } from '../../lib/api-client'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { MemberManagementPopup } from './MemberManagementPopup'
import {
  AvailableUserRow,
  CurrentUserRow,
  type MemberUser,
} from './channel-members/MemberUserRow'
import { sectionHeadingClass } from './channel-members/styles'
import { useUserMemberFilters } from './channel-members/useMemberFilters'

type ProjectMembersDialogProps = {
  project: ProjectRecord
  isOwner: boolean
  onClose: () => void
}

export const ProjectMembersDialog = ({ project, isOwner, onClose }: ProjectMembersDialogProps) => {
  const { me } = useAuthSession()
  const { data: members = [] } = useProjectMembers(project.id)
  const { data: users = [] } = useUsers(isOwner)
  const addMember = useAddProjectMember()
  const removeMember = useRemoveProjectMember()
  const [search, setSearch] = useState('')
  const memberUsers: MemberUser[] = members.map((member) => ({
    displayName: member.displayName,
    email: member.email,
    id: member.userId,
  }))
  const { availableUsers, filteredUsers } = useUserMemberFilters({
    allUsers: users,
    members: memberUsers,
    search,
  })
  const hasAvailable = isOwner && availableUsers.length > 0

  return (
    <MemberManagementPopup
      entityLabel={project.name}
      onClose={onClose}
      onSearchChange={setSearch}
      search={search}
      totalMembers={members.length}
    >
      {filteredUsers.length > 0 ? (
        <div>
          <div className={sectionHeadingClass}>In this project</div>
          {filteredUsers.map((user) => (
            <CurrentUserRow
              canRemove={isOwner}
              currentUserId={me?.user.id ?? ''}
              key={user.id}
              onRemove={(userId) => removeMember.mutate({ projectId: project.id, userId })}
              removeLabel="Remove from project"
              removePending={removeMember.isPending}
              user={user}
            />
          ))}
        </div>
      ) : null}

      {hasAvailable ? (
        <div className="mt-2">
          <div className={sectionHeadingClass}>Add to project</div>
          {availableUsers.map((user) => (
            <AvailableUserRow
              addPending={addMember.isPending}
              key={user.id}
              onAdd={(userId) => addMember.mutate({ projectId: project.id, userId })}
              user={user}
            />
          ))}
        </div>
      ) : null}

      {filteredUsers.length === 0 && !hasAvailable ? (
        <div className="px-3 py-6 text-center text-sm text-[color:var(--tx3)]">
          No members match your search.
        </div>
      ) : null}
    </MemberManagementPopup>
  )
}
