import type { AutomaticMembershipRuleView } from '../../facades/users/automatic-membership'
import type { useAutomaticMembershipTeams } from '../../facades/users/automatic-membership'
import { Checkbox } from '../../components/primitives/Checkbox'

export const AutomaticMembershipTeamMapping = ({
  teams,
  selected,
  setSelected,
}: {
  teams: ReturnType<typeof useAutomaticMembershipTeams>
  selected: string[]
  setSelected: (next: string[]) => void
}) => {
  if (teams.isLoading) return <p className="text-sm text-[color:var(--tx3)]">Loading teams available to this organization…</p>
  if (teams.isError) return <div className="text-sm text-[color:var(--danger-text)]">Teams could not be loaded. <button className="underline" onClick={() => void teams.refetch()} type="button">Retry</button></div>
  if (!teams.data?.teams.length) return <p className="text-sm text-[color:var(--danger-text)]">There are no eligible teams. Create a team first, then return to map this domain.</p>
  return (
    <fieldset>
      <legend className="text-sm font-medium">Teams to grant after sign-in</legend>
      <p className="mt-1 text-sm text-[color:var(--tx2)]">Matching verified users receive only normal member access to the checked teams.</p>
      <div className="mt-3 grid gap-2">
        {teams.data.teams.map((team) => (
          <Checkbox
            checked={selected.includes(team.id)}
            key={team.id}
            label={team.name}
            onChange={() => setSelected(selected.includes(team.id)
              ? selected.filter((id) => id !== team.id)
              : [...selected, team.id])}
          />
        ))}
      </div>
    </fieldset>
  )
}

export const AutomaticMembershipBackfillSummary = ({ rule }: { rule: AutomaticMembershipRuleView }) => {
  const backfill = rule.backfill
  if (!backfill) return null
  return (
    <div className="mt-3 border-t border-[color:var(--border)] pt-3 text-sm text-[color:var(--tx2)]">
      <p className="font-medium text-[color:var(--tx)]">Reconciliation</p>
      <p className="mt-1">{backfill.status.replace(/_/g, ' ')} · {backfill.processedCount} processed · {backfill.grantedCount} granted · {backfill.failedCount} failed</p>
      {backfill.nextRetryAt ? <p>Next retry: {new Date(backfill.nextRetryAt).toLocaleString()}</p> : null}
      <p className="mt-1 text-xs text-[color:var(--tx3)]">Progress is aggregate only. Matching people stay in UOA and are not listed here.</p>
    </div>
  )
}
