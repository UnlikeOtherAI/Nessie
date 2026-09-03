import { TeamMembersSection } from './TeamMembersSection'
import { SettingsPanel } from './settings-shared'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { useIsOwner } from '../../components/shared/OwnerGate'
import { startExternalSignIn } from '../../lib/external-auth'
import { resolveAppliedTheme, useTheme } from '../../providers/ThemeProvider'

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
  const { theme } = useTheme()

  if (!me) return null

  return (
    <SettingsPanel eyebrow="Team" title="Members">
      <TeamMembersSection
        canManage={canManage}
        onReconnect={async () => {
          const providerId = me.auth.providerId
          if (!providerId) throw new Error('UnlikeOtherAI sign-in is not configured.')
          await startExternalSignIn(providerId, resolveAppliedTheme(theme), {
            returnPath: window.location.pathname + window.location.search,
          })
        }}
      />
    </SettingsPanel>
  )
}
