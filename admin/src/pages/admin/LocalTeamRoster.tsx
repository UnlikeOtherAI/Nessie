import { TeamMembersSection } from '../settings/TeamMembersSection'
import { SettingsPanel, type SettingsTabHostProps } from '../../components/shared/SettingsPanel'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { useIsOwner } from '../../facades/auth/hooks'
import { startExternalSignIn } from '../../lib/external-auth'
import { useTheme } from '../../providers/ThemeProvider'

/**
 * People at a team's scope on a session with no UnlikeOtherAI roster: the
 * team's own members, read from `GET /api/team/members`, which is scoped to the
 * team the person is working in — so `PeoplePage` renders this only for that
 * team and says so for any other.
 */
export const LocalTeamRoster = ({ host }: { host?: SettingsTabHostProps }) => {
  const { me } = useAuthSession()
  const isOwner = useIsOwner()
  const canManage = isOwner || (me?.user.roleIds.includes('admin') ?? false)
  const { signInTheme } = useTheme()

  if (!me) return null

  return (
    <SettingsPanel eyebrow="Team" host={host} title="People">
      <TeamMembersSection
        canManage={canManage}
        onReconnect={async () => {
          const providerId = me.auth.providerId
          if (!providerId) throw new Error('Sign-in with UnlikeOtherAI isn’t set up on this Nessie.')
          await startExternalSignIn(providerId, signInTheme, {
            returnPath: window.location.pathname + window.location.search,
          })
        }}
      />
    </SettingsPanel>
  )
}
