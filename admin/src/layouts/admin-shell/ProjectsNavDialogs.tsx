import { BoardCreateDialog } from '../../components/features/projects/kanban/BoardCreateDialog'
import type { BoardRecord } from '../../facades/boards/hooks'
import { ConfirmDialog } from '../../components/shared/ConfirmDialog'
import { CreateProjectDialog } from '../../components/shared/CreateProjectDialog'
import { EditProjectDialog } from '../../components/shared/EditProjectDialog'
import type { ProjectRecord } from '../../lib/api-client'
import { useTranslation } from 'react-i18next'

type ProjectsNavDialogsProps = {
  boardCreateBoards: BoardRecord[]
  boardCreateProjectId: string | null
  createOpen: boolean
  deleteTarget: ProjectRecord | null
  editTarget: ProjectRecord | null
  onBoardCreated: (board: BoardRecord) => void
  onCancelDelete: () => void
  onCloseBoardCreate: () => void
  onCloseCreate: () => void
  onCloseEdit: () => void
  onConfirmDelete: (project: ProjectRecord) => void
}

/**
 * The Projects sidebar's four dialogs, one JSX block — mirrors
 * `SidebarDialogs.tsx`, the same pattern for the channels-shell sidebar.
 */
export const ProjectsNavDialogs = ({
  boardCreateBoards,
  boardCreateProjectId,
  createOpen,
  deleteTarget,
  editTarget,
  onBoardCreated,
  onCancelDelete,
  onCloseBoardCreate,
  onCloseCreate,
  onCloseEdit,
  onConfirmDelete,
}: ProjectsNavDialogsProps) => {
  const { t } = useTranslation('shell')
  return (
    <>
      <CreateProjectDialog onClose={onCloseCreate} open={createOpen} />
      {boardCreateProjectId ? (
        <BoardCreateDialog
          boards={boardCreateBoards}
          onClose={onCloseBoardCreate}
          onCreated={onBoardCreated}
          open
          projectId={boardCreateProjectId}
        />
      ) : null}
      {editTarget ? (
        <EditProjectDialog
          onClose={onCloseEdit}
          open
          project={editTarget}
        />
      ) : null}
      {deleteTarget ? (
        <ConfirmDialog
          body={t('projects.deleteWarning')}
          confirmLabel={t('projects.delete')}
          destructive
          onCancel={onCancelDelete}
          onConfirm={() => onConfirmDelete(deleteTarget)}
          open
          title={t('projects.deleteNamed', { name: deleteTarget.name })}
        />
      ) : null}
    </>
  )
}
