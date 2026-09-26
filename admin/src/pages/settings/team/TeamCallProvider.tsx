import { useState } from 'react'
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

export const callProviderUnavailableReason = (provider: CallProvider): string =>
  `${callProviderLabel(provider)} is not configured for this deployment.`

type CallProviderSelectProps = {
  disabled: boolean
  onChange: (provider: CallProvider) => void
  team: TeamRecord
}

/** One team's configured call-link provider, including deployment availability. */
export const CallProviderSelect = ({ disabled, onChange, team }: CallProviderSelectProps) => {
  const hasConfiguredProvider = CALL_PROVIDERS.some(
    (provider) => team.callProviderAvailability[provider],
  )
  const unavailableProviders = CALL_PROVIDERS.filter(
    (provider) => !team.callProviderAvailability[provider],
  )

  return (
    <div className="grid max-w-sm gap-1">
      <select
        aria-label={`Call provider for ${team.name}`}
        className="admin-input"
        disabled={disabled || !hasConfiguredProvider}
        onChange={(event) => onChange(event.target.value as CallProvider)}
        value={team.callProvider}
      >
        {CALL_PROVIDERS.map((provider) => {
          const available = team.callProviderAvailability[provider]
          return (
            <option disabled={!available} key={provider} value={provider}>
              {callProviderLabel(provider)}{available ? '' : ` — ${callProviderUnavailableReason(provider)}`}
            </option>
          )
        })}
      </select>
      {!hasConfiguredProvider ? (
        <p className="text-xs text-[color:var(--danger-text)]" role="status">
          No call providers are configured for this deployment.
        </p>
      ) : (
        unavailableProviders.map((provider) => (
          <p className="text-xs text-[color:var(--tx3)]" key={provider}>
            {callProviderUnavailableReason(provider)}
          </p>
        ))
      )}
    </div>
  )
}

const CallProviderRow = ({ team }: { team: TeamRecord }) => {
  const updateProvider = useUpdateTeamCallProvider()
  const [error, setError] = useState<string | null>(null)

  const changeProvider = async (callProvider: CallProvider) => {
    setError(null)
    try {
      await updateProvider.mutateAsync({ callProvider, teamId: team.id })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to save the call provider.')
    }
  }

  return (
    <Row
      subtitle={`Calls in this team create a ${callProviderLabel(team.callProvider)} link.`}
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
  const teams = useTeams()

  return (
    <Card as="section">
      <SectionLabel>Calls</SectionLabel>
      <p className="mt-2 text-sm text-[color:var(--tx2)]">
        Choose the provider used when someone starts a call in each team.
      </p>

      <div className="mt-4">
        <QueryState
          emptyLabel="No teams are available."
          errorLabel="Could not load teams."
          isEmpty={(teams.data?.length ?? 0) === 0}
          loadingLabel="Loading teams…"
          query={teams}
        >
          {() => (
            <RowList label="Teams">
              {(teams.data ?? []).map((team) => <CallProviderRow key={team.id} team={team} />)}
            </RowList>
          )}
        </QueryState>
      </div>
    </Card>
  )
}
