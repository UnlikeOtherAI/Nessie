import { useState } from 'react'
import type { TeamRecord } from '../../../lib/api-client'
import { callProviderLabel } from '../../../facades/calls/call-presentation'
import { useTeams, useUpdateTeamCallProvider } from '../../../facades/projects/hooks'
import { SectionLabel } from '../../../components/primitives/SectionLabel'

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
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_15rem] sm:items-start">
      <div className="min-w-0">
        <div className="truncate font-medium text-[color:var(--tx)]">{team.name}</div>
        <p className="mt-1 text-sm text-[color:var(--tx2)]">
          Calls in this team create a {callProviderLabel(team.callProvider)} link.
        </p>
      </div>
      <div className="grid gap-1">
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
    <li className="border-t border-[color:var(--sep)] py-4 first:border-t-0 first:pt-0 last:pb-0">
      <CallProviderSelect
        disabled={updateProvider.isPending}
        onChange={(provider) => void changeProvider(provider)}
        team={team}
      />
      {error ? (
        <p className="mt-2 text-sm text-[color:var(--danger-text)]" role="alert">{error}</p>
      ) : null}
    </li>
  )
}

/** The organization-level home for the per-team setting that drives Call. */
export const CallProviderSettingsPanel = () => {
  const teams = useTeams()

  return (
    <section className="admin-card p-4">
      <SectionLabel>Calls</SectionLabel>
      <p className="mt-2 text-sm text-[color:var(--tx2)]">
        Choose the provider used when someone starts a call in each team.
      </p>

      {teams.isLoading ? (
        <p className="mt-4 text-sm text-[color:var(--tx2)]">Loading teams…</p>
      ) : teams.data?.length ? (
        <ul className="mt-4">
          {teams.data.map((team) => <CallProviderRow key={team.id} team={team} />)}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-[color:var(--tx3)]">No teams are available.</p>
      )}
    </section>
  )
}
