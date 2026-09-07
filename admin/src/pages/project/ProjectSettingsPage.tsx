import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useCanAdministerProject } from '../../facades/projects/administration'
import { FormError, FormSuccess } from '../../components/shared/FormActions'
import { PageBody } from '../../components/shared/PageBody'
import { useConsumedIntents } from '../../navigation/intent'
import { useTabParam } from '../../navigation/useTabParam'
import { FieldsSettingsSection } from './settings/FieldsSettingsSection'
import { SourcesSettingsSection } from './settings/SourcesSettingsSection'
import { TabBar } from '../../components/primitives/TabBar'
import { LegacyProjectBoardSettingsRedirect } from '../../navigation/LegacyProjectBoardSettingsRedirect'

const SECTIONS = ['fields', 'sources'] as const

/** Declared on the project surface row in `navigation/surfaces.ts`. */
const PROJECT_SETTINGS_INTENTS = ['connect'] as const

type ProjectSettingsPageProps = {
  projectId: string
}

/**
 * Where a project's shape is configured. A host of sections selected by
 * `?section=`. Board configuration moved to its own list and detail routes;
 * this host retains old links long enough to move them there with a replace.
 *
 * Both are tabs, so both are written with `replace` — Back leaves the project
 * rather than walking the sections somebody passed through.
 */
export const ProjectSettingsPage = ({ projectId }: ProjectSettingsPageProps) => {
  const [section, selectSection] = useTabParam('section', SECTIONS, 'fields')
  const [searchParams] = useSearchParams()
  if (searchParams.get('section') === 'boards') {
    return <LegacyProjectBoardSettingsRedirect projectId={projectId} />
  }

  return <ProjectSettingsContent projectId={projectId} section={section} selectSection={selectSection} />
}

const ProjectSettingsContent = ({
  projectId,
  section,
  selectSection,
}: {
  projectId: string
  section: (typeof SECTIONS)[number]
  selectSection: (section: (typeof SECTIONS)[number]) => void
}) => {
  const canAdminister = useCanAdministerProject(projectId)
  const [selectedSourceId, selectSource] = useTabParam('source', [] as string[], '')
  const intents = useConsumedIntents(PROJECT_SETTINGS_INTENTS)
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
      <>
        <FormSuccess>{saveState.status === 'success' ? 'Saved.' : undefined}</FormSuccess>
        <FormError>{saveState.status === 'error' ? saveState.message : undefined}</FormError>

        {!canAdminister ? (
          <p className="text-sm text-[color:var(--tx3)]">
            Only project administrators can change project settings.
          </p>
        ) : null}

        <TabBar
          ariaLabel="Project settings sections"
          idPrefix="project-settings"
          items={[
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
        ) : (
          <FieldsSettingsSection
            canAdminister={canAdminister}
            onSaveError={(message) => setSaveState({ status: 'error', message })}
            onSaved={() => setSaveState({ status: 'success' })}
            projectId={projectId}
          />
        )}
      </>
    </PageBody>
  )
}
