import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  PROVIDER_LABEL,
  isSourceSyncing,
  useDeleteProjectSource,
  useProjectSources,
  useSourceAction,
  type BoardSourceRecord,
} from '../../../facades/board-sources/hooks'
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog'
import { EmptyState } from '../../../components/shared/EmptyState'
import { Section } from '../../../components/shared/PageBody'
import { Pill } from '../../../components/primitives/Pill'
import { formErrorMessage } from '../../../facades/forms/form-errors'
import { ConnectSourceDialog } from './ConnectSourceDialog'
import { SourceMappingPanel } from './SourceMappingPanel'

/**
 * Each health state names the one thing that fixes it — the standard is
 * docs/standards/capability-health-alerts.md. `active` has no remedy because
 * nothing is wrong, and `paused` is somebody's own decision rather than a fault.
 */
const REMEDY: Record<
  BoardSourceRecord['healthState'],
  { action: 'sync' | 'pause' | 'resume' | 'retry' | 'reconnect' | null; key: string }
> = {
  active: { action: 'pause', key: 'pause' },
  paused: { action: 'resume', key: 'resume' },
  needs_reauthorization: { action: 'reconnect', key: 'reconnect' },
  owner_inactive: { action: 'reconnect', key: 'connectAsMe' },
  misconfigured: { action: null, key: 'editMapping' },
  error: { action: 'retry', key: 'retryNow' },
}

const HEALTH_TONE: Record<
  BoardSourceRecord['healthState'],
  'danger' | 'muted' | 'success' | 'warning'
> = {
  active: 'success',
  paused: 'muted',
  needs_reauthorization: 'danger',
  owner_inactive: 'danger',
  misconfigured: 'warning',
  error: 'danger',
}

type SourcesSettingsSectionProps = {
  canAdminister: boolean
  onSaveError: (message: string) => void
  onSaved: () => void
  onSelectSource: (sourceId: string) => void
  projectId: string
  selectedSourceId: string
  startWithConnect: boolean
}

export const SourcesSettingsSection = ({
  canAdminister,
  onSaveError,
  onSaved,
  onSelectSource,
  projectId,
  selectedSourceId,
  startWithConnect,
}: SourcesSettingsSectionProps) => {
  const { t } = useTranslation('projects')
  const { data: sources = [] } = useProjectSources(projectId)
  const action = useSourceAction(projectId)
  const removeSource = useDeleteProjectSource(projectId)
  const [connectOpen, setConnectOpen] = useState(startWithConnect)
  const [removeTarget, setRemoveTarget] = useState<BoardSourceRecord | null>(null)

  const selected = sources.find((source) => source.id === selectedSourceId) ?? sources[0] ?? null

  return (
    <>
      <Section
        description={t('sourceSettings.description')}
        title={t('projectSettings.sources')}
      >
        {sources.length === 0 ? (
          <EmptyState title={t('sourceSettings.noneTitle')}>
            {t('sourceSettings.noneBody')}
          </EmptyState>
        ) : (
          <div className="grid gap-1">
            {sources.map((source) => {
              const remedy = REMEDY[source.healthState]
              return (
                <div
                  className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5
                    data-[selected=true]:bg-[color:var(--overlay)]"
                  data-selected={source.id === selected?.id}
                  key={source.id}
                >
                  <button
                    className="min-h-11 min-w-[10rem] flex-1 px-2 text-left text-sm text-[color:var(--tx)]"
                    onClick={() => onSelectSource(source.id)}
                    type="button"
                  >
                    {PROVIDER_LABEL[source.provider]} · {source.name}
                  </button>
                  <Pill size="sm" tone={HEALTH_TONE[source.healthState]} uppercase={false}>
                    {t(`sourceSettings.health.${source.healthState}`)}
                  </Pill>
                  <span className="text-xs text-[color:var(--tx3)]">
                    {t('sourceSettings.itemsByOwner', { count: source.itemCount, owner: source.connectionOwnerDisplayName ?? t('sourceSettings.unknown') })}
                  </span>
                  {/* Whether the provider pushes changes here or the board waits
                      for a poll. `misconfigured` for WEBHOOK_REGISTRATION_FAILED
                      is a fault; falling back to the poll is not, so this is a
                      statement of fact rather than a remedy. */}
                  <Pill size="sm" tone={source.webhookActive ? 'info' : 'muted'} uppercase={false}>
                    {source.webhookActive
                      ? t('sourceSettings.liveUpdates')
                      : source.pollingIntervalMinutes === null
                        ? t('sourceSettings.manualSync')
                        : t('sourceSettings.checksEvery', { count: source.pollingIntervalMinutes })}
                  </Pill>
                  {source.writeMode === 'read_write' ? (
                    <Pill size="sm" tone="info" uppercase={false}>
                      {t('sourceSettings.readWrite')}
                    </Pill>
                  ) : null}
                  {canAdminister && remedy.action && remedy.action !== 'reconnect' ? (
                    <button
                      className="inline-flex min-h-11 items-center px-2 text-xs text-[color:var(--tx3)] hover:text-[color:var(--tx)]"
                      onClick={() =>
                        action.mutate(
                          { id: source.id, action: remedy.action as 'sync' | 'pause' | 'resume' | 'retry' },
                          {
                            onError: (cause) =>
                              onSaveError(formErrorMessage(cause, t('sourceSettings.changeError'))),
                            onSuccess: onSaved,
                          },
                        )
                      }
                      type="button"
                    >
                      {t(`sourceSettings.remedy.${remedy.key}`)}
                    </button>
                  ) : null}
                  {canAdminister ? (
                    <>
                      <button
                        className="inline-flex min-h-11 items-center px-2 text-xs text-[color:var(--tx3)] hover:text-[color:var(--tx)]
                          disabled:opacity-50"
                        disabled={isSourceSyncing(source)}
                        onClick={() =>
                          action.mutate(
                            { id: source.id, action: 'sync' },
                            {
                              onError: (cause) =>
                                onSaveError(formErrorMessage(cause, t('sourceSettings.syncError'))),
                              onSuccess: onSaved,
                            },
                          )
                        }
                        type="button"
                      >
                        {isSourceSyncing(source) ? t('sourceSettings.syncing') : t('sourceSettings.syncNow')}
                      </button>
                      <button
                        className="inline-flex min-h-11 items-center px-2 text-xs text-[color:var(--tx3)] hover:text-[color:var(--danger-text)]"
                        onClick={() => setRemoveTarget(source)}
                        type="button"
                      >
                        {t('sourceSettings.remove')}
                      </button>
                    </>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}

        {canAdminister ? (
          <div className="border-t border-[color:var(--sep)] pt-3">
            <button
              className="admin-button admin-button-primary h-11"
              onClick={() => setConnectOpen(true)}
              type="button"
            >
              {t('sourceSettings.connectTitle')}
            </button>
          </div>
        ) : null}
      </Section>

      {selected ? (
        <SourceMappingPanel
          canAdminister={canAdminister}
          onSaveError={onSaveError}
          onSaved={onSaved}
          projectId={projectId}
          sourceId={selected.id}
        />
      ) : null}

      <ConnectSourceDialog
        onClose={() => setConnectOpen(false)}
        onCreated={onSelectSource}
        open={connectOpen}
        projectId={projectId}
      />

      <ConfirmDialog
        body={t('sourceSettings.removeBody')}
        confirmLabel={t('sourceSettings.remove')}
        destructive
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => {
          const target = removeTarget
          setRemoveTarget(null)
          if (!target) return
          removeSource.mutate(target.id, {
            onError: (cause) => onSaveError(formErrorMessage(cause, t('sourceSettings.removeError'))),
            onSuccess: onSaved,
          })
        }}
        open={removeTarget !== null}
        title={t('sourceSettings.removeTitle', { provider: removeTarget ? PROVIDER_LABEL[removeTarget.provider] : '', name: removeTarget?.name ?? '' })}
      />
    </>
  )
}
