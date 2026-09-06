import { useEffect, useState } from 'react'
import { useProjectBoards } from '../../facades/boards/hooks'
import { useCanAdministerProject } from '../../facades/projects/administration'
import { FormError, FormSuccess } from '../../components/shared/FormActions'
import { PageBody } from '../../components/shared/PageBody'
import { QueryState } from '../../components/shared/QueryState'
import { useConsumedIntents } from '../../navigation/intent'
import { useTabParam } from '../../navigation/useTabParam'
import { BoardsSettingsSection } from './settings/BoardsSettingsSection'
import { FieldsSettingsSection } from './settings/FieldsSettingsSection'
import { SourcesSettingsSection } from './settings/SourcesSettingsSection'
import { TabBar } from '../../components/primitives/TabBar'

const SECTIONS = ['boards', 'fields', 'sources'] as const

/** Declared on the project surface row in `navigation/surfaces.ts`. */
const PROJECT_SETTINGS_INTENTS = ['create', 'connect'] as const

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

  const defaultBoardId = boards.find((board) => board.isDefault)?.id ?? boards[0]?.id ?? ''
  const boardIds: string[] = boards.map((board) => board.id)
  const [selectedBoardId, selectBoard] = useTabParam('board', boardIds, defaultBoardId)

  // Which source the Sources section has open. A selection inside a section,
  // so it is a param of its own rather than a second meaning for `section`.
  const [selectedSourceId, selectSource] = useTabParam('source', [] as string[], '')

  // Doorways arrive with an intent: `?create=board` from the board header,
  // `?connect=…` from the App Store. Both go through the one intent hook, which
  // captures the value and strips it from the URL — an intent says what to open
  // on arrival, not what the page durably is.
  const intents = useConsumedIntents(PROJECT_SETTINGS_INTENTS)
  const startWithNewBoard = intents.values.create === 'board'
  const startWithConnect = Boolean(intents.values.connect)

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
                { label: 'Sources', value: 'sources' },
              ]}
              onChange={selectSection}
              role="tablist"
              size="sm"
              value={section}
            />

            {section === 'sources' ? (
              <SourcesSettingsSection
                canAdminister={canAdminister}
                onSaveError={(message) => setSaveState({ status: 'error', message })}
                onSaved={() => setSaveState({ status: 'success' })}
                onSelectSource={selectSource}
                projectId={projectId}
                selectedSourceId={selectedSourceId}
                startWithConnect={startWithConnect}
              />
            ) : section === 'fields' ? (
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
