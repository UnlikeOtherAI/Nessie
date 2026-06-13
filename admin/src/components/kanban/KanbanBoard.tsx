import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  type DragEndEvent,
  type DragMoveEvent,
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
// columns as will sit at >= MIN_COLUMN_PX (plus the gap between them); the rest
// move to additional pages reachable via the dots / swipe / drag-to-edge.
const MIN_COLUMN_PX = 300
const COLUMN_GAP_PX = 12 // gap-3
const EDGE_PAGE_ZONE_PX = 56
const EDGE_PAGE_INTERVAL_MS = 450
const SWIPE_PAGE_MIN_PX = 48
const SWIPE_PAGE_RATIO = 1.25
const SWIPE_START_PX = 4
const PAGE_TRANSITION = 'transform 320ms cubic-bezier(0.22, 1, 0.36, 1)'
const DND_MEASURING = { droppable: { strategy: MeasuringStrategy.Always } }
// Touch drag is long-press activated so a short touch swipe pages instead of
// grabbing a card; mouse drag stays distance activated.
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
  // Live finger-follow offset (px) and whether a swipe is in progress (disables
  // the snap transition so the track tracks the pointer 1:1).
  const [dragOffset, setDragOffset] = useState(0)
  const [swiping, setSwiping] = useState(false)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const pageRef = useRef(0)
  const lastEdgePageAtRef = useRef(0)
  // Set once a card drag activates so the page-swipe gesture yields to it.
  const cardDragRef = useRef(false)

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

  // Columns chunked into pages; each page is one viewport-wide carousel panel.
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

  useEffect(() => {
    pageRef.current = page
  }, [page])

  const showPage = useCallback((next: number) => {
    const maxPage = Math.max(pageCount - 1, 0)
    const clamped = Math.min(Math.max(next, 0), maxPage)
    setPage(clamped)
    pageRef.current = clamped
  }, [pageCount])

  // Keep the current page valid when the viewport (and therefore pageCount) shrinks.
  useEffect(() => {
    if (page > pageCount - 1) showPage(pageCount - 1)
  }, [page, pageCount, showPage])

  const pageByClientX = useCallback((clientX: number) => {
    const viewport = viewportRef.current
    if (!viewport) return

    const rect = viewport.getBoundingClientRect()
    const direction =
      clientX >= rect.right - EDGE_PAGE_ZONE_PX ? 1 : clientX <= rect.left + EDGE_PAGE_ZONE_PX ? -1 : 0
    if (direction === 0) return

    const currentPage = pageRef.current
    const nextPage = currentPage + direction

    if (nextPage === currentPage || nextPage < 0 || nextPage >= pageCount) return

    const now = performance.now()
    if (now - lastEdgePageAtRef.current < EDGE_PAGE_INTERVAL_MS) return

    lastEdgePageAtRef.current = now
    showPage(nextPage)
  }, [pageCount, showPage])

  const pageByDragDirection = useCallback((deltaX: number) => {
    const viewport = viewportRef.current
    if (!viewport) return

    const threshold = Math.max(64, viewport.clientWidth / 2 - EDGE_PAGE_ZONE_PX)
    if (Math.abs(deltaX) < threshold) return

    pageByClientX(deltaX > 0 ? viewport.getBoundingClientRect().right : viewport.getBoundingClientRect().left)
  }, [pageByClientX])

  // Swipe pages with mouse, touch, or pen. The track follows the pointer during
  // the drag and snaps (animated) to the nearest page on release. A press that
  // lands on a control never swipes; on mouse/pen a press on a card starts a card
  // drag instead (touch cards need a long-press, so a short touch swipe pages).
  const handleViewportPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!paginated || isDraggingCard || !event.isPrimary) return

    // Cards carry role="button" (dnd-kit), so the touch blocker excludes only real
    // controls — a short touch swipe over a card still pages. On mouse/pen a press
    // on a card starts a card drag, so cards are excluded there.
    const controls = 'button, a, input, textarea, select'
    const blocker =
      event.pointerType === 'touch' ? controls : `[data-kanban-card], [role="button"], ${controls}`
    if ((event.target as HTMLElement).closest(blocker)) return

    cardDragRef.current = false
    const startX = event.clientX
    const startY = event.clientY
    const pointerId = event.pointerId
    const basePage = pageRef.current
    const width = viewportRef.current?.clientWidth ?? viewportWidth
    const minOffset = -(pageCount - 1 - basePage) * width
    const maxOffset = basePage * width
    let following = false

    const reset = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      setSwiping(false)
      setDragOffset(0)
    }
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return
      if (cardDragRef.current) {
        reset()
        return
      }
      const deltaX = move.clientX - startX
      const deltaY = move.clientY - startY
      // Commit to a horizontal swipe only once it clearly dominates; leave mostly
      // vertical drags alone so the page can still scroll.
      if (!following && (Math.abs(deltaX) < SWIPE_START_PX || Math.abs(deltaX) < Math.abs(deltaY))) return
      following = true
      setSwiping(true)
      setDragOffset(Math.max(minOffset, Math.min(maxOffset, deltaX)))
    }
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return
      const deltaX = up.clientX - startX
      const deltaY = up.clientY - startY
      reset()
      if (cardDragRef.current) return
      if (Math.abs(deltaX) < SWIPE_PAGE_MIN_PX) return
      if (Math.abs(deltaX) < Math.abs(deltaY) * SWIPE_PAGE_RATIO) return
      showPage(basePage + (deltaX < 0 ? 1 : -1))
    }
    const onCancel = (cancel: PointerEvent) => {
      if (cancel.pointerId !== pointerId) return
      reset()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }, [isDraggingCard, paginated, pageCount, showPage, viewportWidth])

  useEffect(() => {
    if (!paginated || !isDraggingCard) return

    const handlePointerMove = (event: MouseEvent | PointerEvent) => {
      pageByClientX(event.clientX)
    }

    const handleTouchMove = (event: TouchEvent) => {
      const touch = event.touches.item(0)
      if (touch) pageByClientX(touch.clientX)
    }

    window.addEventListener('pointermove', handlePointerMove, { passive: true })
    window.addEventListener('mousemove', handlePointerMove, { passive: true })
    window.addEventListener('touchmove', handleTouchMove, { passive: true })
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('mousemove', handlePointerMove)
      window.removeEventListener('touchmove', handleTouchMove)
    }
  }, [isDraggingCard, paginated, pageByClientX])

  const handleDragStart = (event: DragStartEvent) => {
    const task = tasks.find((t) => t.id === String(event.active.id))
    const columnId = task ? placeTask(task, columns) : null
    const columnIndex = columnId ? columns.findIndex((column) => column.id === columnId) : -1

    cardDragRef.current = true
    setDraggingTask(task ?? null)
    lastEdgePageAtRef.current = performance.now() - EDGE_PAGE_INTERVAL_MS
    if (paginated && columnIndex >= 0) showPage(Math.floor(columnIndex / perPage))
  }

  const handleDragMove = (event: DragMoveEvent) => {
    if (!paginated) return
    pageByDragDirection(event.delta.x)
  }

  const clearDraggingTask = () => {
    setDraggingTask(null)
    lastEdgePageAtRef.current = 0
    cardDragRef.current = false
  }

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
        onDragMove={handleDragMove}
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
          className="min-h-0 flex-1 overflow-hidden"
          data-kanban-board-viewport
          data-kanban-dragging={isDraggingCard ? 'true' : undefined}
          onPointerDown={handleViewportPointerDown}
          style={{ touchAction: 'pan-y' }}
        >
          <div
            className="flex h-full w-full"
            data-kanban-track
            style={{
              transform: `translateX(calc(-${page * 100}% + ${dragOffset}px))`,
              transition: swiping ? 'none' : PAGE_TRANSITION,
            }}
          >
            {pageGroups.map((group, groupIndex) => (
              <div className="flex h-full w-full shrink-0 gap-3 pb-2" key={groupIndex}>
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
