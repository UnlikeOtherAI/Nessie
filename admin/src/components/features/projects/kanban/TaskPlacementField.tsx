import type { TaskRecord } from '../../../../facades/tasks/hooks'
import { useProjectBoards } from '../../../../facades/boards/hooks'
import { FormField } from '../../../shared/FormField'
import { Select } from '../../../shared/FormControls'

type TaskPlacementFieldProps = {
  boardId?: string
  columnId: string | null
  disabled: boolean
  onChange: (columnId: string) => void
  projectId?: string | null
  task: TaskRecord
  taskColumnId?: string | null
}

/** A ticket's draft column, resolved only from the board that owns the ticket. */
export const TaskPlacementField = ({
  boardId,
  columnId,
  disabled,
  onChange,
  projectId,
  task,
  taskColumnId,
}: TaskPlacementFieldProps) => {
  const { data: projectBoards = [] } = useProjectBoards(projectId ?? undefined)
  const taskBoardId = task.boardId ?? boardId ?? null
  const taskBoard = projectBoards.find((candidate) => candidate.id === taskBoardId)

  if (!taskColumnId || !taskBoard) return null

  return (
    <FormField help="Moving a ticket updates its status to match the column." label="Column">
      <Select disabled={disabled} onChange={(event) => onChange(event.target.value)} value={columnId ?? ''}>
        {taskBoard.columns.map((column) => (
          <option key={column.id} value={column.id}>
            {column.name}
          </option>
        ))}
      </Select>
    </FormField>
  )
}
