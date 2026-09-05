import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useProjectBoards } from '../../facades/boards/hooks'
import { useCanAdministerProject } from '../../facades/projects/administration'
import { FormError, FormSuccess } from '../../components/shared/FormActions'
import { PageBody } from '../../components/shared/PageBody'
import { QueryState } from '../../components/shared/QueryState'
import { useTabParam } from '../../navigation/useTabParam'
import { BoardsSettingsSection } from './settings/BoardsSettingsSection'
import { FieldsSettingsSection } from './settings/FieldsSettingsSection'
import { TabBar } from '../../components/primitives/TabBar'

const SECTIONS = ['boards', 'fields'] as const

type ProjectSettingsPageProps = {
  projectId: string
}

/**
 * Where a project's shape is configured. A host of sections selected by
 * `?section=`; `?board=` selects which board inside the Boards section.
 *
 * Both are tabs, so both are written with `replace` — Back leaves the project
 * rather than walking the sections somebody passed through.
 */
export const ProjectSettingsPage = ({ projectId }: ProjectSettingsPageProps) => {
  const canAdminister = useCanAdministerProject(projectId)
  const boardsQuery = useProjectBoards(projectId)
  const boards = boardsQuery.data ?? []
  const [section, selectSection] = useTabParam('section', SECTIONS, 'boards')
  const [searchParams, setSearchParams] = useSearchParams()

  const defaultBoardId = boards.find((board) => board.isDefault)?.id ?? boards[0]?.id ?? ''
  const boardIds: string[] = boards.map((board) => board.id)
  const [selectedBoardId, selectBoard] = useTabParam('board', boardIds, defaultBoardId)

  // The board tab's "New board…" doorway arrives with `?new=board`; it is an
  // intent, consumed once, not a piece of durable page state.
  const startWithNewBoard = searchParams.get('new') === 'board'
  useEffect(() => {
    if (!startWithNewBoard) return
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current)
        params.delete('new')
        return params
      },
      { replace: true },
    )
  }, [setSearchParams, startWithNewBoard])

  const [saveState, setSaveState] = useState<{
    status: 'error' | 'idle' | 'success'
    message?: string
  }>({ status: 'idle' })

  // A silent autosave (rename, category, board style) says so — and clears
  // itself, so the banner reads as an acknowledgement rather than a sticky
  // status line.
  useEffect(() => {
    if (saveState.status !== 'success') return
    const id = window.setTimeout(() => setSaveState({ status: 'idle' }), 2500)
    return () => window.clearTimeout(id)
  }, [saveState.status])

  return (
    <PageBody>
      <QueryState
        errorLabel="Couldn't load board settings."
        loadingLabel="Loading board settings…"
        query={boardsQuery}
      >
        {() => (
          <>
            <FormSuccess>{saveState.status === 'success' ? 'Saved.' : undefined}</FormSuccess>
            <FormError>{saveState.status === 'error' ? saveState.message : undefined}</FormError>

            {!canAdminister ? (
              <p className="text-sm text-[color:var(--tx3)]">
                Only project administrators can change board settings.
              </p>
            ) : null}

            <TabBar
              ariaLabel="Project settings sections"
              idPrefix="project-settings"
              items={[
                { label: 'Boards', value: 'boards' },
                { label: 'Fields', value: 'fields' },
              ]}
              onChange={selectSection}
              role="tablist"
              size="sm"
              value={section}
            />

            {section === 'fields' ? (
              <FieldsSettingsSection
                canAdminister={canAdminister}
                onSaveError={(message) => setSaveState({ status: 'error', message })}
                onSaved={() => setSaveState({ status: 'success' })}
                projectId={projectId}
              />
            ) : (
              <BoardsSettingsSection
                boards={boards}
                canAdminister={canAdminister}
                onSaveError={(message) => setSaveState({ status: 'error', message })}
                onSaved={() => setSaveState({ status: 'success' })}
                onSelectBoard={selectBoard}
                projectId={projectId}
                selectedBoardId={selectedBoardId}
                startWithNewBoard={startWithNewBoard}
              />
            )}
          </>
        )}
      </QueryState>
    </PageBody>
  )
}
