import { BoardCreateDialog } from '../../components/features/projects/kanban/BoardCreateDialog'
import type { BoardRecord } from '../../facades/boards/hooks'
import { ConfirmDialog } from '../../components/shared/ConfirmDialog'
import { CreateProjectDialog } from '../../components/shared/CreateProjectDialog'
import { EditProjectDialog } from '../../components/shared/EditProjectDialog'
import type { ProjectRecord } from '../../lib/api-client'

type ProjectsNavDialogsProps = {
  boardCreateBoards: BoardRecord[]
  boardCreateProjectId: string | null
  createOpen: boolean
  deleteTarget: ProjectRecord | null
  editTarget: ProjectRecord | null
  onBoardCreated: (boardId: string) => void
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
          body="This cannot be undone."
          confirmLabel="Delete"
          destructive
          onCancel={onCancelDelete}
          onConfirm={() => onConfirmDelete(deleteTarget)}
          open
          title={`Delete project "${deleteTarget.name}"?`}
        />
      ) : null}
    </>
  )
}
