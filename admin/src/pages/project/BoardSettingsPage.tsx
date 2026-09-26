import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { BoardIconField } from '../../components/features/projects/kanban/BoardIconField'
import { ProjectPageHeader } from '../../components/features/projects/ProjectPageHeader'
import { TabBar } from '../../components/primitives/TabBar'
import { ConfirmDialog } from '../../components/shared/ConfirmDialog'
import { FormError, FormSuccess } from '../../components/shared/FormActions'
import { FormField } from '../../components/shared/FormField'
import { Input, Select } from '../../components/shared/FormControls'
import { PageBody, Section } from '../../components/shared/PageBody'
import { QueryState } from '../../components/shared/QueryState'
import { useProjectSources } from '../../facades/board-sources/hooks'
import {
  useDeleteBoard,
  useProjectBoards,
  useUpdateBoard,
  type BoardRecord,
  type BoardStyle,
} from '../../facades/boards/hooks'
import { formErrorMessage } from '../../facades/forms/form-errors'
import { useCanModifyProject } from '../../facades/projects/administration'
import { useProjects } from '../../facades/projects/hooks'
import { useTabParam } from '../../navigation/useTabParam'
import { BoardColumnsEditor, type BindableState } from './settings/BoardColumnsEditor'
import { BoardWatchersEditor } from './settings/BoardWatchersEditor'
import { LabelsSettingsSection } from './settings/LabelsSettingsSection'

const TABS = ['general', 'columns', 'watchers', 'labels'] as const

type SaveState = { message?: string; status: 'error' | 'idle' | 'success' }

const BoardGeneralSettings = ({
  board,
  boards,
  onSaveError,
  onSaved,
  projectId,
}: {
  board: BoardRecord
  boards: BoardRecord[]
  onSaveError: (message: string) => void
  onSaved: () => void
  projectId: string
}) => {
  const { t } = useTranslation('projects')
  const navigate = useNavigate()
  const updateBoard = useUpdateBoard(projectId)
  const deleteBoard = useDeleteBoard(projectId)
  const [name, setName] = useState(board.name)
  const [nameError, setNameError] = useState<string | undefined>()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const replacement = boards.find((item) => item.id !== board.id)

  useEffect(() => {
    setName(board.name)
    setNameError(undefined)
  }, [board.id, board.name])

  const update = (input: Omit<Parameters<typeof updateBoard.mutate>[0], 'id'>) => {
    updateBoard.mutate(
      { id: board.id, ...input },
      {
        onError: (cause) => onSaveError(formErrorMessage(cause, t('boardSettings.saveError'))),
        onSuccess: onSaved,
      },
    )
  }

  const saveName = () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setName(board.name)
      setNameError(t('boardSettings.nameRequired'))
      return
    }
    setNameError(undefined)
    if (trimmed === board.name) return
    update({ name: trimmed })
  }

  const remove = () => {
    deleteBoard.mutate(
      {
        id: board.id,
        ...(board.isDefault && replacement ? { newDefaultBoardId: replacement.id } : {}),
      },
      {
        onError: (cause) => onSaveError(formErrorMessage(cause, t('boardSettings.deleteError'))),
        onSuccess: () => void navigate(`/projects/${projectId}/boards`),
      },
    )
  }

  return (
    <>
      <Section description={t('boardSettings.generalDescription')} title={t('boardSettings.general')}>
        <div className="grid gap-4">
          <FormField error={nameError} label={t('boardSettings.boardName')} required>
            <Input
              className="max-w-lg"
              disabled={updateBoard.isPending}
              onBlur={saveName}
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </FormField>
          <FormField label={t('boardSettings.icon')}>
            <BoardIconField
              boardName={board.name}
              disabled={updateBoard.isPending}
              iconEmoji={board.iconEmoji}
              onChange={(iconEmoji) => update({ iconEmoji })}
            />
          </FormField>
          <FormField label={t('boards.create.style')}>
            <Select
              className="max-w-xs"
              disabled={updateBoard.isPending}
              onChange={(event) => update({ style: event.target.value as BoardStyle })}
              value={board.style}
            >
              <option value="kanban">Kanban</option>
              <option value="scrum">{t('boards.style.scrum')}</option>
            </Select>
          </FormField>
          {board.isDefault ? (
            <p className="text-sm text-[color:var(--tx2)]">{t('boardSettings.isDefault')}</p>
          ) : (
            <div>
              <button
                className="admin-button"
                disabled={updateBoard.isPending}
                onClick={() => update({ isDefault: true })}
                type="button"
              >
                {t('boardSettings.makeDefault')}
              </button>
            </div>
          )}
        </div>
      </Section>
      <Section description={t('boardSettings.deleteDescription')} title={t('boardSettings.deleteBoard')}>
        <button
          className="admin-button admin-button-danger"
          disabled={boards.length <= 1 || deleteBoard.isPending}
          onClick={() => setDeleteOpen(true)}
          type="button"
        >
          {t('boardSettings.deleteBoard')}
        </button>
        {boards.length <= 1 ? <p className="mt-2 text-sm text-[color:var(--tx3)]">{t('boardSettings.minimumBoard')}</p> : null}
      </Section>
      <ConfirmDialog
        body={t('boardSettings.deleteConfirmBody')}
        confirmLabel={t('boardSettings.deleteBoard')}
        destructive
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => {
          setDeleteOpen(false)
          remove()
        }}
        open={deleteOpen}
        title={t('boardSettings.deleteConfirmTitle', { name: board.name })}
      />
    </>
  )
}

/** Settings for one board: each concern has one URL-backed tab instead of one long editor. */
export const BoardSettingsPage = () => {
  const { t } = useTranslation('projects')
  const { boardId, projectId } = useParams<{ boardId: string; projectId: string }>()
  const navigate = useNavigate()
  const { data: projects = [] } = useProjects()
  const boardsQuery = useProjectBoards(projectId)
  const canAdminister = useCanModifyProject(projectId ?? '')
  const [tab, selectTab] = useTabParam('tab', TABS, 'general')
  const sourcesQuery = useProjectSources(
    canAdminister && tab === 'columns' ? projectId : undefined,
  )
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' })
  const boards = boardsQuery.data ?? []
  const board = boards.find((item) => item.id === boardId) ?? null
  const project = projects.find((item) => item.id === projectId)
  const openBoardHref = board && projectId
    ? board.isDefault
      ? `/projects/${projectId}/board`
      : `/projects/${projectId}/board?board=${encodeURIComponent(board.id)}`
    : undefined

  useEffect(() => {
    if (saveState.status !== 'success') return
    const timer = window.setTimeout(() => setSaveState({ status: 'idle' }), 2500)
    return () => window.clearTimeout(timer)
  }, [saveState.status])

  const bindableStates = useMemo<BindableState[]>(
    () => (sourcesQuery.data ?? []).flatMap((source) => source.stateMapping.flatMap((entry) =>
      entry.category && entry.category !== 'archived'
        ? [{
            category: entry.category,
            externalStateId: entry.externalStateId,
            externalStateName: entry.externalStateName,
            sourceId: source.id,
            sourceName: source.name,
          }]
        : [],
    )),
    [sourcesQuery.data],
  )

  if (!projectId) return null

  return (
    <section className="flex h-full min-h-0 flex-col">
      <ProjectPageHeader
        actions={openBoardHref ? [{
          href: openBoardHref,
          id: 'open-board',
          kind: 'link',
          label: 'Open board',
          primary: true,
          priority: 100,
        }] : []}
        backLabel="Back to boards"
        onBack={() => void navigate(`/projects/${projectId}/boards`)}
        project={project}
        subtitle={project?.name}
        tabs={board ? (
          <TabBar
            ariaLabel="Board settings"
            idPrefix="board-settings"
            items={[
              { label: t('boardSettings.general'), value: 'general' },
              { label: t('boardSettings.columns'), value: 'columns' },
              { label: t('boardSettings.watchers'), value: 'watchers' },
              { label: t('taskLabels.title'), value: 'labels' },
            ]}
            onChange={selectTab}
            role="tablist"
            size="sm"
            touchTarget
            value={tab}
          />
        ) : undefined}
        title={board?.name ?? t('boardSettings.title')}
      />
      <PageBody>
        <QueryState
          errorLabel={t('boardSettings.loadError')}
          loadingLabel={t('boardSettings.loading')}
          query={boardsQuery}
        >
          {() => !board ? (
            <p className="text-sm text-[color:var(--tx3)]">{t('boardSettings.missing')}</p>
          ) : (
          <>
            <FormSuccess>{saveState.status === 'success' ? t('boardSettings.saved') : undefined}</FormSuccess>
            <FormError>{saveState.status === 'error' ? saveState.message : undefined}</FormError>
            {!canAdminister ? <p className="text-sm text-[color:var(--tx3)]">{t('boardSettings.permission')}</p> : null}
            {canAdminister && tab === 'general' ? (
              <BoardGeneralSettings
                board={board}
                boards={boards}
                onSaveError={(message) => setSaveState({ message, status: 'error' })}
                onSaved={() => setSaveState({ status: 'success' })}
                projectId={projectId}
              />
            ) : null}
            {canAdminister && tab === 'columns' ? (
              <QueryState
                errorLabel={t('boardSettings.sourcesError')}
                loadingLabel={t('boardSettings.sourcesLoading')}
                query={sourcesQuery}
              >
                {() => (
                  <Section
                    description={t('boardSettings.columnsDescription')}
                    title={t('boardSettings.columns')}
                  >
                    <BoardColumnsEditor
                      bindableStates={bindableStates}
                      boardId={board.id}
                      columns={board.columns}
                      onSaveError={(message) => setSaveState({ message, status: 'error' })}
                      onSaved={() => setSaveState({ status: 'success' })}
                      projectId={projectId}
                    />
                  </Section>
                )}
              </QueryState>
            ) : null}
            {canAdminister && tab === 'watchers' ? (
              <BoardWatchersEditor
                boardId={board.id}
                boardName={board.name}
                projectId={projectId}
              />
            ) : null}
            {/* Every member reads the board's labels; the section itself
                withholds the controls from somebody who may not change them. */}
            {tab === 'labels' ? (
              <LabelsSettingsSection
                boardId={board.id}
                canAdminister={canAdminister}
                onSaveError={(message) => setSaveState({ message, status: 'error' })}
                onSaved={() => setSaveState({ status: 'success' })}
                projectId={projectId}
              />
            ) : null}
            {!canAdminister && tab === 'general' ? (
              <Section
                description={t('boardSettings.readOnlyGeneralDescription')}
                title={t('boardSettings.general')}
              >
                <dl className="grid gap-3 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-[color:var(--tx3)]">{t('common.name')}</dt>
                    <dd>{board.name}</dd>
                  </div>
                  <div>
                    <dt className="text-[color:var(--tx3)]">{t('common.style')}</dt>
                    <dd>{board.style === 'scrum' ? t('boardDirectory.iterations') : 'Kanban'}</dd>
                  </div>
                  <div>
                    <dt className="text-[color:var(--tx3)]">{t('boardDirectory.default')}</dt>
                    <dd>{board.isDefault ? t('common.yes') : t('common.no')}</dd>
                  </div>
                </dl>
              </Section>
            ) : null}
            {!canAdminister && tab === 'columns' ? (
              <Section description={t('boardSettings.columnsMemberDescription')} title={t('boardSettings.columns')}>
                <ul className="grid gap-1 text-sm text-[color:var(--tx2)]">
                  {[...board.columns]
                    .sort((left, right) => left.position - right.position)
                    .map((column) => <li key={column.id}>{column.name}</li>)}
                </ul>
              </Section>
            ) : null}
            {!canAdminister && tab === 'watchers' ? (
              <Section
                description={t('boardSettings.watchersPermission')}
                title={t('boardSettings.watchers')}
              >
                <p className="text-sm text-[color:var(--tx3)]">{t('boardSettings.noWatchers')}</p>
              </Section>
            ) : null}
          </>
          )}
        </QueryState>
      </PageBody>
    </section>
  )
}
