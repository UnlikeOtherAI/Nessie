import { faUsers } from '@fortawesome/free-solid-svg-icons'
import { useState, type ReactNode } from 'react'
import type { ProjectRecord } from '../../../lib/api-client'
import { useIsOwner } from '../../../facades/auth/hooks'
import { ProjectMembersDialog } from '../../shared/ProjectMembersDialog'
import { ScreenHeader } from '../../shared/ScreenHeader'
import type { PageHeaderAction } from '../../shared/ResponsivePageHeader'

type ProjectPageHeaderProps = {
  actions?: PageHeaderAction[]
  project: ProjectRecord | undefined
  // What of the project is on screen — the board's name, when the project has
  // more than one. The sidebar is where a board is chosen; this is how the
  // screen says which choice it is showing.
  subtitle?: ReactNode
  // A project is a Tab host: its section strip rides in the header's tabs
  // slot rather than in a bar beneath it.
  tabs?: ReactNode
}

/**
 * The one project header, used from both project entry points. In particular,
 * the Members doorway stays where it is for a channel and opens the same
 * management surface regardless of which project route the person used.
 */
export const ProjectPageHeader = ({
  actions = [],
  project,
  subtitle,
  tabs,
}: ProjectPageHeaderProps) => {
  const isOwner = useIsOwner()
  const [membersOpen, setMembersOpen] = useState(false)
  const projectActions: PageHeaderAction[] = project
    ? [
        ...actions,
        {
          icon: faUsers,
          id: 'project-members',
          label: `Members (${project.memberCount})`,
          onSelect: () => setMembersOpen(true),
          priority: 80,
        },
      ]
    : actions

  return (
    <>
      <ScreenHeader
        actions={projectActions}
        subtitle={subtitle}
        tabs={tabs}
        title={project?.name ?? 'Project'}
      />
      {membersOpen && project ? (
        <ProjectMembersDialog
          isOwner={isOwner}
          onClose={() => setMembersOpen(false)}
          project={project}
        />
      ) : null}
    </>
  )
}
