import { useState } from 'react'
import {
  useAddProjectMember,
  useProjectMembers,
  useRemoveProjectMember,
} from '../../facades/projects/hooks'
import { useUsers } from '../../facades/users/hooks'
import type { ProjectRecord } from '../../lib/api-client'

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
    <div
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      role="presentation"
      style={{
        alignItems: 'center',
        backdropFilter: 'blur(4px)',
        background: 'var(--scrim-strong)',
        display: 'flex',
        inset: 0,
        justifyContent: 'center',
        position: 'fixed',
        zIndex: 9999,
      }}
    >
      <div className="create-channel-panel">
        <div className="create-channel-header">
          <h2 className="text-lg font-bold text-[color:var(--tx)]">{project.name} · Members</h2>
          <button
            className={[
              'flex h-7 w-7 items-center justify-center',
              'rounded text-[color:var(--tx3)]',
              'hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
            ].join(' ')}
            onClick={onClose}
            type="button"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

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
      </div>
    </div>
  )
}
