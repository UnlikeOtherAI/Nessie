import { faPlus } from '@fortawesome/free-solid-svg-icons'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { BoardCreateDialog } from '../../components/features/projects/kanban/BoardCreateDialog'
import { BoardIcon } from '../../components/features/projects/kanban/BoardIcon'
import { ProjectPageHeader } from '../../components/features/projects/ProjectPageHeader'
import { DataTable } from '../../components/shared/DataTable'
import { EmptyState } from '../../components/shared/EmptyState'
import { PageBody } from '../../components/shared/PageBody'
import { QueryState } from '../../components/shared/QueryState'
import type { PageHeaderAction } from '../../components/shared/ResponsivePageHeader'
import { useProjectBoards, type BoardRecord } from '../../facades/boards/hooks'
import { useCanAdministerProject } from '../../facades/projects/administration'
import { useProjects } from '../../facades/projects/hooks'
import { useConsumedIntent } from '../../navigation/intent'
import { prewarmRowHandlers, usePrewarm } from '../../navigation/prewarm'

const boardPath = (projectId: string, board: BoardRecord): string =>
  board.isDefault
    ? `/projects/${projectId}/board`
    : `/projects/${projectId}/board?board=${encodeURIComponent(board.id)}`

const styleLabel = (board: BoardRecord): string =>
  board.style === 'scrum' ? 'Iterations' : 'Kanban'

/** The project's board directory: a person can see every board and choose its next action. */
export const ProjectBoardsPage = () => {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const { data: projects = [] } = useProjects()
  const boardsQuery = useProjectBoards(projectId)
  const canAdminister = useCanAdministerProject(projectId ?? '')
  const createIntent = useConsumedIntent('create')
  const prewarm = usePrewarm()
  const [createOpen, setCreateOpen] = useState(false)
  const project = projects.find((item) => item.id === projectId)

  useEffect(() => {
    if (createIntent.value === 'board' && canAdminister) setCreateOpen(true)
  }, [canAdminister, createIntent.serial, createIntent.value])

  if (!projectId) return null

  const actions: PageHeaderAction[] = canAdminister
    ? [
        {
          icon: faPlus,
          id: 'new-board',
          label: 'New board',
          onSelect: () => setCreateOpen(true),
          primary: true,
          priority: 100,
        },
      ]
    : []
  const boards = boardsQuery.data ?? []

  return (
    <section className="flex h-full min-h-0 flex-col">
      <ProjectPageHeader
        actions={actions}
        backLabel="Back to board"
        onBack={() => void navigate(`/projects/${projectId}/board`)}
        project={project}
        subtitle={project?.name}
        title="Boards"
      />
      <PageBody>
        <QueryState
          errorLabel="Couldn't load boards."
          loadingLabel="Loading boards…"
          query={boardsQuery}
        >
          {() => boards.length === 0 ? (
            <EmptyState
              action={
                canAdminister ? (
                  <button
                    className="admin-button admin-button-primary"
                    onClick={() => setCreateOpen(true)}
                    type="button"
                  >
                    New board
                  </button>
                ) : undefined
              }
              title="No boards yet."
            >
              Create a board to organise this project's tickets.
            </EmptyState>
          ) : (
            <DataTable
            columns={[
              {
                header: 'Board',
                key: 'name',
                render: (board) => (
                  <span className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-2">
                    <span className="flex min-w-0 items-center gap-2 font-medium">
                      <BoardIcon iconEmoji={board.iconEmoji} size="md" />
                      <span className="break-words">{board.name}</span>
                    </span>
                    <span className="text-xs text-[color:var(--tx3)] sm:hidden">
                      {styleLabel(board)} · {board.isDefault ? 'Default' : 'Not default'} · {board.columns.length} columns
                    </span>
                  </span>
                ),
              },
              { header: 'Type', key: 'style', render: styleLabel, secondary: true },
              {
                header: 'Default',
                key: 'default',
                render: (board) => (board.isDefault ? 'Default' : '—'),
                secondary: true,
              },
              {
                align: 'right',
                header: 'Columns',
                key: 'columns',
                render: (board) => `${board.columns.length} columns`,
                secondary: true,
              },
              {
                align: 'right',
                header: 'Actions',
                key: 'actions',
                render: (board) => (
                  <span className="inline-flex flex-col items-end gap-0 sm:flex-row sm:items-center sm:gap-3">
                    <Link
                      className="admin-link inline-flex min-h-11 items-center"
                      to={boardPath(projectId, board)}
                      {...prewarmRowHandlers(prewarm, boardPath(projectId, board))}
                    >
                      Open board
                    </Link>
                    <Link
                      className="admin-link inline-flex min-h-11 items-center"
                      to={`/projects/${projectId}/boards/${board.id}/settings`}
                      {...prewarmRowHandlers(
                        prewarm,
                        `/projects/${projectId}/boards/${board.id}/settings`,
                      )}
                    >
                      Settings
                    </Link>
                  </span>
                ),
                width: '5.5rem',
              },
            ]}
            expandable
            label="Project boards"
            layout="fixed"
            rowKey={(board) => board.id}
            rows={boards}
            />
          )}
        </QueryState>
      </PageBody>
      <BoardCreateDialog
        boards={boards}
        onClose={() => setCreateOpen(false)}
        onCreated={(board) => void navigate(`/projects/${projectId}/boards/${board.id}/settings`)}
        open={createOpen}
        projectId={projectId}
      />
    </section>
  )
}
