import { useState } from 'react'

import {
  SETTING_KEYS,
  settingFor,
  useScopedSettings,
  useWriteScopedSetting,
  type SettingScope,
} from '../../../facades/settings/hooks'
import { Switch } from '../../primitives/Switch'
import { SectionLabel } from '../../primitives/SectionLabel'
import { FormError, FormSuccess } from '../../shared/FormActions'
import { Notice } from '../../primitives/Notice'
import { QueryState } from '../../shared/QueryState'
import { ScopedSettingGate, ScopedSettingLock } from '../settings/ScopedSettingGate'
import { localInferenceEnablementState } from './local-inference-enablement-state'

type LocalInferenceEnablementProps = {
  scope: SettingScope
  /** Required for the team-level cascade; ignored at organisation scope. */
  teamId?: string | null
  /** A live organisation administrator may inspect and set this exact person. */
  userId?: string | null
}

const targetLabel = (scope: SettingScope) => scope === 'organization'
  ? 'this organisation'
  : scope === 'team' ? 'this team' : 'this person'

/**
 * The one policy control at the organisation, team and selected-person homes.
 *
 * It owns no device discovery or host state. Enabling this policy only lets an
 * eligible person choose to set up their own computer later, which keeps a
 * browser admin from appearing to have inspected or activated it remotely.
 */
export const LocalInferenceEnablement = ({
  scope,
  teamId = null,
  userId = null,
}: LocalInferenceEnablementProps) => {
  const settings = useScopedSettings(
    scope,
    [SETTING_KEYS.localInferenceEnabled],
    teamId,
    userId,
  )
  const write = useWriteScopedSetting()
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const setting = settingFor(settings.data, SETTING_KEYS.localInferenceEnabled)
  const state = localInferenceEnablementState(setting)
  const target = targetLabel(scope)

  const commit = (enabled: boolean, locked: boolean, saved: string) => {
    setError(null)
    setSuccess(null)
    write.mutate({
      key: SETTING_KEYS.localInferenceEnabled,
      locked,
      scope,
      teamId,
      userId,
      value: enabled,
    }, {
      onError: (cause) =>
        setError(cause instanceof Error ? cause.message : 'AI on people’s own computers could not be saved.'),
      onSuccess: () => setSuccess(saved),
    })
  }

  return (
    <section
      className="grid gap-3 border-y border-[color:var(--sep)] py-4"
      data-testid={`local-inference-policy-${scope}`}
    >
      <div>
        <SectionLabel as="h2">AI on people’s own computers</SectionLabel>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-[color:var(--tx2)]">
          Permit {target} to use a model installed on their own computer. This only permits
          setup; it does not discover, inspect, or activate anyone’s computer.
        </p>
      </div>

      <QueryState
        errorLabel="This policy could not be loaded."
        loadingLabel="Loading policy…"
        query={settings}
      >
        {() => (
          <div className="grid gap-3">
            <Notice tone={state.enabled ? 'success' : 'neutral'}>
              {state.summary}
            </Notice>
            <ScopedSettingGate setting={setting}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-[color:var(--tx)]">Allow AI on people’s own computers</p>
                  <p className="mt-1 text-xs text-[color:var(--tx3)]">
                    People still choose a specific computer and model for each agent.
                  </p>
                </div>
                <Switch
                  checked={state.enabled}
                  disabled={!state.canEdit || write.isPending}
                  label={`${state.enabled ? 'Disable' : 'Enable'} AI on people’s own computers for ${target}`}
                  onChange={(enabled) => commit(
                    enabled,
                    state.lockedHere,
                    enabled ? 'Enabled.' : 'Disabled.',
                  )}
                />
              </div>
            </ScopedSettingGate>
            {state.canEdit && scope !== 'user' ? (
              <ScopedSettingLock
                disabled={write.isPending}
                locked={state.lockedHere}
                onChange={(locked) => commit(state.enabled, locked, 'Policy saved.')}
                scope={scope}
              />
            ) : null}
            <FormError>{error}</FormError>
            <FormSuccess>{success}</FormSuccess>
          </div>
        )}
      </QueryState>
    </section>
  )
}
