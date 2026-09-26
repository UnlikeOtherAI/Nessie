import { faUsers } from '@fortawesome/free-solid-svg-icons'
import { useCallback, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { ProjectRecord } from '../../../lib/api-client'
import { projectSettingsPath } from '../../../navigation/project-sections'
import { ScreenHeader } from '../../shared/ScreenHeader'
import type { PageHeaderAction } from '../../shared/ResponsivePageHeader'

type ProjectPageHeaderProps = {
  /**
   * A function when the screen wants the Members doorway somewhere of its own
   * — the board puts it in Configure rather than spending a header slot on it
   * — and pairs that with `membersAction={false}`. Either way the doorway goes
   * to the one place a project's people are managed: Settings › People.
   */
  actions?: PageHeaderAction[] | ((openMembers: () => void) => PageHeaderAction[])
  /** Whether this header draws its own Members action. */
  membersAction?: boolean
  backLabel?: string
  onBack?: () => void
  project: ProjectRecord | undefined
  // What of the project is on screen — the board's name, when the project has
  // more than one. The sidebar is where a board is chosen; this is how the
  // screen says which choice it is showing.
  subtitle?: ReactNode
  // A project is a Tab host: its section strip rides in the header's tabs
  // slot rather than in a bar beneath it.
  tabs?: ReactNode
  /** Nested project flows may name their own screen while retaining project actions. */
  title?: string
}

/**
 * The one project header. Its Members button is the doorway to Settings ›
 * People — there is no members dialog any more, because a second place to
 * manage the same roster is the fork AGENTS.md → "Rule zero" names. On the
 * Settings page itself the doorway is a section switch, so it replaces the
 * entry exactly as the section strip does, and Back still leaves the project.
 */
export const ProjectPageHeader = ({
  actions = [],
  backLabel,
  membersAction = true,
  onBack,
  project,
  subtitle,
  tabs,
  title,
}: ProjectPageHeaderProps) => {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const projectId = project?.id ?? null
  const openMembers = useCallback(() => {
    if (!projectId) return
    const onSettings = pathname === `/projects/${projectId}/settings`
    void navigate(projectSettingsPath(projectId, 'people'), { replace: onSettings })
  }, [navigate, pathname, projectId])
  const given = typeof actions === 'function' ? actions(openMembers) : actions
  const projectActions: PageHeaderAction[] = project && membersAction
    ? [
        ...given,
        {
          icon: faUsers,
          id: 'project-members',
          label: `Members (${project.memberCount})`,
          onSelect: openMembers,
          priority: 80,
        },
      ]
    : given

  return (
    <ScreenHeader
      actions={projectActions}
      backLabel={backLabel}
      onBack={onBack}
      subtitle={subtitle}
      tabs={tabs}
      title={title ?? project?.name ?? 'Project'}
    />
  )
}
