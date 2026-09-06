import { Link } from 'react-router-dom'
import { TaskPresentationMessageMetadataSchema } from '@nessie/schemas'
import { KanbanCardContent } from '../projects/kanban/KanbanCard'
import { usePresentedTask } from '../../../facades/tasks/hooks'
import { SkeletonBlock } from '../../primitives/Skeleton'

const CHANGE_LABEL: Record<string, string> = {
  status: 'moved',
  assignee: 'reassigned',
}

/**
 * A ticket, shown in chat as the card it is on the board.
 *
 * The board's own `KanbanCardContent` draws it — the same component, not a
 * second drawing of one, which is what keeps a Linear ticket in a conversation
 * looking like the Linear ticket on the board.
 *
 * The message carries only an id (see `TaskPresentationMessageMetadataSchema`),
 * and the task is read back through the ordinary entitlement-gated endpoint.
 * A reader who may not see it gets the refusal below rather than a card — and
 * because the check is the endpoint's, that holds however the message reached
 * them.
 */
export const TaskPresentation = ({
  metadata,
}: {
  metadata: Record<string, unknown> | undefined
}) => {
  const parsed = TaskPresentationMessageMetadataSchema.safeParse(metadata)
  const presentation = parsed.success ? parsed.data.taskPresentation : undefined
  const taskQuery = usePresentedTask(presentation?.taskId)

  if (!presentation) return null
  if (taskQuery.isLoading) {
    return (
      <SkeletonBlock className="mt-2 h-24 w-full max-w-sm rounded-lg border border-[color:var(--sep)]" />
    )
  }
  if (!taskQuery.data) {
    return (
      <div className="mt-2 max-w-sm rounded-lg border border-[color:var(--sep)] px-3 py-2 text-sm text-[color:var(--tx3)]">
        That ticket is no longer available to you.
      </div>
    )
  }

  const task = taskQuery.data
  const changes = (presentation.changes ?? [])
    .map((change) => CHANGE_LABEL[change] ?? change)
    .join(' and ')

  return (
    <div className="mt-2 max-w-sm">
      {changes ? (
        <p className="mb-1 text-xs text-[color:var(--tx3)]">Ticket {changes}</p>
      ) : null}
      <Link
        className="block"
        to={
          presentation.boardId
            ? `/projects/${task.projectId}/board?board=${presentation.boardId}&task=${task.id}`
            : `/projects/${task.projectId}/board?task=${task.id}`
        }
      >
        <KanbanCardContent projectName={null} showProject={false} task={task} />
      </Link>
    </div>
  )
}
