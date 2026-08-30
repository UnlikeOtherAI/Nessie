import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router-dom'
import { ConfirmDialog } from '../../components/shared/ConfirmDialog'
import { CreateProjectDialog } from '../../components/shared/CreateProjectDialog'
import { ProjectMembersDialog } from '../../components/shared/ProjectMembersDialog'
import { EditProjectDialog } from '../../components/shared/EditProjectDialog'
import { useDeleteProject, useProjects } from '../../facades/projects/hooks'
import type { ProjectRecord } from '../../lib/api-client'
import { isReactNativeWebView, usePhoneLayout } from '../../lib/mobile-shell'
import { SidebarMenuSection, useCookieBackedSidebarSections } from './SidebarMenuSection'

type ProjectsSidebarNavProps = {
  pathname: string
  isOwner: boolean
}

type ProjectNavSectionId = 'projects'

type ProjectMenuPosition = {
  left: number
  top: number
}

const PROJECT_NAV_SECTION_IDS: ProjectNavSectionId[] = ['projects']

const projectNavCookieName = (id: ProjectNavSectionId) => `projectsNavCollapsed-${id}`

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
  const nativeTouchShell = isReactNativeWebView()
  const phoneLayout = usePhoneLayout()
  const { data: projects = [] } = useProjects()
  const deleteProject = useDeleteProject()

  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<ProjectRecord | null>(null)
  const [membersTarget, setMembersTarget] = useState<ProjectRecord | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ProjectRecord | null>(null)
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null)
  const [menuPosition, setMenuPosition] = useState<ProjectMenuPosition | null>(null)
  const menuButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const { collapsedSections, toggleSection } = useCookieBackedSidebarSections(
    PROJECT_NAV_SECTION_IDS,
    projectNavCookieName,
  )

  const closeMenu = useCallback(() => {
    setMenuProjectId(null)
    setMenuPosition(null)
  }, [])

  const openMenu = useCallback((projectId: string) => {
    const rect = menuButtonRefs.current.get(projectId)?.getBoundingClientRect()
    if (!rect) return
    setMenuProjectId(projectId)
    setMenuPosition({ left: rect.left, top: rect.bottom + 4 })
  }, [])

  useLayoutEffect(() => {
    if (!menuPosition) return undefined

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeMenu()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', closeMenu, true)
    window.addEventListener('resize', closeMenu)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', closeMenu, true)
      window.removeEventListener('resize', closeMenu)
    }
  }, [closeMenu, menuPosition])

  // Opening the confirm is the whole of the menu action. The mutation lives in
  // `runDelete`, which nothing but the dialog's confirm control can reach.
  const handleDelete = (project: ProjectRecord) => {
    closeMenu()
    setDeleteTarget(project)
  }

  const runDelete = (project: ProjectRecord) => {
    setDeleteTarget(null)
    deleteProject.mutate(project.id, {
      onError: (error) =>
        window.alert(error instanceof Error ? error.message : 'Failed to delete project'),
    })
  }

  return (
    <aside
      className={[
        'flex h-full w-full flex-col overflow-hidden',
        'border-r border-[color:var(--sep)] bg-[color:var(--sb)]',
        nativeTouchShell ? 'touch-sidebar' : '',
      ].join(' ')}
    >
      <nav className="min-h-0 flex-1 overflow-y-auto py-1">
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
              const projectPath = phoneLayout
                ? `/projects/${project.id}/board`
                : `/projects/${project.id}`

              return (
                <div key={project.id} className="group relative">
                  <Link
                    className={['admin-sb-item', isActive ? 'active' : ''].join(' ')}
                    to={projectPath}
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
                      aria-expanded={menuProjectId === project.id}
                      aria-haspopup="menu"
                      onClick={() =>
                        menuProjectId === project.id ? closeMenu() : openMenu(project.id)
                      }
                      ref={(element) => {
                        if (element) {
                          menuButtonRefs.current.set(project.id, element)
                        } else {
                          menuButtonRefs.current.delete(project.id)
                        }
                      }}
                      type="button"
                    >
                      ⋯
                    </button>
                  ) : null}

                  {menuProjectId === project.id && menuPosition
                    ? createPortal(
                        <>
                          <button
                            aria-hidden="true"
                            className="fixed inset-0 z-[60] cursor-default"
                            onClick={closeMenu}
                            tabIndex={-1}
                            type="button"
                          />
                          <div
                            className="admin-sidebar-menu admin-sidebar-menu-project fixed z-[61]"
                            role="menu"
                            style={menuPosition}
                          >
                            <button
                              onClick={() => {
                                closeMenu()
                                setEditTarget(project)
                              }}
                              role="menuitem"
                              type="button"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => {
                                closeMenu()
                                setMembersTarget(project)
                              }}
                              role="menuitem"
                              type="button"
                            >
                              Members
                            </button>
                            <button
                              onClick={() => {
                                closeMenu()
                                void navigate(`/projects/${project.id}/settings`)
                              }}
                              role="menuitem"
                              type="button"
                            >
                              Settings
                            </button>
                            <button
                              className="admin-sidebar-menu-danger"
                              onClick={() => handleDelete(project)}
                              role="menuitem"
                              type="button"
                            >
                              Delete
                            </button>
                          </div>
                        </>,
                        document.body,
                      )
                    : null}
                </div>
              )
            })
          )}
        </SidebarMenuSection>
      </nav>

      <CreateProjectDialog onClose={() => setCreateOpen(false)} open={createOpen} />
      {editTarget ? (
        <EditProjectDialog
          onClose={() => setEditTarget(null)}
          open
          project={editTarget}
        />
      ) : null}
      {membersTarget ? (
        <ProjectMembersDialog
          isOwner={isOwner}
          onClose={() => setMembersTarget(null)}
          project={membersTarget}
        />
      ) : null}
      {deleteTarget ? (
        <ConfirmDialog
          body="This cannot be undone."
          confirmLabel="Delete"
          destructive
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => runDelete(deleteTarget)}
          open
          title={`Delete project "${deleteTarget.name}"?`}
        />
      ) : null}
    </aside>
  )
}
