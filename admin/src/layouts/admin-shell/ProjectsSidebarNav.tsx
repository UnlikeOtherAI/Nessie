import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CreateProjectDialog } from '../../components/shared/CreateProjectDialog'
import { ProjectMembersDialog } from '../../components/shared/ProjectMembersDialog'
import { RenameProjectDialog } from '../../components/shared/RenameProjectDialog'
import { useDeleteProject, useProjects } from '../../facades/projects/hooks'
import type { ProjectRecord } from '../../lib/api-client'
import { SidebarMenuSection, useCookieBackedSidebarSections } from './SidebarMenuSection'

type ProjectsSidebarNavProps = {
  pathname: string
  isOwner: boolean
}

type ProjectNavSectionId = 'boards' | 'projects'

const PROJECT_NAV_SECTION_IDS: ProjectNavSectionId[] = ['boards', 'projects']

const projectNavCookieName = (id: ProjectNavSectionId) => `projectsNavCollapsed-${id}`

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
  const navigate = useNavigate()
  const { data: projects = [] } = useProjects()
  const deleteProject = useDeleteProject()

  const [createOpen, setCreateOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<ProjectRecord | null>(null)
  const [membersTarget, setMembersTarget] = useState<ProjectRecord | null>(null)
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null)
  const { collapsedSections, toggleSection } = useCookieBackedSidebarSections(
    PROJECT_NAV_SECTION_IDS,
    projectNavCookieName,
  )

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
        'flex h-full w-[220px] flex-col overflow-hidden',
        'border-r border-[color:var(--sep)] bg-[color:var(--sb)]',
      ].join(' ')}
    >
      <div className="flex h-[50px] items-center px-4">
        <span className="text-[15px] font-bold text-[color:var(--tx)]">Projects</span>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto py-1">
        <SidebarMenuSection
          id="projects-nav-boards"
          isCollapsed={collapsedSections.boards ?? false}
          onToggle={() => toggleSection('boards')}
          title="Boards"
        >
          <Link
            className={['admin-sb-item', pathname === '/projects' ? 'active' : ''].join(' ')}
            to="/projects"
          >
            <KanbanIcon />
            <span className="min-w-0 flex-1 truncate">Kanban</span>
          </Link>
        </SidebarMenuSection>

        <SidebarMenuSection
          action={
            isOwner ? (
              <button
                aria-label="New project"
                className="admin-sidebar-plus"
                onClick={() => setCreateOpen(true)}
                type="button"
              >
                +
              </button>
            ) : null
          }
          id="projects-nav-projects"
          isCollapsed={collapsedSections.projects ?? false}
          onToggle={() => toggleSection('projects')}
          title="Projects"
        >
          {projects.length === 0 ? (
            <div className="px-5 py-2 text-[13px] text-[color:var(--tx3)]">No projects yet.</div>
          ) : (
            projects.map((project) => {
              const isActive =
                pathname === `/projects/${project.id}`
                || pathname.startsWith(`/projects/${project.id}/`)

              return (
                <div key={project.id} className="group relative">
                  <Link
                    className={['admin-sb-item', isActive ? 'active' : ''].join(' ')}
                    to={`/projects/${project.id}`}
                  >
                    <FolderIcon />
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  </Link>
                  {isOwner ? (
                    <button
                      aria-label={`Project actions for ${project.name}`}
                      className={[
                        'admin-sidebar-more absolute right-3 top-1/2 -translate-y-1/2',
                        'opacity-0 group-hover:opacity-100',
                      ].join(' ')}
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
                      <div className="admin-sidebar-menu admin-sidebar-menu-project">
                        <button
                          onClick={() => {
                            setMenuProjectId(null)
                            setRenameTarget(project)
                          }}
                          type="button"
                        >
                          Rename
                        </button>
                        <button
                          onClick={() => {
                            setMenuProjectId(null)
                            setMembersTarget(project)
                          }}
                          type="button"
                        >
                          Members
                        </button>
                        <button
                          onClick={() => {
                            setMenuProjectId(null)
                            void navigate(`/projects/${project.id}/settings`)
                          }}
                          type="button"
                        >
                          Settings
                        </button>
                        <button
                          className="admin-sidebar-menu-danger"
                          onClick={() => handleDelete(project)}
                          type="button"
                        >
                          Delete
                        </button>
                      </div>
                    </>
                  ) : null}
                </div>
              )
            })
          )}
        </SidebarMenuSection>
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
