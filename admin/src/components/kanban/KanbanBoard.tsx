import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  type DragEndEvent,
  type DragStartEvent,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { type TaskRecord } from '../../facades/tasks/hooks'
import { ArchiveDoneMenu } from './ArchiveDoneMenu'
import { KanbanCard, KanbanCardPreview } from './KanbanCard'
import { KanbanColumn } from './KanbanColumn'
import { TaskDialog } from './TaskDialog'
import {
  ARCHIVED_STATUSES,
  type BoardColumnView,
  CATEGORY_DOT,
  placeTask,
} from './kanban-config'

// Columns fill the viewport but never shrink below this. The board fits as many
// columns as will sit at >= MIN_COLUMN_PX (plus the gap between them) into one
// page; the rest move to additional pages. Paging is a native horizontal
// scroll-snap, so the OS handles momentum / Magic-Mouse / trackpad / touch
// swipes, and dnd-kit's auto-scroll handles dropping a card onto a column on
// another page. (A CSS-transform carousel offset the drag overlay on Safari,
// because dnd-kit mis-measures a draggable inside a transformed ancestor.)
const MIN_COLUMN_PX = 300
const COLUMN_GAP_PX = 12 // gap-3
const DND_MEASURING = { droppable: { strategy: MeasuringStrategy.Always } }
// Touch drag is long-press activated so a short touch swipe scrolls/pages instead
// of grabbing a card; mouse drag stays distance activated.
const MOUSE_ACTIVATION = { activationConstraint: { distance: 8 } }
const TOUCH_ACTIVATION = { activationConstraint: { delay: 250, tolerance: 8 } }

type KanbanBoardProps = {
  columns: BoardColumnView[]
  tasks: TaskRecord[]
  showProject: boolean
  projectNameById: Record<string, string>
  // Drag handler: the parent decides whether this is a /move (project board) or
  // a status transition (aggregate board).
  onMoveTask: (taskId: string, columnId: string) => void
}

export const KanbanBoard = ({
  columns,
  tasks,
  showProject,
  projectNameById,
  onMoveTask,
}: KanbanBoardProps) => {
  const [showArchived, setShowArchived] = useState(false)
  const [activeTask, setActiveTask] = useState<TaskRecord | null>(null)
  const [draggingTask, setDraggingTask] = useState<TaskRecord | null>(null)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [page, setPage] = useState(0)
  const viewportRef = useRef<HTMLDivElement | null>(null)

  const sensors = useSensors(
    useSensor(MouseSensor, MOUSE_ACTIVATION),
    useSensor(TouchSensor, TOUCH_ACTIVATION),
  )
  const isDraggingCard = draggingTask !== null

  // How many columns fit at >= MIN_COLUMN_PX, and how that splits into pages.
  const columnCount = Math.max(columns.length, 1)
  const perPage = Math.min(
    columnCount,
    Math.max(1, Math.floor((viewportWidth + COLUMN_GAP_PX) / (MIN_COLUMN_PX + COLUMN_GAP_PX))),
  )
  const pageCount = Math.max(1, Math.ceil(columns.length / perPage))
  const paginated = pageCount > 1

  const { byColumn, archived } = useMemo(() => {
    const grouped: Record<string, TaskRecord[]> = Object.fromEntries(columns.map((c) => [c.id, []]))
    const archivedTasks: TaskRecord[] = []
    for (const task of tasks) {
      // Explicitly archived done-work (archivedAt) leaves its column for the
      // Archived section, same as failed/cancelled.
      if (task.archivedAt) {
        archivedTasks.push(task)
        continue
      }
      const columnId = placeTask(task, columns)
      if (columnId && grouped[columnId]) grouped[columnId].push(task)
      else if (ARCHIVED_STATUSES.includes(task.status)) archivedTasks.push(task)
    }
    return { byColumn: grouped, archived: archivedTasks }
  }, [tasks, columns])

  // Columns chunked into pages; each page is one viewport-wide scroll-snap panel.
  const pageGroups = useMemo(() => {
    const groups: BoardColumnView[][] = []
    for (let i = 0; i < columns.length; i += perPage) groups.push(columns.slice(i, i + perPage))
    return groups
  }, [columns, perPage])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const measure = () => setViewportWidth(viewport.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  const showPage = useCallback((next: number) => {
    const viewport = viewportRef.current
    if (!viewport) return
    const clamped = Math.min(Math.max(next, 0), Math.max(pageCount - 1, 0))
    viewport.scrollTo({ left: clamped * viewport.clientWidth, behavior: 'smooth' })
  }, [pageCount])

  // Reflect the native scroll position in the dots.
  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const width = viewport.clientWidth
    if (width > 0) setPage(Math.round(viewport.scrollLeft / width))
  }, [])

  // Keep the current page valid when the viewport (and therefore pageCount) shrinks.
  useEffect(() => {
    if (page > pageCount - 1) showPage(pageCount - 1)
  }, [page, pageCount, showPage])

  const handleDragStart = (event: DragStartEvent) => {
    setDraggingTask(tasks.find((t) => t.id === String(event.active.id)) ?? null)
  }

  const clearDraggingTask = () => setDraggingTask(null)

  const handleDragEnd = (event: DragEndEvent) => {
    clearDraggingTask()
    const { active, over } = event
    if (!over) return
    const columnId = String(over.id)
    const task = tasks.find((t) => t.id === String(active.id))
    if (!task || placeTask(task, columns) === columnId) return
    onMoveTask(task.id, columnId)
  }

  const cardProps = (task: TaskRecord) => ({
    onOpen: setActiveTask,
    projectName: task.projectId ? projectNameById[task.projectId] ?? null : null,
    showProject,
    task,
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DndContext
        measuring={DND_MEASURING}
        sensors={sensors}
        onDragCancel={clearDraggingTask}
        onDragEnd={handleDragEnd}
        onDragStart={handleDragStart}
      >
        {paginated ? (
          <div aria-label="Board pages" className="mb-2 flex items-center justify-center gap-2">
            {Array.from({ length: pageCount }, (_, index) => (
              <button
                aria-current={index === page ? 'page' : undefined}
                aria-label={`Show page ${index + 1}`}
                className="flex h-7 w-7 items-center justify-center rounded-full"
                key={index}
                onClick={() => showPage(index)}
                type="button"
              >
                <span
                  className={[
                    'h-2.5 rounded-full transition-all',
                    index === page
                      ? 'w-6 bg-[color:var(--tx)]'
                      : 'w-2.5 bg-[color:var(--overlay-strong)]',
                  ].join(' ')}
                />
              </button>
            ))}
          </div>
        ) : null}
        <div
          ref={viewportRef}
          className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          data-kanban-board-viewport
          data-kanban-dragging={isDraggingCard ? 'true' : undefined}
          onScroll={handleScroll}
          // Snap fights dnd-kit's auto-scroll while a card is dragged across pages.
          style={{ scrollSnapType: isDraggingCard ? 'none' : undefined }}
        >
          {pageGroups.map((group, groupIndex) => (
            <div className="flex h-full w-full shrink-0 snap-start gap-3" key={groupIndex}>
              {group.map((column) => (
                <KanbanColumn
                  key={column.id}
                  columnId={column.id}
                  count={byColumn[column.id]?.length ?? 0}
                  dot={CATEGORY_DOT[column.category]}
                  headerAction={column.category === 'done' ? <ArchiveDoneMenu /> : undefined}
                  label={column.name}
                >
                  {(byColumn[column.id] ?? []).map((task) => (
                    <KanbanCard key={task.id} {...cardProps(task)} />
                  ))}
                </KanbanColumn>
              ))}
            </div>
          ))}
        </div>
        <DragOverlay dropAnimation={null}>
          {draggingTask ? (
            <KanbanCardPreview
              projectName={draggingTask.projectId ? projectNameById[draggingTask.projectId] ?? null : null}
              showProject={showProject}
              task={draggingTask}
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      <div className="mt-3 border-t border-[color:var(--sep)] pt-3">
        <button
          className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)] hover:text-[color:var(--tx)]"
          onClick={() => setShowArchived((value) => !value)}
          type="button"
        >
          <span>{showArchived ? '▾' : '▸'}</span>
          Archived ({archived.length})
        </button>
        {showArchived ? (
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {archived.length === 0 ? (
              <div className="text-xs text-[color:var(--tx3)]">No cancelled or failed work.</div>
            ) : (
              archived.map((task) => <KanbanCard key={task.id} {...cardProps(task)} archived />)
            )}
          </div>
        ) : null}
      </div>

      <TaskDialog open={activeTask !== null} task={activeTask} onClose={() => setActiveTask(null)} />
    </div>
  )
}
