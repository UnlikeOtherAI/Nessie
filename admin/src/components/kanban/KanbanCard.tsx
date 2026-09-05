import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { faSignal } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { TaskRecord } from '../../facades/tasks/hooks'
import { useMemo } from 'react'
import { Pill } from '../primitives/Pill'
import { ExternalKeyPill } from './ExternalKeyPill'
import { TaskFieldChips } from './TaskFieldChips'
import { useTaskFields } from '../../facades/task-fields/hooks'
import { useTaskAssignees } from '../../facades/tasks/hooks'
import { statusLabel } from './kanban-config'
import { PRIORITY_LABEL, PRIORITY_SIGNAL, formatDueDate, isOverdue } from './task-meta'

type KanbanCardProps = {
  task: TaskRecord
  showProject: boolean
  projectName: string | null
  onOpen: (task: TaskRecord) => void
  // Pulse the card briefly after it lands in a column from a drag.
  pulse?: boolean
  onPulseEnd?: () => void
}

const MAX_EXCERPT_CHARS = 180

const buildCardExcerpt = (value: string | null | undefined): string | null => {
  const normalized = value?.replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  if (normalized.length <= MAX_EXCERPT_CHARS) return normalized
  return `${normalized.slice(0, MAX_EXCERPT_CHARS).trimEnd()}...`
}

const KanbanCardContent = ({
  task,
  showProject,
  projectName,
  archived,
}: Pick<KanbanCardProps, 'task' | 'showProject' | 'projectName'> & { archived?: boolean }) => {
  const excerpt = buildCardExcerpt(task.detail ?? (task.title ? task.purpose : null))
  const { data: fieldDefinitions = [] } = useTaskFields(task.projectId ?? undefined)
  const { data: assignees = [] } = useTaskAssignees()
  const peopleById = useMemo(
    () => Object.fromEntries(assignees.map((person) => [person.id, person.displayName])),
    [assignees],
  )

  return (
    <>
      {task.externalLink ? (
        <ExternalKeyPill
          externalKey={task.externalLink.externalKey}
          externalUrl={task.externalLink.externalUrl}
          provider={task.externalLink.provider}
        />
      ) : showProject && projectName ? (
        <Pill className="justify-self-start" size="sm">
          {projectName}
        </Pill>
      ) : null}

      <div className="break-words text-sm font-semibold leading-snug text-[color:var(--tx)] line-clamp-3">
        {task.title ?? task.purpose ?? 'Untitled task'}
      </div>
      {excerpt ? (
        <div className="break-words text-xs font-normal leading-snug text-[color:var(--tx2)] line-clamp-4">
          {excerpt}
        </div>
      ) : null}

      <TaskFieldChips
        definitions={fieldDefinitions}
        people={peopleById}
        values={task.fieldValues ?? {}}
      />

      <div className="flex items-center gap-1.5">
        <FontAwesomeIcon
          className={`shrink-0 text-xs ${PRIORITY_SIGNAL[task.priority]}`}
          icon={faSignal}
          title={`${PRIORITY_LABEL[task.priority]} priority`}
        />
        <Pill
          className="max-w-[11rem] gap-1 truncate font-semibold"
          size="sm"
          uppercase={false}
        >
          {task.assigneeName ??
            task.externalLink?.remoteAssigneeDisplay ??
            'Unassigned'}
        </Pill>
        {task.dueDate || archived ? (
          <span className="ml-auto flex items-center gap-1.5">
            {task.dueDate ? (
              <Pill
                className="gap-1 font-semibold"
                size="sm"
                tone={isOverdue(task.dueDate) ? 'danger' : 'muted'}
                uppercase={false}
              >
                {formatDueDate(task.dueDate)}
              </Pill>
            ) : null}
            {archived ? <Pill size="sm">{statusLabel(task.status)}</Pill> : null}
          </span>
        ) : null}
      </div>
    </>
  )
}

// A board card: sortable within its column (vertical priority order) and
// draggable to another column via dnd-kit. Must live inside a SortableContext.
export const KanbanCard = ({
  task,
  showProject,
  projectName,
  onOpen,
  pulse = false,
  onPulseEnd,
}: KanbanCardProps) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  })

  // Distinguish a click (open the dialog) from a drag (move/reorder the card):
  // record the pointer-down position and only open if the pointer barely moved.
  // The dnd sensor activators come from `listeners` (mousedown / touchstart) —
  // touch drag is long-press activated, so a short touch swipe pages the board.
  const downAt = useRef<{ x: number; y: number } | null>(null)
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    downAt.current = { x: event.clientX, y: event.clientY }
  }
  const handleClick = (event: { clientX: number; clientY: number }) => {
    const start = downAt.current
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return
    onOpen(task)
  }

  // While dragging, this card becomes the drop placeholder: it stays put in the
  // slot it would land in (no follow transform) and shows as a dashed, card-sized
  // rectangle with its contents hidden. Siblings animate to make room
  // (transition). The board relocates this slot to wherever the cursor hovers.
  const style = isDragging
    ? {
        transition,
        touchAction: 'none' as const,
        border: '2px dashed var(--accent)',
        background: 'var(--overlay-weak)',
      }
    : { transform: CSS.Transform.toString(transform), transition, touchAction: 'none' as const }

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      data-kanban-card
      data-kanban-placeholder={isDragging ? 'true' : undefined}
      className={[
        'admin-card grid select-none gap-2 p-3',
        'cursor-grab active:cursor-grabbing',
        isDragging ? '[&>*]:invisible' : '',
        pulse ? 'kanban-card-pulse' : '',
      ].join(' ')}
      onAnimationEnd={pulse ? onPulseEnd : undefined}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      style={style}
    >
      <KanbanCardContent projectName={projectName} showProject={showProject} task={task} />
    </div>
  )
}

// Cancelled/failed/archived cards: read-only, not draggable, shown in the
// Archived section outside any SortableContext.
export const ArchivedTaskCard = ({
  task,
  showProject,
  projectName,
  onOpen,
}: Pick<KanbanCardProps, 'task' | 'showProject' | 'projectName' | 'onOpen'>) => (
  <div
    className="admin-card grid cursor-pointer select-none gap-2 p-3"
    data-kanban-card
    onClick={() => onOpen(task)}
  >
    <KanbanCardContent archived projectName={projectName} showProject={showProject} task={task} />
  </div>
)
