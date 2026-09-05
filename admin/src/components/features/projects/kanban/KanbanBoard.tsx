import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  closestCorners,
  pointerWithin,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import type { BoardTaskRecord } from '../../../../facades/boards/hooks'
import type { TaskRecord } from '../../../../facades/tasks/hooks'
import { ArchiveDoneMenu } from './ArchiveDoneMenu'
import { ArchivedTaskCard, KanbanCard } from './KanbanCard'
import { KanbanColumn } from './KanbanColumn'
import { TaskDialog } from './TaskDialog'
import { type BoardColumnView, CATEGORY_DOT } from './kanban-config'

// Columns fill the viewport but never shrink below this. The board fits as many
// columns as will sit at >= MIN_COLUMN_PX (plus the gap between them) into one
// page; the rest move to additional pages. Paging is a native horizontal
// scroll-snap, so the OS handles momentum / Magic-Mouse / trackpad / touch
// swipes, and dnd-kit's auto-scroll handles dragging a card to a column on
// another page.
const MIN_COLUMN_PX = 300
const COLUMN_GAP_PX = 12 // gap-3
const DND_MEASURING = { droppable: { strategy: MeasuringStrategy.Always } }
// Touch drag is long-press activated so a short touch swipe scrolls/pages instead
// of grabbing a card; mouse drag stays distance activated.
const MOUSE_ACTIVATION = { activationConstraint: { distance: 8 } }
const TOUCH_ACTIVATION = { activationConstraint: { delay: 250, tolerance: 8 } }

type ItemMap = Record<string, string[]>

type KanbanBoardProps = {
  columns: BoardColumnView[]
  projectId?: string
  // Already placed by the server: `columnId` is the column this board shows
  // the task in, and null means the Archived strip.
  tasks: BoardTaskRecord[]
  showProject: boolean
  projectNameById: Record<string, string>
  // Persist a drag: move the task to `columnId` at `position` (index in that
  // column). Reordering within a column uses the same call (same columnId).
  onMoveTask: (taskId: string, columnId: string, position: number) => void
}

export const KanbanBoard = ({
  columns,
  projectId,
  tasks,
  showProject,
  projectNameById,
  onMoveTask,
}: KanbanBoardProps) => {
  const [showArchived, setShowArchived] = useState(false)
  const [activeTask, setActiveTask] = useState<TaskRecord | null>(null)
  const [isDraggingCard, setIsDraggingCard] = useState(false)
  // Card to pulse after it lands in a column from a drag.
  const [pulseId, setPulseId] = useState<string | null>(null)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [page, setPage] = useState(0)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)

  const sensors = useSensors(
    useSensor(MouseSensor, MOUSE_ACTIVATION),
    useSensor(TouchSensor, TOUCH_ACTIVATION),
  )

  // How many columns fit at >= MIN_COLUMN_PX, and how that splits into pages.
  const columnCount = Math.max(columns.length, 1)
  const perPage = Math.min(
    columnCount,
    Math.max(1, Math.floor((viewportWidth + COLUMN_GAP_PX) / (MIN_COLUMN_PX + COLUMN_GAP_PX))),
  )
  const pageCount = Math.max(1, Math.ceil(columns.length / perPage))
  const paginated = pageCount > 1

  // Grouping only — the server decided placement and order.
  const { byColumn, archived } = useMemo(() => {
    const grouped: Record<string, BoardTaskRecord[]> = Object.fromEntries(
      columns.map((c) => [c.id, []]),
    )
    const archivedTasks: BoardTaskRecord[] = []
    for (const task of tasks) {
      const column = task.columnId ? grouped[task.columnId] : undefined
      if (column) column.push(task)
      else archivedTasks.push(task)
    }
    return { byColumn: grouped, archived: archivedTasks }
  }, [tasks, columns])

  const taskById = useMemo(() => {
    const map = new Map<string, BoardTaskRecord>()
    for (const task of tasks) map.set(task.id, task)
    return map
  }, [tasks])

  // Server-derived order (tasks arrive position-sorted). `items` mirrors this
  // when idle and is mutated live during a drag so columns animate room.
  const baseItems = useMemo<ItemMap>(() => {
    const map: ItemMap = {}
    for (const column of columns) map[column.id] = (byColumn[column.id] ?? []).map((t) => t.id)
    return map
  }, [columns, byColumn])
  const [items, setItems] = useState<ItemMap>(baseItems)
  useEffect(() => {
    if (!draggingRef.current) setItems(baseItems)
  }, [baseItems])

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

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const width = viewport.clientWidth
    if (width > 0) setPage(Math.round(viewport.scrollLeft / width))
  }, [])

  useEffect(() => {
    if (page > pageCount - 1) showPage(pageCount - 1)
  }, [page, pageCount, showPage])

  const settleNearestPage = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport || !viewport.clientWidth) return
    showPage(Math.round(viewport.scrollLeft / viewport.clientWidth))
  }, [showPage])

  // Find which column (key of `items`) holds an id — or the id itself if it is a
  // column (dropped on the column's empty area).
  const findColumn = useCallback(
    (id: string, map: ItemMap): string | undefined => {
      if (map[id]) return id
      return columns.find((column) => map[column.id]?.includes(id))?.id
    },
    [columns],
  )

  // Pointer-based detection: a column (or the card under the cursor) becomes the
  // target the moment the cursor enters it — not when the dragged card's body
  // overlaps it. Fall back to closest-corners when the pointer is between things.
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerHits = pointerWithin(args)
    return pointerHits.length > 0 ? pointerHits : closestCorners(args)
  }, [])

  const handleDragStart = () => {
    draggingRef.current = true
    setIsDraggingCard(true)
    setItems(baseItems)
  }

  // Live-relocate the dragged card's placeholder to wherever the cursor hovers —
  // within the same column (reorder) or into another column — so the drop slot
  // (dashed placeholder) tracks the cursor and the column animates room for it.
  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event
    if (!over) return
    const activeId = String(active.id)
    const overId = String(over.id)
    if (activeId === overId) return
    setItems((prev) => {
      const fromColumn = findColumn(activeId, prev)
      const toColumn = findColumn(overId, prev)
      if (!fromColumn || !toColumn) return prev
      const fromItems = prev[fromColumn]
      const toItems = prev[toColumn]
      if (!fromItems || !toItems) return prev
      const activeIndex = fromItems.indexOf(activeId)
      const overIndex = overId === toColumn ? toItems.length : toItems.indexOf(overId)
      if (fromColumn === toColumn) {
        if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) return prev
        return { ...prev, [toColumn]: arrayMove(fromItems, activeIndex, overIndex) }
      }
      const insertAt = overIndex < 0 ? toItems.length : overIndex
      return {
        ...prev,
        [fromColumn]: fromItems.filter((id) => id !== activeId),
        [toColumn]: [...toItems.slice(0, insertAt), activeId, ...toItems.slice(insertAt)],
      }
    })
  }

  const handleDragCancel = () => {
    draggingRef.current = false
    setIsDraggingCard(false)
    setItems(baseItems)
    settleNearestPage()
  }

  const handleDragEnd = (event: DragEndEvent) => {
    draggingRef.current = false
    setIsDraggingCard(false)
    const { active, over } = event
    const activeId = String(active.id)

    if (!over) {
      setItems(baseItems)
      settleNearestPage()
      return
    }

    // onDragOver already placed the card in its destination column at the hovered
    // index, so read the final spot straight from `items`.
    const destColumn = findColumn(activeId, items)
    if (!destColumn) {
      setItems(baseItems)
      settleNearestPage()
      return
    }
    const finalIndex = (items[destColumn] ?? []).indexOf(activeId)
    const columnIndex = columns.findIndex((column) => column.id === destColumn)
    showPage(columnIndex >= 0 ? Math.floor(columnIndex / perPage) : page)

    // Persist only when the column or index actually changed.
    const task = taskById.get(activeId)
    const originalColumn = task?.columnId ?? null
    const originalIndex = originalColumn ? baseItems[originalColumn]?.indexOf(activeId) ?? -1 : -1
    if (finalIndex < 0 || (destColumn === originalColumn && finalIndex === originalIndex)) return
    onMoveTask(activeId, destColumn, finalIndex)
    setPulseId(activeId)
  }

  const cardProps = (task: BoardTaskRecord) => ({
    onOpen: setActiveTask,
    onPulseEnd: () => setPulseId((current) => (current === task.id ? null : current)),
    projectName: task.projectId ? projectNameById[task.projectId] ?? null : null,
    pulse: pulseId === task.id,
    showProject,
    task,
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DndContext
        collisionDetection={collisionDetection}
        measuring={DND_MEASURING}
        sensors={sensors}
        onDragCancel={handleDragCancel}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
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
          style={{ scrollSnapType: isDraggingCard ? 'none' : undefined }}
        >
          {pageGroups.map((group, groupIndex) => (
            <div className="flex h-full w-full shrink-0 snap-start gap-3" key={groupIndex}>
              {group.map((column) => {
                const ids = items[column.id] ?? []
                return (
                  <KanbanColumn
                    key={column.id}
                    columnId={column.id}
                    count={ids.length}
                    dot={CATEGORY_DOT[column.category]}
                    headerAction={column.category === 'done' && projectId ? <ArchiveDoneMenu projectId={projectId} /> : undefined}
                    itemIds={ids}
                    label={column.name}
                  >
                    {ids
                      .map((id) => taskById.get(id))
                      .filter((task): task is BoardTaskRecord => Boolean(task))
                      .map((task) => (
                        <KanbanCard key={task.id} {...cardProps(task)} />
                      ))}
                  </KanbanColumn>
                )
              })}
            </div>
          ))}
        </div>
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
              archived.map((task) => (
                <ArchivedTaskCard
                  key={task.id}
                  onOpen={setActiveTask}
                  projectName={task.projectId ? projectNameById[task.projectId] ?? null : null}
                  showProject={showProject}
                  task={task}
                />
              ))
            )}
          </div>
        ) : null}
      </div>

      <TaskDialog open={activeTask !== null} task={activeTask} onClose={() => setActiveTask(null)} />
    </div>
  )
}
