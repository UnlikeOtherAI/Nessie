import { Link } from 'react-router-dom'
import { useProjectBoard } from '../../../facades/board/hooks'
import { useIterations } from '../../../facades/iterations/hooks'
import { useTasks } from '../../../facades/tasks/hooks'
import { SkeletonBlock } from '../../primitives/Skeleton'
import {
  DashboardSectionCard,
  SectionNotice,
  type SectionLink,
} from './DashboardSectionCard'
import { scopeTasksToBoard, summarizeWork } from './project-dashboard-data'

type ProjectWorkSectionProps = {
  className?: string
  projectId: string
}

type Chip = {
  key: string
  label: string
  value: number
  // Exceptions are tinted and disappear at zero; the anchor always shows.
  tone: 'anchor' | 'danger' | 'warning'
}

const toneClass: Record<Chip['tone'], string> = {
  anchor: 'text-[color:var(--tx)]',
  danger: 'text-[color:var(--danger-text)]',
  warning: 'text-[color:var(--warning-text)]',
}

const formatEndDate = (value: string | null): string | null => {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/**
 * What is late, stuck or unstarted. Counts only — the board is one click away,
 * and a second task list here would inevitably disagree with it. Every chip
 * that appears (beyond the `Open` anchor) is an exception worth acting on.
 */
export const ProjectWorkSection = ({ className, projectId }: ProjectWorkSectionProps) => {
  const { data: board } = useProjectBoard(projectId)
  const isScrum = board?.style === 'scrum'
  const { data: iterations = [] } = useIterations(isScrum ? projectId : undefined)
  const { data: tasks, isError, isPending } = useTasks(projectId)

  const activeIteration = iterations.find((iteration) => iteration.status === 'active')
  // Scoped exactly like ProjectBoardTab, so the chips count what "Board →" shows.
  const scoped = scopeTasksToBoard(tasks ?? [], {
    activeIterationId: activeIteration?.id ?? null,
    isScrum: Boolean(isScrum),
  })
  const counts = summarizeWork(scoped)

  const boardHref = `/projects/${projectId}/board`
  const links: SectionLink[] = isScrum
    ? [
        { label: 'Board', to: boardHref },
        { label: 'Backlog', to: `/projects/${projectId}/backlog` },
        { label: 'Insights', to: `/projects/${projectId}/insights` },
      ]
    : [{ label: 'Board', to: boardHref }]

  const allChips: Chip[] = [
    { key: 'open', label: 'Open', tone: 'anchor', value: counts.open },
    { key: 'overdue', label: 'Overdue', tone: 'danger', value: counts.overdue },
    { key: 'urgent', label: 'Urgent', tone: 'danger', value: counts.urgent },
    { key: 'failed', label: 'Failed', tone: 'danger', value: counts.failed },
    {
      key: 'awaiting',
      label: 'Awaiting approval',
      tone: 'warning',
      value: counts.awaitingApproval,
    },
  ]
  const chips = allChips.filter((chip) => chip.key === 'open' || chip.value > 0)

  const endDate = formatEndDate(activeIteration?.endDate ?? null)

  return (
    <DashboardSectionCard className={className} links={links} title="Work">
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

      {isPending ? (
        <div className="flex gap-2 p-2">
          {[0, 1, 2].map((index) => (
            <SkeletonBlock className="h-6 w-20 rounded-full" key={index} />
          ))}
        </div>
      ) : null}

      {isError ? <SectionNotice>Tasks could not be loaded. Please refresh.</SectionNotice> : null}

      {!isPending && !isError && counts.open === 0 ? (
        <SectionNotice>
          Nothing open.{' '}
          <Link className="text-[color:var(--tx2)] hover:text-[color:var(--tx)]" to={boardHref}>
            Open the Board
          </Link>{' '}
          to add work.
        </SectionNotice>
      ) : null}

      {!isPending && !isError && counts.open > 0 ? (
        <div className="flex flex-wrap gap-2 p-2">
          {chips.map((chip) => (
            <Link
              className="flex items-center gap-1.5 rounded-full border border-[color:var(--sep)]
                px-2.5 py-1 text-xs hover:bg-[color:var(--overlay)]"
              key={chip.key}
              to={boardHref}
            >
              <span className="text-[color:var(--tx2)]">{chip.label}</span>
              <span className={['font-bold', toneClass[chip.tone]].join(' ')}>{chip.value}</span>
            </Link>
          ))}
        </div>
      ) : null}
    </DashboardSectionCard>
  )
}
