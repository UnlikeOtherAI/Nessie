import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CreateProjectDialog } from '../../components/shared/CreateProjectDialog'
import { ProjectMembersDialog } from '../../components/shared/ProjectMembersDialog'
import { RenameProjectDialog } from '../../components/shared/RenameProjectDialog'
import { useDeleteProject, useProjects } from '../../facades/projects/hooks'
import type { ProjectRecord } from '../../lib/api-client'

type ProjectsSidebarNavProps = {
  pathname: string
  isOwner: boolean
}

const KanbanIcon = () => (
  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
    <rect height="16" rx="1" width="4" x="4" y="4" />
    <rect height="10" rx="1" width="4" x="10" y="4" />
    <rect height="13" rx="1" width="4" x="16" y="4" />
  </svg>
)

const FolderIcon = () => (
  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
    <path
      d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export const ProjectsSidebarNav = ({ pathname, isOwner }: ProjectsSidebarNavProps) => {
  const { data: projects = [] } = useProjects()
  const deleteProject = useDeleteProject()

  const [createOpen, setCreateOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<ProjectRecord | null>(null)
  const [membersTarget, setMembersTarget] = useState<ProjectRecord | null>(null)
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null)

  const handleDelete = (project: ProjectRecord) => {
    setMenuProjectId(null)
    if (!window.confirm(`Delete project "${project.name}"? This cannot be undone.`)) return
    deleteProject.mutate(project.id, {
      onError: (error) =>
        window.alert(error instanceof Error ? error.message : 'Failed to delete project'),
    })
  }

  return (
    <aside
      className={[
        'hidden h-full w-[220px] flex-col overflow-hidden',
        'border-r border-[color:var(--sep)] bg-[color:var(--sb)] md:flex',
      ].join(' ')}
    >
      <div className="flex h-[50px] items-center px-4">
        <span className="text-[15px] font-bold text-[color:var(--tx)]">Projects</span>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-1">
        <Link
          className={[
            'admin-sb-item flex items-center gap-2.5 px-3 py-2 text-[13px]',
            pathname === '/projects' ? 'active' : '',
          ].join(' ')}
          to="/projects"
        >
          <KanbanIcon />
          Kanban
        </Link>

        <div className="mt-3 flex items-center justify-between px-3 py-1">
          <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
            Projects
          </span>
          {isOwner ? (
            <button
              aria-label="New project"
              className="text-[color:var(--tx3)] hover:text-[color:var(--tx)]"
              onClick={() => setCreateOpen(true)}
              type="button"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M12 5v14M5 12h14" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : null}
        </div>

        {projects.length === 0 ? (
          <div className="px-3 py-2 text-xs text-[color:var(--tx3)]">No projects yet.</div>
        ) : (
          projects.map((project) => (
            <div key={project.id} className="group relative flex items-center">
              <Link
                className={[
                  'admin-sb-item flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-[13px]',
                  pathname === `/projects/${project.id}` ? 'active' : '',
                ].join(' ')}
                to={`/projects/${project.id}`}
              >
                <FolderIcon />
                <span className="truncate">{project.name}</span>
              </Link>
              {isOwner ? (
                <button
                  aria-label="Project actions"
                  className="absolute right-1 px-1.5 text-[color:var(--tx3)] opacity-0 hover:text-[color:var(--tx)] group-hover:opacity-100"
                  onClick={() => setMenuProjectId((id) => (id === project.id ? null : project.id))}
                  type="button"
                >
                  ⋯
                </button>
              ) : null}

              {menuProjectId === project.id ? (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setMenuProjectId(null)}
                    role="presentation"
                  />
                  <div className="admin-card absolute right-1 top-9 z-20 w-36 p-1 text-[13px]">
                    <button
                      className="block w-full rounded px-2 py-1.5 text-left hover:bg-[color:var(--overlay)]"
                      onClick={() => {
                        setMenuProjectId(null)
                        setRenameTarget(project)
                      }}
                      type="button"
                    >
                      Rename
                    </button>
                    <button
                      className="block w-full rounded px-2 py-1.5 text-left hover:bg-[color:var(--overlay)]"
                      onClick={() => {
                        setMenuProjectId(null)
                        setMembersTarget(project)
                      }}
                      type="button"
                    >
                      Members
                    </button>
                    <button
                      className="block w-full rounded px-2 py-1.5 text-left text-[color:var(--danger-text)] hover:bg-[color:var(--overlay)]"
                      onClick={() => handleDelete(project)}
                      type="button"
                    >
                      Delete
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          ))
        )}
      </nav>

      <CreateProjectDialog onClose={() => setCreateOpen(false)} open={createOpen} />
      {renameTarget ? (
        <RenameProjectDialog
          currentName={renameTarget.name}
          onClose={() => setRenameTarget(null)}
          open
          projectId={renameTarget.id}
        />
      ) : null}
      {membersTarget ? (
        <ProjectMembersDialog
          isOwner={isOwner}
          onClose={() => setMembersTarget(null)}
          project={membersTarget}
        />
      ) : null}
    </aside>
  )
}
