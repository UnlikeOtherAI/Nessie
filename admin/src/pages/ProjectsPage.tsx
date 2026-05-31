import { useState } from 'react'
import { CreateProjectDialog } from '../components/shared/CreateProjectDialog'
import { RenameProjectDialog } from '../components/shared/RenameProjectDialog'
import {
  useAddProjectMember,
  useDeleteProject,
  useProjectMembers,
  useProjects,
  useRemoveProjectMember,
} from '../facades/projects/hooks'
import { useUsers } from '../facades/users/hooks'
import type { ProjectRecord } from '../lib/api-client'
import { useAuthSession } from '../providers/AuthSessionProvider'

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

const FolderIcon = () => (
  <svg
    className="h-5 w-5 flex-shrink-0 text-[color:var(--tx3)]"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    viewBox="0 0 24 24"
  >
    <path
      d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

type ProjectCardProps = {
  expanded: boolean
  isOwner: boolean
  onDelete: () => void
  onRename: () => void
  onToggle: () => void
  project: ProjectRecord
}

const ProjectCard = ({
  expanded,
  isOwner,
  onDelete,
  onRename,
  onToggle,
  project,
}: ProjectCardProps) => {
  const { data: members = [] } = useProjectMembers(expanded ? project.id : null)
  const { data: users = [] } = useUsers(isOwner && expanded)
  const addMember = useAddProjectMember()
  const removeMember = useRemoveProjectMember()
  const [addUserId, setAddUserId] = useState('')

  const memberIds = new Set(members.map((member) => member.userId))
  const candidates = users.filter((user) => !memberIds.has(user.id))

  const handleAdd = () => {
    if (!addUserId) return
    addMember.mutate(
      { projectId: project.id, userId: addUserId },
      { onSuccess: () => setAddUserId('') },
    )
  }

  return (
    <div className="admin-card p-3">
      <div className="flex items-center gap-3">
        <FolderIcon />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-white">{project.name}</div>
          <div className="text-xs text-[color:var(--tx3)]">
            {project.memberCount} {project.memberCount === 1 ? 'member' : 'members'}
            {' · '}Teams: {project.teamCount ?? 0}
            {' · '}Channels: {project.channelCount ?? 0}
          </div>
        </div>
        <button className="admin-button admin-button-secondary" onClick={onToggle} type="button">
          {expanded ? 'Hide members' : 'Members'}
        </button>
        {isOwner ? (
          <>
            <button className="admin-button admin-button-secondary" onClick={onRename} type="button">
              Rename
            </button>
            <button
              className="admin-button admin-button-secondary text-[color:var(--danger,#f87171)]"
              onClick={onDelete}
              type="button"
            >
              Delete
            </button>
          </>
        ) : null}
      </div>

      {expanded ? (
        <div className="mt-3 grid gap-2 border-t border-[color:var(--sep)] pt-3">
          {members.length === 0 ? (
            <div className="text-xs text-[color:var(--tx3)]">No members yet.</div>
          ) : (
            members.map((member) => (
              <div
                key={member.userId}
                className="flex items-center gap-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate text-white">
                  {member.displayName}
                  <span className="ml-2 text-xs text-[color:var(--tx3)]">{member.email}</span>
                </span>
                <span className="text-xs uppercase tracking-wide text-[color:var(--tx3)]">
                  {member.role}
                </span>
                {isOwner ? (
                  <button
                    className="admin-button admin-button-secondary text-[color:var(--danger,#f87171)]"
                    onClick={() =>
                      removeMember.mutate({ projectId: project.id, userId: member.userId })
                    }
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
      ) : null}
    </div>
  )
}

export const ProjectsPage = () => {
  const { me } = useAuthSession()
  const isOwner = me?.user.roleIds?.includes('owner') ?? false
  const { data: projects = [] } = useProjects()
  const deleteProject = useDeleteProject()

  const [createOpen, setCreateOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<ProjectRecord | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleDelete = (project: ProjectRecord) => {
    if (!window.confirm(`Delete project "${project.name}"? This cannot be undone.`)) {
      return
    }
    setError(null)
    deleteProject.mutate(project.id, {
      onError: (mutationError) =>
        setError(
          mutationError instanceof Error
            ? mutationError.message
            : 'Failed to delete project',
        ),
    })
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex h-[50px] items-center gap-4 border-b border-[color:var(--sep)] px-5">
        <div className={sectionTitle}>Projects</div>
        {isOwner ? (
          <button
            className="admin-button admin-button-primary ml-auto"
            onClick={() => setCreateOpen(true)}
            type="button"
          >
            New project
          </button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? (
          <div className="admin-card mb-3 border-[color:var(--danger,#f87171)] p-3 text-sm text-[color:var(--danger,#f87171)]">
            {error}
          </div>
        ) : null}

        {projects.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[color:var(--tx3)]">
            No projects yet.
          </div>
        ) : (
          <div className="grid gap-2">
            {projects.map((project) => (
              <ProjectCard
                key={project.id}
                expanded={expandedId === project.id}
                isOwner={isOwner}
                onDelete={() => handleDelete(project)}
                onRename={() => setRenameTarget(project)}
                onToggle={() =>
                  setExpandedId((current) => (current === project.id ? null : project.id))
                }
                project={project}
              />
            ))}
          </div>
        )}
      </div>

      <CreateProjectDialog onClose={() => setCreateOpen(false)} open={createOpen} />
      {renameTarget ? (
        <RenameProjectDialog
          currentName={renameTarget.name}
          onClose={() => setRenameTarget(null)}
          open
          projectId={renameTarget.id}
        />
      ) : null}
    </section>
  )
}
