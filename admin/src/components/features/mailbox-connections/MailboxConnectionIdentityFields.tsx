import type { MailboxConnectionScope, TeamRecord } from '../../../lib/api-client'

type MailboxConnectionIdentityFieldsProps = {
  label: string
  onLabelChange: (value: string) => void
  onTeamChange: (value: string) => void
  scope: MailboxConnectionScope
  teamId: string
  teams: TeamRecord[]
}

/**
 * The optional human name and team destination belong to the mailbox identity,
 * so the address-first and advanced paths share these controls verbatim.
 */
export const MailboxConnectionIdentityFields = ({
  label,
  onLabelChange,
  onTeamChange,
  scope,
  teamId,
  teams,
}: MailboxConnectionIdentityFieldsProps) => (
  <>
    {scope === 'team' ? (
      <label className="grid gap-1 text-sm">
        <span className="text-[color:var(--tx2)]">Share with team</span>
        <select
          className="admin-input"
          onChange={(event) => onTeamChange(event.target.value)}
          required
          value={teamId}
        >
          <option value="">Choose a team…</option>
          {teams.map((team) => (
            <option key={team.id} value={team.id}>{team.name}</option>
          ))}
        </select>
      </label>
    ) : null}
    <label className="grid gap-1 text-sm">
      <span className="text-[color:var(--tx2)]">
        Name this connection <span className="text-[color:var(--tx3)]">(optional)</span>
      </span>
      <input
        className="admin-input"
        onChange={(event) => onLabelChange(event.target.value)}
        placeholder={scope === 'team' ? 'Support inbox' : 'Work email'}
        value={label}
      />
    </label>
  </>
)
