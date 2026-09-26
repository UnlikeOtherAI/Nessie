import { faPlus } from '@fortawesome/free-solid-svg-icons'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import { useCanModifyProject } from '../../facades/projects/administration'
import { useProjects } from '../../facades/projects/hooks'
import { useConsumedIntent } from '../../navigation/intent'
import { prewarmRowHandlers, usePrewarm } from '../../navigation/prewarm'

const boardPath = (projectId: string, board: BoardRecord): string =>
  board.isDefault
    ? `/projects/${projectId}/board`
    : `/projects/${projectId}/board?board=${encodeURIComponent(board.id)}`

/** The project's board directory: a person can see every board and choose its next action. */
export const ProjectBoardsPage = () => {
  const { t } = useTranslation('projects')
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const { data: projects = [] } = useProjects()
  const boardsQuery = useProjectBoards(projectId)
  const canAdminister = useCanModifyProject(projectId ?? '')
  const createIntent = useConsumedIntent('create')
  const prewarm = usePrewarm()
  const [createOpen, setCreateOpen] = useState(false)
  const project = projects.find((item) => item.id === projectId)

  useEffect(() => {
    if (createIntent.value === 'board' && canAdminister) setCreateOpen(true)
  }, [canAdminister, createIntent.serial, createIntent.value])

  // A failed create can be the first signal that the server revoked the role
  // after this page's membership read. Do not leave a now-forbidden dialog
  // open once the shared entitlement query catches up.
  useEffect(() => {
    if (!canAdminister) setCreateOpen(false)
  }, [canAdminister])

  if (!projectId) return null

  const actions: PageHeaderAction[] = canAdminister
    ? [
        {
          icon: faPlus,
          id: 'new-board',
          label: t('boardDirectory.new'),
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
        backLabel={t('boardDirectory.back')}
        onBack={() => void navigate(`/projects/${projectId}/board`)}
        project={project}
        subtitle={project?.name}
        title={t('boardDirectory.title')}
      />
      <PageBody>
        <QueryState
          errorLabel={t('boardDirectory.error')}
          loadingLabel={t('boardDirectory.loading')}
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
                    {t('boardDirectory.new')}
                  </button>
                ) : undefined
              }
              title={t('boardDirectory.empty')}
            >
              {t('boardDirectory.emptyDescription')}
            </EmptyState>
          ) : (
            <DataTable
            columns={[
              {
                header: t('boardDirectory.board'),
                key: 'name',
                render: (board) => (
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-2 font-medium">
                      <BoardIcon iconEmoji={board.iconEmoji} size="md" />
                      <span className="break-words">{board.name}</span>
                    </span>
                    <span className="text-xs text-[color:var(--tx3)]">
                      {board.style === 'scrum' ? t('boardDirectory.iterations') : t('boardDirectory.kanban')} · {board.isDefault ? t('boardDirectory.default') : t('boardDirectory.notDefault')} · {t('boardDirectory.columnCount', { count: board.columns.length })}
                    </span>
                  </span>
                ),
              },
              {
                header: t('boardDirectory.actions'),
                key: 'actions',
                render: (board) => (
                  <span className="inline-flex flex-col items-start gap-0.5">
                    <Link
                      className="admin-link inline-flex min-h-11 items-center"
                      to={boardPath(projectId, board)}
                      {...prewarmRowHandlers(prewarm, boardPath(projectId, board))}
                    >
                      {t('boardDirectory.open')}
                    </Link>
                    <Link
                      className="admin-link inline-flex min-h-11 items-center"
                      to={`/projects/${projectId}/boards/${board.id}/settings`}
                      {...prewarmRowHandlers(
                        prewarm,
                        `/projects/${projectId}/boards/${board.id}/settings`,
                      )}
                    >
                      {t('boardDirectory.settings')}
                    </Link>
                  </span>
                ),
                width: '7rem',
              },
            ]}
            expandable
            label={t('boardDirectory.tableLabel')}
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
