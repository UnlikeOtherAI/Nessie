import { useState } from 'react'
import { Input } from '../../../components/shared/FormControls'
import { Section } from '../../../components/shared/PageBody'
import {
  AvailableUserRow,
  CurrentUserRow,
  type MemberUser,
} from '../../../components/shared/channel-members/MemberUserRow'
import { useUserMemberFilters } from '../../../components/shared/channel-members/useMemberFilters'
import { FormError } from '../../../components/shared/FormActions'
import {
  useAddProjectMember,
  useProjectMembers,
  useRemoveProjectMember,
} from '../../../facades/projects/hooks'
import { useUsers } from '../../../facades/users/hooks'
import type { ProjectRecord } from '../../../lib/api-client'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { projectChangeRefusal } from './project-settings-presentation'

type ProjectPeopleSectionProps = {
  /**
   * `useCanModifyProject` — any member of the project, or an organisation owner
   * or admin. Gates adding and removing; the roster itself is readable by
   * everyone who can open the project.
   */
  canModify: boolean
  project: ProjectRecord
}

/**
 * Settings › People: the project's roster, and the one place it is managed.
 * It was a dialog opened from the header's Members button and the Overview's
 * People tile; both doorways now come here. Project membership is Nessie's own
 * (docs/standards/team-model.md), with one exception the server refuses and
 * this section says in words: a project that mirrors a sign-in provider team.
 */
export const ProjectPeopleSection = ({ canModify, project }: ProjectPeopleSectionProps) => {
  const { me } = useAuthSession()
  const { data: members = [] } = useProjectMembers(project.id)
  const { data: users = [] } = useUsers()
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
  const mutationError = addMember.error ?? removeMember.error

  return (
    <Section
      description={`${members.length} ${members.length === 1 ? 'person works' : 'people work'} in this project. Everyone in it can change it, add people and remove them.`}
      title="People"
    >
      <Input
        aria-label="Search people"
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search by name or email"
        value={search}
      />
      <FormError>{mutationError ? projectChangeRefusal(mutationError) : undefined}</FormError>

      <div className="grid gap-0.5" aria-label="In this project" role="group">
        {filteredUsers.map((user) => (
          <CurrentUserRow
            canRemove={canModify}
            currentUserId={me?.user.id ?? ''}
            key={user.id}
            onRemove={(userId) => removeMember.mutate({ projectId: project.id, userId })}
            removeLabel="Remove from project"
            removePending={removeMember.isPending}
            user={user}
          />
        ))}
        {filteredUsers.length === 0 ? (
          <p className="px-3 py-4 text-sm text-[color:var(--tx3)]">Nobody in this project matches that search.</p>
        ) : null}
      </div>

      {canModify && availableUsers.length > 0 ? (
        <div className="grid gap-0.5 border-t border-[color:var(--sep)] pt-3" aria-label="Add to project" role="group">
          <p className="px-3 text-xs font-semibold text-[color:var(--tx3)]">Add to this project</p>
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
    </Section>
  )
}
