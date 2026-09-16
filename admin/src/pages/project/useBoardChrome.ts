import { useCallback, useMemo } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { useBoardTasks, type BoardTaskRecord } from '../../facades/boards/hooks'
import { useTaskAssignees, type AssignableUser } from '../../facades/tasks/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import {
  ALL_ASSIGNEES,
  assigneeFilterOptions,
  matchesAssigneeFilter,
  parseAssigneeFilter,
  type AssigneeFilter,
  type RemoteAssigneeOption,
} from '../../components/features/projects/kanban/board-assignee-filter'
import {
  BOARD_VIEWS,
  DEFAULT_BOARD_VIEW,
  type BoardView,
} from '../../components/features/projects/kanban/board-view'
import { useTabParam } from '../../navigation/useTabParam'

/**
 * The three choices a person makes *about* a board rather than in it: how its
 * tickets are drawn, whose tickets are shown, and whether the archived ones
 * are shown at all.
 *
 * They live here because the controls and the board are no longer in the same
 * place on screen — the header's Configure menu and its assignee filter set
 * them, and `KanbanBoard` obeys them — and a prop chain between the two would
 * have to thread through the whole page. Each value is a URL search param, so
 * a narrowed board survives a reload and is a link somebody can send;
 * `Board.filter` remains the board's own shared definition, untouched here.
 *
 * Both callers read the same URL and the same React Query cache, so calling
 * this twice on one screen is one piece of state and one fetch, not two.
 */

const ARCHIVED_STATES = ['hidden', 'shown'] as const

export type BoardChrome = {
  assignee: AssigneeFilter
  currentUserId: string | null
  /**
   * The whole pool, so narrowing to one person does not empty the list you
   * would use to pick somebody else.
   */
  people: AssignableUser[]
  remote: RemoteAssigneeOption[]
  setAssignee: (next: AssigneeFilter) => void
  setShowArchived: (next: boolean) => void
  setView: (next: BoardView) => void
  showArchived: boolean
  /** Every ticket on the board, before the assignee filter. */
  tasks: BoardTaskRecord[]
  tasksQuery: ReturnType<typeof useBoardTasks>
  /** What the board draws: `tasks` narrowed to `assignee`. */
  visibleTasks: BoardTaskRecord[]
  view: BoardView
}

export const useBoardChrome = (
  projectId: string | undefined,
  boardId: string | undefined,
): BoardChrome => {
  const tasksQuery = useBoardTasks(projectId, boardId)
  const { data: assignableUsers = [] } = useTaskAssignees()
  const { me } = useAuthSession()
  const currentUserId = me?.user.id ?? null

  const [view, setView] = useTabParam('view', BOARD_VIEWS, DEFAULT_BOARD_VIEW)
  const [archived, setArchived] = useTabParam('archived', ARCHIVED_STATES, 'hidden')

  // Not `useTabParam`: any assignee id is a valid value, so there is no closed
  // set for it to check a new one against — it would delete every value it was
  // given. The rest of the rule is kept by hand: the updater form, so a second
  // control on this screen cannot overwrite it with a stale copy, `replace`,
  // because a filter is not a history entry, and clearing rather than spelling
  // out the default.
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const entryState = location.state
  const assignee = parseAssigneeFilter(searchParams.get('assignee'))
  const setAssignee = useCallback(
    (next: AssigneeFilter) => {
      setSearchParams(
        (current) => {
          const params = new URLSearchParams(current)
          if (next === ALL_ASSIGNEES) params.delete('assignee')
          else params.set('assignee', next)
          return params
        },
        { replace: true, state: entryState },
      )
    },
    [entryState, setSearchParams],
  )

  const tasks = useMemo(() => tasksQuery.data?.tasks ?? [], [tasksQuery.data])

  const filterOptions = useMemo(
    () => assigneeFilterOptions(tasks, assignableUsers),
    [tasks, assignableUsers],
  )
  const visibleTasks = useMemo(
    () => tasks.filter((task) => matchesAssigneeFilter(task, assignee, currentUserId)),
    [tasks, assignee, currentUserId],
  )

  return {
    assignee,
    currentUserId,
    people: filterOptions.people,
    remote: filterOptions.remote,
    setAssignee,
    setShowArchived: (next) => setArchived(next ? 'shown' : 'hidden'),
    setView,
    showArchived: archived === 'shown',
    tasks,
    tasksQuery,
    visibleTasks,
    view,
  }
}
