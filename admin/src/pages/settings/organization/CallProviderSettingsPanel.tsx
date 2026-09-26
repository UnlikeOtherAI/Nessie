import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { TeamRecord } from '../../../lib/api-client'
import { callProviderLabel } from '../../../facades/calls/call-presentation'
import { useTeams, useUpdateTeamCallProvider } from '../../../facades/projects/hooks'
import { SectionLabel } from '../../../components/primitives/SectionLabel'
import { Card } from '../../../components/shared/Card'
import { FormError } from '../../../components/shared/FormActions'
import { QueryState } from '../../../components/shared/QueryState'
import { RowList, Row } from '../../../components/shared/RowList'

type CallProvider = TeamRecord['callProvider']

const CALL_PROVIDERS: readonly CallProvider[] = [
  'google_meet',
  'jitsi',
  'microsoft_teams',
]

export const callProviderUnavailableReason = (
  provider: CallProvider,
  translate: TFunction<'settings'>,
): string => translate('organization.providerUnavailable', { provider: callProviderLabel(provider) })

type CallProviderSelectProps = {
  disabled: boolean
  onChange: (provider: CallProvider) => void
  team: TeamRecord
}

/** One team's configured call-link provider, including deployment availability. */
export const CallProviderSelect = ({ disabled, onChange, team }: CallProviderSelectProps) => {
  const { t } = useTranslation('settings')
  const hasConfiguredProvider = CALL_PROVIDERS.some(
    (provider) => team.callProviderAvailability[provider],
  )
  const unavailableProviders = CALL_PROVIDERS.filter(
    (provider) => !team.callProviderAvailability[provider],
  )

  return (
    <div className="grid max-w-sm gap-1">
      <select
        aria-label={t('organization.callProviderFor', { team: team.name })}
        className="admin-input"
        disabled={disabled || !hasConfiguredProvider}
        onChange={(event) => onChange(event.target.value as CallProvider)}
        value={team.callProvider}
      >
        {CALL_PROVIDERS.map((provider) => {
          const available = team.callProviderAvailability[provider]
          return (
            <option disabled={!available} key={provider} value={provider}>
              {callProviderLabel(provider)}{available ? '' : ` — ${callProviderUnavailableReason(provider, t)}`}
            </option>
          )
        })}
      </select>
      {!hasConfiguredProvider ? (
        <p className="text-xs text-[color:var(--danger-text)]" role="status">
          {t('organization.noCallProviders')}
        </p>
      ) : (
        unavailableProviders.map((provider) => (
          <p className="text-xs text-[color:var(--tx3)]" key={provider}>
            {callProviderUnavailableReason(provider, t)}
          </p>
        ))
      )}
    </div>
  )
}

const CallProviderRow = ({ team }: { team: TeamRecord }) => {
  const { t } = useTranslation('settings')
  const updateProvider = useUpdateTeamCallProvider()
  const [error, setError] = useState<string | null>(null)

  const changeProvider = async (callProvider: CallProvider) => {
    setError(null)
    try {
      await updateProvider.mutateAsync({ callProvider, teamId: team.id })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('organization.providerSaveFailed'))
    }
  }

  return (
    <Row
      subtitle={t('organization.callsCreateLink', { provider: callProviderLabel(team.callProvider) })}
      title={team.name}
    >
      <div className="mt-2">
        <CallProviderSelect
          disabled={updateProvider.isPending}
          onChange={(provider) => void changeProvider(provider)}
          team={team}
        />
      </div>
      <FormError className="mt-2">{error}</FormError>
    </Row>
  )
}

/** The organization-level home for the per-team setting that drives Call. */
export const CallProviderSettingsPanel = () => {
  const { t } = useTranslation('settings')
  const teams = useTeams()

  return (
    <Card as="section">
      <SectionLabel>{t('organization.calls')}</SectionLabel>
      <p className="mt-2 text-sm text-[color:var(--tx2)]">
        {t('organization.callsDescription')}
      </p>

      <div className="mt-4">
        <QueryState
          emptyLabel={t('organization.noTeams')}
          errorLabel={t('organization.teamsLoadFailed')}
          isEmpty={(teams.data?.length ?? 0) === 0}
          loadingLabel={t('organization.teamsLoading')}
          query={teams}
        >
          {() => (
            <RowList label={t('team.teams')}>
              {(teams.data ?? []).map((team) => <CallProviderRow key={team.id} team={team} />)}
            </RowList>
          )}
        </QueryState>
      </div>
    </Card>
  )
}
