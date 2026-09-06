import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { KanbanBoard } from '../../components/features/projects/kanban/KanbanBoard'
import { BoardAssigneeFilter } from '../../components/features/projects/kanban/BoardAssigneeFilter'
import {
  ALL_ASSIGNEES,
  assigneeFilterOptions,
  matchesAssigneeFilter,
  parseAssigneeFilter,
  type AssigneeFilter,
} from '../../components/features/projects/kanban/board-assignee-filter'
import type { BoardColumnView } from '../../components/features/projects/kanban/kanban-config'
import type { BoardRecord } from '../../facades/boards/hooks'
import { useBoardTasks } from '../../facades/boards/hooks'
import { useIterations } from '../../facades/iterations/hooks'
import { useProjects } from '../../facades/projects/hooks'
import { useCanAdministerProject } from '../../facades/projects/administration'
import { useMoveTask, useTaskAssignees } from '../../facades/tasks/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { useClearProjectAttention } from '../../facades/alerts/clear-project-attention'
import { useProjectSources } from '../../facades/board-sources/hooks'
import { SourceStatusStrip } from '../../components/features/projects/kanban/SourceStatusStrip'
import { EmptyState } from '../../components/shared/EmptyState'

type ProjectBoardTabProps = {
  board: BoardRecord | null
  projectId: string
}

export const ProjectBoardTab = ({ board, projectId }: ProjectBoardTabProps) => {
  const tasksQuery = useBoardTasks(projectId, board?.id)
  const { data: projects = [] } = useProjects()
  const { data: sources = [] } = useProjectSources(projectId)
  const canAdminister = useCanAdministerProject(projectId)
  const { data: assignableUsers = [] } = useTaskAssignees()
  const { me } = useAuthSession()
  const moveTask = useMoveTask()
  useClearProjectAttention(projectId, 'task_assigned', tasksQuery.isSuccess)

  const isScrum = board?.style === 'scrum'
  const { data: iterations = [] } = useIterations(isScrum ? projectId : undefined)
  const activeIteration = iterations.find((iteration) => iteration.status === 'active')

  const projectNameById = useMemo(
    () => Object.fromEntries(projects.map((project) => [project.id, project.name])),
    [projects],
  )

  const columns: BoardColumnView[] = board?.columns ?? []
  const tasks = useMemo(() => tasksQuery.data?.tasks ?? [], [tasksQuery.data])

  // A view over the board, not part of it: the choice lives in the URL beside
  // `?board=`, so a reload keeps it and a narrowed board is a link somebody can
  // send, while `Board.filter` stays the board's shared definition.
  const [searchParams, setSearchParams] = useSearchParams()
  const assignee = parseAssigneeFilter(searchParams.get('assignee'))
  const currentUserId = me?.user.id ?? null
  const setAssignee = (next: AssigneeFilter) => {
    const params = new URLSearchParams(searchParams)
    if (next === ALL_ASSIGNEES) params.delete('assignee')
    else params.set('assignee', next)
    setSearchParams(params, { replace: true })
  }

  // Options come from the whole pool, so narrowing to one person does not empty
  // the list you would use to pick somebody else.
  const filterOptions = useMemo(
    () => assigneeFilterOptions(tasks, assignableUsers),
    [tasks, assignableUsers],
  )
  const visibleTasks = useMemo(
    () => tasks.filter((task) => matchesAssigneeFilter(task, assignee, currentUserId)),
    [tasks, assignee, currentUserId],
  )

  const handleMove = (taskId: string, columnId: string, position: number) => {
    moveTask.mutate({ id: taskId, columnId, position })
  }

  if (!board) return null

  // A scrum board is a window on the active sprint; without one there is
  // nothing for it to show, and the remedy is planning a sprint.
  if (isScrum && !activeIteration) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <div className="text-sm text-[color:var(--tx2)]">No active sprint.</div>
        <Link
          className="admin-button admin-button-primary"
          to={`/projects/${projectId}/backlog`}
        >
          Plan a sprint
        </Link>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      {isScrum && activeIteration ? (
        <div className="flex items-center gap-2 text-xs text-[color:var(--tx3)]">
          <span className="font-semibold uppercase tracking-[0.16em]">
            {activeIteration.name}
          </span>
          {activeIteration.goal ? <span>· {activeIteration.goal}</span> : null}
          <span>
            · {activeIteration.pointsDone}/{activeIteration.pointsTotal} pts
          </span>
        </div>
      ) : null}
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <SourceStatusStrip
            canAdminister={canAdminister}
            projectId={projectId}
            sources={sources}
          />
        </div>
        <BoardAssigneeFilter
          currentUserId={currentUserId}
          onChange={setAssignee}
          people={filterOptions.people}
          remote={filterOptions.remote}
          value={assignee}
        />
      </div>
      {tasksQuery.data?.truncated ? (
        <div className="text-xs text-[color:var(--tx3)]">
          {/* The cap is on the board read, so it bounds what any filter can
              possibly match — say so before somebody reads an empty column as
              "nobody is working on this". */}
          Showing the 500 most recently updated cards.
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {/* Not QueryState: the recovery here is "Please refresh.", not a Retry
            button, and there is no loading or empty state to share. */}
        {tasksQuery.isError ? (
          <div className="py-10 text-center text-sm text-[color:var(--danger-text)]">
            Failed to load tasks. Please refresh.
          </div>
        ) : tasks.length === 0 && sources.length === 0 ? (
          <EmptyState
            action={
              <Link
                className="admin-button admin-button-primary"
                to={`/projects/${projectId}/settings?section=sources&connect=1`}
              >
                Connect a source
              </Link>
            }
            title="Nothing on this board yet."
          >
            New tasks appear in the first column — or bring in work from Jira, Linear,
            Trello or GitHub.
          </EmptyState>
        ) : visibleTasks.length === 0 && tasks.length > 0 ? (
          // Empty columns under a filter would otherwise read as "nobody is
          // working on anything"; the board is not empty, this view is.
          <EmptyState
            action={
              <button
                className="admin-button"
                onClick={() => setAssignee(ALL_ASSIGNEES)}
                type="button"
              >
                Show all assignees
              </button>
            }
            title="No cards for this assignee."
          >
            This board has {tasks.length} {tasks.length === 1 ? 'card' : 'cards'}, none
            of them assigned to whoever the filter names.
          </EmptyState>
        ) : columns.length === 0 ? (
          <EmptyState
            action={
              <Link
                className="admin-button admin-button-primary"
                to={`/projects/${projectId}/settings?section=boards&board=${board.id}`}
              >
                Add columns
              </Link>
            }
            title="This board has no columns yet."
          >
            Add a column for each stage this board should show.
          </EmptyState>
        ) : (
          <KanbanBoard
            boardId={board.id}
            columns={columns}
            onMoveTask={handleMove}
            projectId={projectId}
            projectNameById={projectNameById}
            showProject={false}
            tasks={visibleTasks}
          />
        )}
      </div>
    </div>
  )
}
