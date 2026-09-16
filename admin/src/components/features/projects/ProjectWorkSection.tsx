import { DEFAULT_BOARD_NAME } from '@nessie/schemas'
import { Link } from 'react-router-dom'
import { useProjectBoards } from '../../../facades/boards/hooks'
import { useIterations } from '../../../facades/iterations/hooks'
import { useTasks } from '../../../facades/tasks/hooks'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { Pill } from '../../primitives/Pill'
import { Skeleton } from '../../primitives/Skeleton'
import { SectionOverflowHint } from '../../shared/SectionOverflowHint'
import { statusLabel } from './kanban/kanban-config'
import { taskStatusTone } from './kanban/task-status-presentation'
import {
  DashboardSectionCard,
  SectionNotice,
  dashboardRowClass,
  type SectionLink,
} from './DashboardSectionCard'
import {
  WORK_ROW_CAP,
  formatRelativeAge,
  projectWorkQueue,
  scopeTasksToBoard,
  summarizeWork,
  type WorkFocus,
} from './project-dashboard-data'

type ProjectWorkSectionProps = {
  className?: string
  projectId: string
}

/**
 * The card names the list it is showing. "Your work" and "To do" are different
 * promises, and an unlabelled column of somebody else's tickets reads as yours.
 */
const FOCUS_TITLE: Record<WorkFocus, string> = {
  mine: 'Your work',
  open: 'Open work',
  todo: 'To do',
}

const FOCUS_EMPTY: Record<WorkFocus, string> = {
  mine: 'Nothing assigned to you.',
  open: 'Nothing open.',
  todo: 'Nothing waiting to be picked up.',
}

const formatDueDate = (value: string): string | null => {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

const formatEndDate = (value: string | null): string | null =>
  value === null ? null : formatDueDate(value)

/**
 * Where the work is at the moment: the reader's own open tickets, newest
 * first. With none of their own it falls back to what nobody has picked up,
 * and then to everything still open — `projectWorkQueue` decides, and says
 * which of the three it chose so the card can name it.
 *
 * This replaced a chip-only summary. Counts alone answered "how much" and
 * never "what", so a person still had to open the board to learn whether any
 * of it was theirs. The exception chips survive above the list, because
 * overdue and failed work is the one thing on this page that must be acted on
 * and a list ordered by recency will not surface it.
 */
export const ProjectWorkSection = ({ className, projectId }: ProjectWorkSectionProps) => {
  const { me } = useAuthSession()
  const { data: boards = [] } = useProjectBoards(projectId)
  // Backlog and Insights are project-level, so they show when *any* board of
  // this project runs sprints.
  const isScrum = boards.some((board) => board.style === 'scrum')
  const { data: iterations = [] } = useIterations(isScrum ? projectId : undefined)
  const { data: tasks, isError, isPending } = useTasks(projectId)

  const activeIteration = iterations.find((iteration) => iteration.status === 'active')
  // The whole project's work, not one board's: this card sits on the project
  // Overview and offers a link per board underneath, so a count that silently
  // meant "the default board" would answer a question nobody asked. The scrum
  // narrowing stays, because an iteration is a project-level time box.
  const scoped = scopeTasksToBoard(tasks ?? [], {
    activeIterationId: activeIteration?.id ?? null,
    isScrum: Boolean(isScrum),
  })
  const counts = summarizeWork(scoped)
  const queue = projectWorkQueue(scoped, { limit: WORK_ROW_CAP, userId: me?.user.id })

  const boardHref = `/projects/${projectId}/board`
  const taskHref = (taskId: string) => `${boardHref}?task=${encodeURIComponent(taskId)}`
  // One link per board, named, so a project's second and third boards are
  // reachable from the place a person is standing when they wonder about them
  // — not only from inside the board tab's own switcher.
  const boardLinks: SectionLink[] = boards.map((board) => ({
    label: board.name,
    to: board.isDefault ? boardHref : `${boardHref}?board=${board.id}`,
  }))
  const links: SectionLink[] = boardLinks.length > 0
    ? boardLinks
    : [{ label: DEFAULT_BOARD_NAME, to: boardHref }]

  const exceptions = [
    { key: 'overdue', label: 'Overdue', tone: 'danger' as const, value: counts.overdue },
    { key: 'urgent', label: 'Urgent', tone: 'danger' as const, value: counts.urgent },
    { key: 'failed', label: 'Failed', tone: 'danger' as const, value: counts.failed },
    {
      key: 'awaiting',
      label: 'Awaiting approval',
      tone: 'warning' as const,
      value: counts.awaitingApproval,
    },
  ].filter((chip) => chip.value > 0)

  const endDate = formatEndDate(activeIteration?.endDate ?? null)
  const now = Date.now()

  return (
    <DashboardSectionCard
      className={className}
      count={isPending ? undefined : queue.matched}
      links={links}
      title={FOCUS_TITLE[queue.focus]}
    >
      {isScrum && activeIteration ? (
        <Link
          className="flex flex-wrap items-baseline gap-x-2 rounded-md px-2 py-1.5 text-xs
            hover:bg-[color:var(--overlay)]"
          to={boardHref}
        >
          <span className="font-semibold uppercase tracking-[0.16em] text-[color:var(--tx2)]">
            {activeIteration.name}
          </span>
          {activeIteration.goal ? (
            <span className="truncate text-[color:var(--tx3)]">{activeIteration.goal}</span>
          ) : null}
          <span className="ml-auto whitespace-nowrap text-[color:var(--tx3)]">
            {endDate ? `ends ${endDate} · ` : ''}
            {activeIteration.pointsDone}/{activeIteration.pointsTotal} pts
          </span>
        </Link>
      ) : null}

      {isPending ? <Skeleton className="p-2" variant="list" /> : null}

      {isError ? <SectionNotice>Tasks could not be loaded. Please refresh.</SectionNotice> : null}

      {!isPending && !isError && exceptions.length > 0 ? (
        <div className="flex flex-wrap gap-2 px-2 pb-1 pt-2">
          {exceptions.map((chip) => (
            <Link
              className="flex items-center gap-1.5 rounded-full border border-[color:var(--sep)]
                px-2.5 py-1 text-xs hover:bg-[color:var(--overlay)]"
              key={chip.key}
              to={boardHref}
            >
              <span className="text-[color:var(--tx2)]">{chip.label}</span>
              <span
                className={[
                  'font-bold',
                  chip.tone === 'danger'
                    ? 'text-[color:var(--danger-text)]'
                    : 'text-[color:var(--warning-text)]',
                ].join(' ')}
              >
                {chip.value}
              </span>
            </Link>
          ))}
        </div>
      ) : null}

      {!isPending && !isError && queue.tasks.length === 0 ? (
        <SectionNotice>
          {FOCUS_EMPTY[queue.focus]}{' '}
          <Link className="text-[color:var(--tx2)] hover:text-[color:var(--tx)]" to={boardHref}>
            Open the Board
          </Link>{' '}
          to add work.
        </SectionNotice>
      ) : null}

      {queue.tasks.map((task) => {
        const due = task.dueDate ? formatDueDate(task.dueDate) : null
        const overdue = task.dueDate !== null && Date.parse(task.dueDate) < now
        return (
          <Link
            className={[dashboardRowClass, 'project-work-row'].join(' ')}
            key={task.id}
            to={taskHref(task.id)}
          >
            <span className="project-work-row-status">
              <Pill height="control" radius="chip" size="sm" tone={taskStatusTone(task.status)}>
                {statusLabel(task.status)}
              </Pill>
            </span>
            <span className="project-work-row-title truncate text-sm text-[color:var(--tx)]">
              {task.title ?? 'Untitled'}
            </span>
            <span
              className={[
                'project-work-row-meta ml-auto whitespace-nowrap text-xs',
                overdue ? 'text-[color:var(--danger-text)]' : 'text-[color:var(--tx3)]',
              ].join(' ')}
            >
              {due ? (overdue ? `due ${due}` : due) : formatRelativeAge(task.updatedAt)}
            </span>
          </Link>
        )
      })}
      <SectionOverflowHint count={queue.matched - queue.tasks.length} noun="ticket" />
    </DashboardSectionCard>
  )
}
