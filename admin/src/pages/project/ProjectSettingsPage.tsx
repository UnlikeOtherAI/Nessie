import { useEffect, useState } from 'react'
import { TabBar } from '../../components/primitives/TabBar'
import { FormError, FormSuccess } from '../../components/shared/FormActions'
import { PageBody } from '../../components/shared/PageBody'
import { QueryState } from '../../components/shared/QueryState'
import { useCanModifyProject } from '../../facades/projects/administration'
import { useProjects } from '../../facades/projects/hooks'
import { useConsumedIntents } from '../../navigation/intent'
import {
  PROJECT_SETTINGS_SECTIONS,
  type ProjectSettingsSectionId,
} from '../../navigation/project-sections'
import { useTabParam } from '../../navigation/useTabParam'
import { FieldsSettingsSection } from './settings/FieldsSettingsSection'
import { ProjectBoardsSection } from './settings/ProjectBoardsSection'
import { ProjectComputersSection } from './settings/ProjectComputersSection'
import { ProjectGeneralSection } from './settings/ProjectGeneralSection'
import { ProjectPeopleSection } from './settings/ProjectPeopleSection'
import { SourcesSettingsSection } from './settings/SourcesSettingsSection'

const SECTION_LABELS: Record<ProjectSettingsSectionId, string> = {
  boards: 'Boards',
  computers: 'Computers',
  fields: 'Fields',
  general: 'General',
  people: 'People',
  sources: 'Connected tools',
}

/** Declared on the project surface row in `navigation/surfaces.ts`. */
const PROJECT_SETTINGS_INTENTS = ['connect'] as const

type ProjectSettingsPageProps = {
  projectId: string
}

/**
 * A project's one Settings page (plan §6.5). Everything that configures the
 * project is a section of it, chosen by `?section=` through `useTabParam` — a
 * tab, so it is linkable and written with `replace`, and Back leaves the
 * project rather than walking the sections somebody passed through:
 *
 *   General (name, description, picture, visibility, and Delete) · People ·
 *   Boards (the list; each board's own settings page is unchanged) · Fields ·
 *   Connected tools (`sources`, the value the app page's hand-off already
 *   carries) · Computers.
 *
 * Labels are not here: a label belongs to a board, so they are managed on
 * Board → Settings → Labels.
 */
export const ProjectSettingsPage = ({ projectId }: ProjectSettingsPageProps) => {
  // `source` belongs to Connected tools: switching away drops it in the same
  // replace, so a later visit opens on the first tool rather than a stale one.
  const [section, selectSection] = useTabParam('section', PROJECT_SETTINGS_SECTIONS, 'general', {
    clears: ['source'],
  })
  const canModify = useCanModifyProject(projectId)
  const projectsQuery = useProjects()
  const project = projectsQuery.data?.find((candidate) => candidate.id === projectId)
  const intents = useConsumedIntents(PROJECT_SETTINGS_INTENTS)
  const startWithConnect = Boolean(intents.values.connect)

  // Fields and Connected tools save as they change; this line acknowledges
  // each save and clears itself, so it never reads as a standing status.
  const [saveState, setSaveState] = useState<{
    status: 'error' | 'idle' | 'success'
    message?: string
  }>({ status: 'idle' })
  useEffect(() => {
    if (saveState.status !== 'success') return
    const id = window.setTimeout(() => setSaveState({ status: 'idle' }), 2500)
    return () => window.clearTimeout(id)
  }, [saveState.status])
  const onSaved = () => setSaveState({ status: 'success' })
  const onSaveError = (message: string) => setSaveState({ status: 'error', message })

  return (
    <PageBody>
      <TabBar
        ariaLabel="Project settings sections"
        idPrefix="project-settings"
        items={PROJECT_SETTINGS_SECTIONS.map((value) => ({ label: SECTION_LABELS[value], value }))}
        onChange={selectSection}
        role="tablist"
        size="sm"
        value={section}
      />

      {!canModify ? (
        <p className="text-sm text-[color:var(--tx3)]">
          Only members of this project, or an organisation owner or admin, can change its settings.
        </p>
      ) : null}
      <FormSuccess>{saveState.status === 'success' ? 'Saved.' : undefined}</FormSuccess>
      <FormError>{saveState.status === 'error' ? saveState.message : undefined}</FormError>

      <div
        aria-labelledby={`project-settings-tab-${section}`}
        className="grid gap-6"
        id={`project-settings-tabpanel-${section}`}
        role="tabpanel"
      >
        {section === 'fields' ? (
          <FieldsSettingsSection
            canAdminister={canModify}
            onSaveError={onSaveError}
            onSaved={onSaved}
            projectId={projectId}
          />
        ) : section === 'sources' ? (
          <SourcesSettingsSection
            canAdminister={canModify}
            onSaveError={onSaveError}
            onSaved={onSaved}
            projectId={projectId}
            startWithConnect={startWithConnect}
          />
        ) : section === 'boards' ? (
          <ProjectBoardsSection canModify={canModify} projectId={projectId} />
        ) : section === 'computers' ? (
          <ProjectComputersSection projectId={projectId} />
        ) : (
          <QueryState
            errorLabel="Couldn't load this project."
            isEmpty={!project}
            emptyLabel="This project is no longer available to you."
            loadingLabel="Loading the project…"
            query={projectsQuery}
          >
            {() => project ? (
              section === 'people'
                ? <ProjectPeopleSection canModify={canModify} project={project} />
                // Keyed by the project: a different project is a fresh form,
                // never the previous project's unsaved edits.
                : <ProjectGeneralSection canModify={canModify} key={project.id} project={project} />
            ) : null}
          </QueryState>
        )}
      </div>
    </PageBody>
  )
}
