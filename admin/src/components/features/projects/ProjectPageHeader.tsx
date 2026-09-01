import { faUsers } from '@fortawesome/free-solid-svg-icons'
import { useState } from 'react'
import type { ProjectRecord } from '../../../lib/api-client'
import { useIsOwner } from '../../shared/OwnerGate'
import { ProjectMembersDialog } from '../../shared/ProjectMembersDialog'
import { AdminPageHeader } from '../../shared/AdminPageHeader'
import type { PageHeaderAction } from '../../shared/ResponsivePageHeader'

type ProjectPageHeaderProps = {
  actions?: PageHeaderAction[]
  project: ProjectRecord | undefined
  titleTone?: 'page' | 'section'
}

/**
 * The one project header, used from both project entry points. In particular,
 * the Members doorway stays where it is for a channel and opens the same
 * management surface regardless of which project route the person used.
 */
export const ProjectPageHeader = ({
  actions = [],
  project,
  titleTone,
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
      <AdminPageHeader
        actions={projectActions}
        title={project?.name ?? 'Project'}
        titleTone={titleTone}
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
