import { useMemo, useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { faComment, faGripVertical, faPaperclip, faSignal } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { TicketWorkCardRecord } from '@nessie/schemas'
import type { TaskRecord } from '../../../../facades/tasks/hooks'
import { TicketWorkCardDot } from '../../ticket-work/TicketWorkCardDot'
import { Pill } from '../../../primitives/Pill'
import { ExternalKeyPill } from './ExternalKeyPill'
import { RemotePersonPill } from './RemotePersonPill'
import { TaskFieldChips } from './TaskFieldChips'
import { useTaskFields } from '../../../../facades/task-fields/hooks'
import { useTaskAssignees } from '../../../../facades/tasks/hooks'
import type { BoardView } from './board-view'
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
  view?: BoardView
  /** An agent's live (or limit-stopped) work on this ticket, as the board read says it. */
  work?: TicketWorkCardRecord | null
}

const MAX_EXCERPT_CHARS = 180

/**
 * The description is Markdown now; a card reads it as words. Images drop out
 * (the dialog shows them), links keep their text, and block and emphasis
 * markers go — this is presentation of the stored text, nothing is inferred.
 */
export const markdownToPlainText = (markdown: string): string =>
  markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/^\s*(?:```|~~~).*$/gm, '')
    .replace(/(\*\*|__|\*|_|`)(?=\S)([^\n]*?\S)\1/g, '$2')

const buildCardExcerpt = (value: string | null | undefined): string | null => {
  const normalized = value ? markdownToPlainText(value).replace(/\s+/g, ' ').trim() : undefined
  if (!normalized) return null
  if (normalized.length <= MAX_EXCERPT_CHARS) return normalized
  return `${normalized.slice(0, MAX_EXCERPT_CHARS).trimEnd()}...`
}

export const KanbanCardContent = ({
  task,
  showProject,
  projectName,
  archived,
  work,
}: Pick<KanbanCardProps, 'task' | 'showProject' | 'projectName' | 'work'> & { archived?: boolean }) => {
  const excerpt = buildCardExcerpt(task.title ? task.purpose : null)
    ?? buildCardExcerpt(task.detail)
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
        labels={task.labels ?? []}
        people={peopleById}
        values={task.fieldValues ?? {}}
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <FontAwesomeIcon
          className={`shrink-0 text-xs ${PRIORITY_SIGNAL[task.priority]}`}
          icon={faSignal}
          title={`${PRIORITY_LABEL[task.priority]} priority`}
        />
        {task.assigneeName === null && task.externalLink?.remoteAssigneeDisplay ? (
          <RemotePersonPill
            className="max-w-[11rem]"
            displayName={task.externalLink.remoteAssigneeDisplay}
            provider={task.externalLink.provider}
          />
        ) : (
          <Pill
            className="max-w-[11rem] gap-1 truncate font-semibold"
            size="sm"
            uppercase={false}
          >
            {task.assigneeName ?? 'Unassigned'}
          </Pill>
        )}
        {/* Discussion and material to read are a different decision from a
            bare card, which is what earns the glyphs — shown only when > 0. */}
        {task.commentCount > 0 ? (
          <span
            className="flex shrink-0 items-center gap-1 text-[10px] text-[color:var(--tx3)]"
            title={`${task.commentCount} ${task.commentCount === 1 ? 'comment' : 'comments'}`}
          >
            <FontAwesomeIcon icon={faComment} />
            {task.commentCount}
          </span>
        ) : null}
        {task.attachmentCount > 0 ? (
          <span
            className="flex shrink-0 items-center gap-1 text-[10px] text-[color:var(--tx3)]"
            title={`${task.attachmentCount} ${task.attachmentCount === 1 ? 'file' : 'files'}`}
          >
            <FontAwesomeIcon icon={faPaperclip} />
            {task.attachmentCount}
          </span>
        ) : null}
        {work ? <TicketWorkCardDot work={work} /> : null}
        {task.dueDate || archived ? (
          <span className="ml-auto flex items-center gap-1.5">
            {task.dueDate ? (
              <Pill
                className="gap-1 whitespace-nowrap font-semibold"
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

// The `lines` view: the title and the priority signal, nothing else. The full
// title stays reachable as a tooltip because one line truncates it.
export const KanbanLineContent = ({ task, work }: Pick<KanbanCardProps, 'task' | 'work'>) => {
  const title = task.title ?? task.purpose ?? 'Untitled task'
  return (
    <>
      <FontAwesomeIcon
        className={`shrink-0 text-xs ${PRIORITY_SIGNAL[task.priority]}`}
        icon={faSignal}
        title={`${PRIORITY_LABEL[task.priority]} priority`}
      />
      <span
        className="min-w-0 flex-1 truncate text-sm font-semibold text-[color:var(--tx)]"
        title={title}
      >
        {title}
      </span>
      {work ? <TicketWorkCardDot work={work} /> : null}
    </>
  )
}

const LINE_CLASS = 'admin-card relative flex min-h-11 select-none items-center gap-2 py-1 pl-3'
const CARD_CLASS = 'admin-card relative grid select-none gap-2 p-3'

// A board card: sortable within its column (vertical priority order) and
// draggable to another column via dnd-kit. Must live inside a SortableContext.
export const KanbanCard = ({
  task,
  showProject,
  projectName,
  onOpen,
  pulse = false,
  onPulseEnd,
  view = 'cards',
  work,
}: KanbanCardProps) => {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
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
        border: '2px dashed var(--accent)',
        background: 'var(--overlay-weak)',
      }
    : { transform: CSS.Transform.toString(transform), transition }

  const taskLabel = task.title ?? task.purpose ?? 'Untitled task'

  return (
    <div
      ref={setNodeRef}
      data-kanban-card
      data-kanban-placeholder={isDragging ? 'true' : undefined}
      data-kanban-view={view}
      className={[
        view === 'lines' ? `${LINE_CLASS} pr-12` : `${CARD_CLASS} pr-12`,
        isDragging ? '[&>*]:invisible' : '',
        pulse ? 'admin-attention-pulse' : '',
      ].join(' ')}
      onAnimationEnd={pulse ? onPulseEnd : undefined}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      style={style}
    >
      {/* A card's body is an ordinary tap target and scroll surface. The drag
          activator is deliberately separate: `touch-action: none` on the old
          full-card activator prevented both horizontal board paging and the
          column's vertical native scroll before dnd-kit could even decide
          whether a long press was a drag. */}
      <button
        aria-label={`Reorder ${taskLabel}`}
        className={`absolute right-1 ${view === 'lines' ? 'top-1/2 -translate-y-1/2' : 'top-1'} flex h-11 w-11 cursor-grab touch-none items-center justify-center rounded-md text-[color:var(--tx3)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)] active:cursor-grabbing`}
        data-kanban-drag-handle
        onClick={(event) => event.stopPropagation()}
        ref={setActivatorNodeRef}
        title="Drag to reorder or move this task"
        type="button"
        {...attributes}
        {...listeners}
      >
        <FontAwesomeIcon icon={faGripVertical} />
      </button>
      {view === 'lines' ? (
        <KanbanLineContent task={task} work={work} />
      ) : (
        <KanbanCardContent projectName={projectName} showProject={showProject} task={task} work={work} />
      )}
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
  view = 'cards',
}: Pick<KanbanCardProps, 'task' | 'showProject' | 'projectName' | 'onOpen' | 'view'>) => (
  <div
    aria-label={`Open ${task.title ?? task.purpose ?? 'task'}`}
    className={`${view === 'lines' ? `${LINE_CLASS} pr-3` : CARD_CLASS} cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]`}
    data-kanban-card
    data-kanban-view={view}
    onClick={() => onOpen(task)}
    onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
      event.preventDefault()
      onOpen(task)
    }}
    role="button"
    tabIndex={0}
  >
    {view === 'lines' ? (
      <KanbanLineContent task={task} />
    ) : (
      <KanbanCardContent archived projectName={projectName} showProject={showProject} task={task} />
    )}
  </div>
)
