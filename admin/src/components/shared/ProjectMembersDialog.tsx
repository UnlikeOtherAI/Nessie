import { useState } from 'react'
import {
  useAddProjectMember,
  useProjectMembers,
  useRemoveProjectMember,
} from '../../facades/projects/hooks'
import { useUsers } from '../../facades/users/hooks'
import type { ProjectRecord } from '../../lib/api-client'
import { Dialog } from './Dialog'

type ProjectMembersDialogProps = {
  project: ProjectRecord
  isOwner: boolean
  onClose: () => void
}

export const ProjectMembersDialog = ({ project, isOwner, onClose }: ProjectMembersDialogProps) => {
  const { data: members = [] } = useProjectMembers(project.id)
  const { data: users = [] } = useUsers(isOwner)
  const addMember = useAddProjectMember()
  const removeMember = useRemoveProjectMember()
  const [addUserId, setAddUserId] = useState('')

  const memberIds = new Set(members.map((member) => member.userId))
  const candidates = users.filter((user) => !memberIds.has(user.id))

  const handleAdd = () => {
    if (!addUserId) return
    addMember.mutate({ projectId: project.id, userId: addUserId }, { onSuccess: () => setAddUserId('') })
  }

  return (
    // The parent mounts this only while it is open, so the shell is always open.
    <Dialog onClose={onClose} open title={`${project.name} · Members`}>
      <div className="grid gap-2">
        {members.length === 0 ? (
          <div className="text-xs text-[color:var(--tx3)]">No members yet.</div>
        ) : (
          members.map((member) => (
            <div key={member.userId} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-[color:var(--tx)]">
                {member.displayName}
                <span className="ml-2 text-xs text-[color:var(--tx3)]">{member.email}</span>
              </span>
              <span className="text-xs uppercase tracking-wide text-[color:var(--tx3)]">
                {member.role}
              </span>
              {isOwner ? (
                <button
                  className="admin-button admin-button-secondary admin-button-danger"
                  onClick={() => removeMember.mutate({ projectId: project.id, userId: member.userId })}
                  type="button"
                >
                  Remove
                </button>
              ) : null}
            </div>
          ))
        )}

        {isOwner ? (
          <div className="mt-1 flex items-center gap-2">
            <select
              className="admin-input flex-1"
              onChange={(event) => setAddUserId(event.target.value)}
              value={addUserId}
            >
              <option value="">Add a member…</option>
              {candidates.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.displayName} ({user.email})
                </option>
              ))}
            </select>
            <button
              className="admin-button admin-button-primary"
              disabled={!addUserId || addMember.isPending}
              onClick={handleAdd}
              type="button"
            >
              Add
            </button>
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}
