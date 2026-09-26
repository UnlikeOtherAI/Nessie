import { BoardCreateDialog } from '../../components/features/projects/kanban/BoardCreateDialog'
import type { BoardRecord } from '../../facades/boards/hooks'
import { CreateProjectDialog } from '../../components/shared/CreateProjectDialog'

type ProjectsNavDialogsProps = {
  boardCreateBoards: BoardRecord[]
  boardCreateProjectId: string | null
  createOpen: boolean
  onBoardCreated: (board: BoardRecord) => void
  onCloseBoardCreate: () => void
  onCloseCreate: () => void
}

/**
 * The Projects sidebar's dialogs, one JSX block — mirrors
 * `SidebarDialogs.tsx`, the same pattern for the channels-shell sidebar.
 * Editing and deleting a project are Settings › General's, not the sidebar's.
 */
export const ProjectsNavDialogs = ({
  boardCreateBoards,
  boardCreateProjectId,
  createOpen,
  onBoardCreated,
  onCloseBoardCreate,
  onCloseCreate,
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
    </>
  )
}
