import { useState } from 'react'
import {
  PROVIDER_LABEL,
  useDeleteProjectSource,
  useProjectSources,
  useSourceAction,
  type BoardSourceRecord,
} from '../../../facades/board-sources/hooks'
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog'
import { EmptyState } from '../../../components/shared/EmptyState'
import { Section } from '../../../components/shared/PageBody'
import { Pill } from '../../../components/primitives/Pill'
import { formErrorMessage } from '../../../facades/form-errors'
import { ConnectSourceDialog } from './ConnectSourceDialog'
import { SourceMappingPanel } from './SourceMappingPanel'

/**
 * Each health state names the one thing that fixes it — the standard is
 * docs/standards/capability-health-alerts.md. `active` has no remedy because
 * nothing is wrong, and `paused` is somebody's own decision rather than a fault.
 */
const REMEDY: Record<
  BoardSourceRecord['healthState'],
  { action: 'sync' | 'pause' | 'resume' | 'retry' | 'reconnect' | null; label: string }
> = {
  active: { action: 'pause', label: 'Pause' },
  paused: { action: 'resume', label: 'Resume' },
  needs_reauthorization: { action: 'reconnect', label: 'Reconnect' },
  owner_inactive: { action: 'reconnect', label: 'Connect as me' },
  misconfigured: { action: null, label: 'Edit the mapping below' },
  error: { action: 'retry', label: 'Retry now' },
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

const HEALTH_SENTENCE: Record<BoardSourceRecord['healthState'], string> = {
  active: 'Syncing',
  paused: 'Paused',
  needs_reauthorization: 'The provider stopped accepting this connection',
  owner_inactive: 'Its account owner is no longer an active member',
  misconfigured: 'Something in its mapping needs a decision',
  error: 'Syncing keeps failing',
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
  const { data: sources = [] } = useProjectSources(projectId)
  const action = useSourceAction(projectId)
  const removeSource = useDeleteProjectSource(projectId)
  const [connectOpen, setConnectOpen] = useState(startWithConnect)
  const [removeTarget, setRemoveTarget] = useState<BoardSourceRecord | null>(null)

  const selected = sources.find((source) => source.id === selectedSourceId) ?? sources[0] ?? null

  return (
    <>
      <Section
        description="Work from another system, mirrored onto this project's boards as ordinary
          tasks. Agents, approvals and search treat them exactly like native work."
        title="Sources"
      >
        {sources.length === 0 ? (
          <EmptyState title="No sources connected.">
            Connect Jira, Linear, Trello or GitHub to bring their work onto this
            project&rsquo;s boards.
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
                    className="min-w-0 flex-1 text-left text-sm text-[color:var(--tx)]"
                    onClick={() => onSelectSource(source.id)}
                    type="button"
                  >
                    {PROVIDER_LABEL[source.provider]} · {source.name}
                  </button>
                  <Pill size="sm" tone={HEALTH_TONE[source.healthState]} uppercase={false}>
                    {HEALTH_SENTENCE[source.healthState]}
                  </Pill>
                  <span className="text-xs text-[color:var(--tx3)]">
                    {source.itemCount} items · as {source.connectionOwnerDisplayName ?? 'unknown'}
                  </span>
                  {source.writeMode === 'read_write' ? (
                    <Pill size="sm" tone="info" uppercase={false}>
                      Read &amp; write
                    </Pill>
                  ) : null}
                  {canAdminister && remedy.action && remedy.action !== 'reconnect' ? (
                    <button
                      className="text-xs text-[color:var(--tx3)] hover:text-[color:var(--tx)]"
                      onClick={() =>
                        action.mutate(
                          { id: source.id, action: remedy.action as 'sync' | 'pause' | 'resume' | 'retry' },
                          {
                            onError: (cause) =>
                              onSaveError(formErrorMessage(cause, 'Could not change the source')),
                            onSuccess: onSaved,
                          },
                        )
                      }
                      type="button"
                    >
                      {remedy.label}
                    </button>
                  ) : null}
                  {canAdminister ? (
                    <>
                      <button
                        className="text-xs text-[color:var(--tx3)] hover:text-[color:var(--tx)]"
                        onClick={() =>
                          action.mutate(
                            { id: source.id, action: 'sync' },
                            {
                              onError: (cause) =>
                                onSaveError(formErrorMessage(cause, 'Could not start a sync')),
                              onSuccess: onSaved,
                            },
                          )
                        }
                        type="button"
                      >
                        Sync now
                      </button>
                      <button
                        className="text-xs text-[color:var(--tx3)] hover:text-[color:var(--danger-text)]"
                        onClick={() => setRemoveTarget(source)}
                        type="button"
                      >
                        Remove
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
              className="admin-button admin-button-primary admin-button-compact"
              onClick={() => setConnectOpen(true)}
              type="button"
            >
              Connect a source
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
        body="Its tickets stay on the board as ordinary tasks and stop updating. Nothing is deleted upstream."
        confirmLabel="Remove source"
        destructive
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => {
          const target = removeTarget
          setRemoveTarget(null)
          if (!target) return
          removeSource.mutate(target.id, {
            onError: (cause) => onSaveError(formErrorMessage(cause, 'Could not remove the source')),
            onSuccess: onSaved,
          })
        }}
        open={removeTarget !== null}
        title={`Remove ${removeTarget ? PROVIDER_LABEL[removeTarget.provider] : ''} · ${removeTarget?.name ?? ''}?`}
      />
    </>
  )
}
