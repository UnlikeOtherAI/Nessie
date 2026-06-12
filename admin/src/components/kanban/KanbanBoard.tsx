import { type TouchEvent as ReactTouchEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { type TaskRecord } from '../../facades/tasks/hooks'
import { useMediaQuery } from '../../hooks/useMediaQuery'
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

const MOBILE_BOARD_QUERY = '(max-width: 767px)'
const EDGE_PAGE_ZONE_PX = 56
const EDGE_PAGE_INTERVAL_MS = 450
const SWIPE_PAGE_MIN_PX = 48
const SWIPE_PAGE_RATIO = 1.25
const DND_MEASURING = { droppable: { strategy: MeasuringStrategy.Always } }

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
  const isMobile = useMediaQuery(MOBILE_BOARD_QUERY)
  const [showArchived, setShowArchived] = useState(false)
  const [activeTask, setActiveTask] = useState<TaskRecord | null>(null)
  const [draggingTask, setDraggingTask] = useState<TaskRecord | null>(null)
  const [mobilePage, setMobilePage] = useState(0)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const mobilePageRef = useRef(0)
  const lastEdgePageAtRef = useRef(0)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const isDraggingCard = draggingTask !== null

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

  useEffect(() => {
    mobilePageRef.current = mobilePage
  }, [mobilePage])

  const showPage = useCallback((page: number) => {
    const maxPage = Math.max(columns.length - 1, 0)
    const nextPage = Math.min(Math.max(page, 0), maxPage)
    setMobilePage(nextPage)
    mobilePageRef.current = nextPage
  }, [columns.length])

  useEffect(() => {
    if (!isMobile) return
    if (mobilePage >= columns.length) showPage(columns.length - 1)
  }, [columns.length, isMobile, mobilePage, showPage])

  useEffect(() => {
    if (isMobile) showPage(mobilePageRef.current)
  }, [isMobile, showPage])

  const pageByClientX = useCallback((clientX: number) => {
    const viewport = viewportRef.current
    if (!viewport) return

    const rect = viewport.getBoundingClientRect()
    const direction =
      clientX >= rect.right - EDGE_PAGE_ZONE_PX ? 1 : clientX <= rect.left + EDGE_PAGE_ZONE_PX ? -1 : 0
    if (direction === 0) return

    const currentPage = mobilePageRef.current
    const nextPage = currentPage + direction

    if (nextPage === currentPage || nextPage < 0 || nextPage >= columns.length) return

    const now = performance.now()
    if (now - lastEdgePageAtRef.current < EDGE_PAGE_INTERVAL_MS) return

    lastEdgePageAtRef.current = now
    showPage(nextPage)
  }, [columns.length, showPage])

  const pageByDragDirection = useCallback((deltaX: number) => {
    const viewport = viewportRef.current
    if (!viewport) return

    const threshold = Math.max(64, viewport.clientWidth / 2 - EDGE_PAGE_ZONE_PX)
    if (Math.abs(deltaX) < threshold) return

    pageByClientX(deltaX > 0 ? viewport.getBoundingClientRect().right : viewport.getBoundingClientRect().left)
  }, [pageByClientX])

  const handleViewportTouchStart = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if (!isMobile || isDraggingCard) return

    const touch = event.touches.item(0)
    if (touch) touchStartRef.current = { x: touch.clientX, y: touch.clientY }
  }, [isDraggingCard, isMobile])

  const handleViewportTouchEnd = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if (!isMobile || isDraggingCard) {
      touchStartRef.current = null
      return
    }

    const start = touchStartRef.current
    const touch = event.changedTouches.item(0)
    touchStartRef.current = null
    if (!start || !touch) return

    const deltaX = touch.clientX - start.x
    const deltaY = touch.clientY - start.y
    if (Math.abs(deltaX) < SWIPE_PAGE_MIN_PX) return
    if (Math.abs(deltaX) < Math.abs(deltaY) * SWIPE_PAGE_RATIO) return

    showPage(mobilePageRef.current + (deltaX < 0 ? 1 : -1))
  }, [isDraggingCard, isMobile, showPage])

  useEffect(() => {
    if (!isMobile || !isDraggingCard) return

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
  }, [isDraggingCard, isMobile, pageByClientX])

  const handleDragStart = (event: DragStartEvent) => {
    const task = tasks.find((t) => t.id === String(event.active.id))
    const columnId = task ? placeTask(task, columns) : null
    const columnIndex = columnId ? columns.findIndex((column) => column.id === columnId) : -1

    setDraggingTask(task ?? null)
    lastEdgePageAtRef.current = performance.now() - EDGE_PAGE_INTERVAL_MS
    if (isMobile && columnIndex >= 0) showPage(columnIndex)
  }

  const handleDragMove = (event: DragMoveEvent) => {
    if (!isMobile) return
    pageByDragDirection(event.delta.x)
  }

  const clearDraggingTask = () => {
    setDraggingTask(null)
    lastEdgePageAtRef.current = 0
  }

  const handleDragEnd = (event: DragEndEvent) => {
    clearDraggingTask()
    const { active, over } = event
    const columnId = over ? String(over.id) : isMobile ? columns[mobilePageRef.current]?.id : null
    if (!columnId) return
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
        {isMobile && columns.length > 1 ? (
          <div aria-label="Board columns" className="mb-2 flex items-center justify-center gap-2 md:hidden">
            {columns.map((column, index) => (
              <button
                aria-current={index === mobilePage ? 'page' : undefined}
                aria-label={`Show ${column.name}`}
                className="flex h-7 w-7 items-center justify-center rounded-full"
                key={column.id}
                onClick={() => showPage(index)}
                type="button"
              >
                <span
                  className={[
                    'h-2.5 rounded-full transition-all',
                    index === mobilePage
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
          className="flex min-h-0 flex-1 gap-3 overflow-hidden overscroll-x-contain pb-2 md:overflow-x-auto"
          data-kanban-board-viewport
          data-kanban-dragging={isDraggingCard ? 'true' : undefined}
          onTouchCancel={() => {
            touchStartRef.current = null
          }}
          onTouchEnd={handleViewportTouchEnd}
          onTouchStart={handleViewportTouchStart}
        >
          {columns.map((column, index) => (
            <KanbanColumn
              key={column.id}
              columnId={column.id}
              count={byColumn[column.id]?.length ?? 0}
              dot={CATEGORY_DOT[column.category]}
              headerAction={column.category === 'done' ? <ArchiveDoneMenu /> : undefined}
              label={column.name}
              mobileActive={index === mobilePage}
            >
              {(byColumn[column.id] ?? []).map((task) => (
                <KanbanCard key={task.id} {...cardProps(task)} />
              ))}
            </KanbanColumn>
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
