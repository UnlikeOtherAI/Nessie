import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { BoardCreateDialog } from '../../../components/features/projects/kanban/BoardCreateDialog'
import { BoardIcon } from '../../../components/features/projects/kanban/BoardIcon'
import { DataTable } from '../../../components/shared/DataTable'
import { EmptyState } from '../../../components/shared/EmptyState'
import { Section } from '../../../components/shared/PageBody'
import { QueryState } from '../../../components/shared/QueryState'
import { useProjectBoards, type BoardRecord } from '../../../facades/boards/hooks'
import { useConsumedIntent } from '../../../navigation/intent'
import { prewarmRowHandlers, usePrewarm } from '../../../navigation/prewarm'

const boardPath = (projectId: string, board: BoardRecord): string =>
  board.isDefault
    ? `/projects/${projectId}/board`
    : `/projects/${projectId}/board?board=${encodeURIComponent(board.id)}`

const boardSettingsPath = (projectId: string, boardId: string): string =>
  `/projects/${projectId}/boards/${boardId}/settings`

const styleLabel = (board: BoardRecord): string =>
  board.style === 'scrum' ? 'Iterations' : 'Kanban'

type ProjectBoardsSectionProps = {
  canModify: boolean
  projectId: string
}

/**
 * Settings › Boards: every board of the project, each with the way to open it
 * and to its own settings page (General, Columns, Watchers, Labels — unchanged
 * and still at `/projects/:id/boards/:boardId/settings`). This is the board
 * directory that used to be a route of its own; it lives beside the project's
 * other configuration now, and the board's Configure menu lands here.
 *
 * `?create=board` is the one-shot instruction those doorways carry: it opens
 * the create dialog and leaves the address (`useConsumedIntent`).
 */
export const ProjectBoardsSection = ({ canModify, projectId }: ProjectBoardsSectionProps) => {
  const navigate = useNavigate()
  const prewarm = usePrewarm()
  const boardsQuery = useProjectBoards(projectId)
  const createIntent = useConsumedIntent('create')
  const [createOpen, setCreateOpen] = useState(false)
  const boards = boardsQuery.data ?? []

  useEffect(() => {
    if (createIntent.value === 'board' && canModify) setCreateOpen(true)
  }, [canModify, createIntent.serial, createIntent.value])

  // A failed create can be the first sign the server revoked the role after
  // this page's membership read: never leave a now-forbidden dialog open.
  useEffect(() => {
    if (!canModify) setCreateOpen(false)
  }, [canModify])

  const newBoard = (
    <button
      className="admin-button admin-button-primary"
      disabled={!canModify}
      onClick={() => setCreateOpen(true)}
      type="button"
    >
      New board
    </button>
  )

  return (
    <Section
      actions={boards.length > 0 ? newBoard : undefined}
      description="Each board is its own way of looking at the project's work, with its own columns and watchers."
      title="Boards"
    >
      <QueryState errorLabel="Couldn't load boards." loadingLabel="Loading boards…" query={boardsQuery}>
        {() => boards.length === 0 ? (
          <EmptyState action={newBoard} title="No boards yet.">
            Create a board to organise this project&apos;s tickets.
          </EmptyState>
        ) : (
          <DataTable
            columns={[
              {
                header: 'Board',
                key: 'name',
                render: (board) => (
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-2 font-medium">
                      <BoardIcon iconEmoji={board.iconEmoji} size="md" />
                      <span className="break-words">{board.name}</span>
                    </span>
                    <span className="text-xs text-[color:var(--tx3)]">
                      {styleLabel(board)} · {board.isDefault ? 'Default' : 'Not default'} · {board.columns.length} columns
                    </span>
                  </span>
                ),
              },
              {
                header: 'Actions',
                key: 'actions',
                render: (board) => (
                  <span className="inline-flex flex-col items-start gap-0.5">
                    <Link
                      className="admin-link inline-flex min-h-11 items-center"
                      to={boardPath(projectId, board)}
                      {...prewarmRowHandlers(prewarm, boardPath(projectId, board))}
                    >
                      Open board
                    </Link>
                    <Link
                      className="admin-link inline-flex min-h-11 items-center"
                      to={boardSettingsPath(projectId, board.id)}
                      {...prewarmRowHandlers(prewarm, boardSettingsPath(projectId, board.id))}
                    >
                      Settings
                    </Link>
                  </span>
                ),
                width: '7rem',
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
      <BoardCreateDialog
        boards={boards}
        onClose={() => setCreateOpen(false)}
        onCreated={(board) => void navigate(boardSettingsPath(projectId, board.id))}
        open={createOpen}
        projectId={projectId}
      />
    </Section>
  )
}
