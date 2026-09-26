import { TeamAvatar } from '../../components/primitives/TeamAvatar'
import { QueryState } from '../../components/shared/QueryState'
import { Row, RowList } from '../../components/shared/RowList'
import { SettingsPanel } from '../../components/shared/SettingsPanel'
import { useIsOwner } from '../../facades/auth/hooks'
import { useTeams } from '../../facades/projects/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'

const memberCountLabel = (count: number | undefined): string | undefined =>
  count === undefined ? undefined : `${count} ${count === 1 ? 'member' : 'members'}`

/**
 * Admin › Teams: every team, each opening its own page — its name, address and
 * picture, where its calls are hosted, and what it sets over the organisation's
 * defaults. Every team is edited from its own page, so no page picks a team
 * from a dropdown any more.
 */
export const TeamsPage = () => {
  const { me, token } = useAuthSession()
  const isOwner = useIsOwner()
  const canManage = isOwner || (me?.user.roleIds.includes('admin') ?? false)
  const teams = useTeams()
  const rows = teams.data ?? []

  return (
    <SettingsPanel eyebrow="Organisation" title="Teams">
      {canManage ? (
        <QueryState
          emptyLabel="No teams yet."
          errorLabel="Teams could not be loaded."
          isEmpty={rows.length === 0}
          loadingLabel="Loading teams…"
          query={teams}
        >
          {() => (
            <RowList label="Teams">
              {rows.map((team) => (
                <Row
                  href={`/admin/teams/${encodeURIComponent(team.id)}`}
                  key={team.id}
                  leading={<TeamAvatar label={team.name} size={36} teamId={team.id} token={token} />}
                  subtitle={memberCountLabel(team.memberCount)}
                  title={team.name}
                  trailing={<span className="text-sm text-[color:var(--lnk)]">Open</span>}
                />
              ))}
            </RowList>
          )}
        </QueryState>
      ) : (
        <p className="text-sm text-[color:var(--tx2)]">
          Only organisation owners and admins manage teams.
        </p>
      )}
    </SettingsPanel>
  )
}
