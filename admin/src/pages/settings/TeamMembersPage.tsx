import { TeamMembersSection } from './TeamMembersSection'
import { SettingsPanel } from './settings-shared'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { useIsOwner } from '../../components/shared/OwnerGate'
import { startExternalSignIn } from '../../lib/external-auth'
import { useTheme } from '../../providers/ThemeProvider'
import { MembersRosterPanel } from './MembersRosterPanel'

/**
 * A team's own roster — the direct, top-level peer of
 * `SettingsMembersPage`'s organisation roster (`/settings/members`), not a
 * tab buried inside Team Settings. Same doorway shape: a "Team" sidebar
 * item of its own (`AdminSidebarNav.tsx`), mirroring how "Members" already
 * sits beside "Settings" under "Organization".
 *
 * `GET /api/team/members` is scoped to the caller's own currently-active
 * team — there is no arbitrary-team parameter — so, exactly like the
 * organisation page reads the viewer's own org, this page always shows the
 * viewer's own current team. No team picker: picking a different team to
 * view is switching teams, a different action with its own doorway (the
 * workspace switcher).
 */
export const TeamMembersPage = () => {
  const { me } = useAuthSession()
  const isOwner = useIsOwner()
  const canManage = isOwner || (me?.user.roleIds.includes('admin') ?? false)
  const { signInTheme } = useTheme()

  if (!me) return null

  if (me.auth.providerType === 'uoa') {
    return <MembersRosterPanel scope="team" />
  }

  return (
    <SettingsPanel eyebrow="Team" title="Members">
      <TeamMembersSection
        canManage={canManage}
        onReconnect={async () => {
          const providerId = me.auth.providerId
          if (!providerId) throw new Error('UnlikeOtherAI sign-in is not configured.')
          await startExternalSignIn(providerId, signInTheme, {
            returnPath: window.location.pathname + window.location.search,
          })
        }}
      />
    </SettingsPanel>
  )
}
