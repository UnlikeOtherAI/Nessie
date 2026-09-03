import { TeamMembersSection } from '../TeamMembersSection'
import { Card } from '../../../components/shared/Card'
import { SettingsPanel, type SettingsTabHostProps } from '../settings-shared'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { useIsOwner } from '../../../components/shared/OwnerGate'
import { startExternalSignIn } from '../../../lib/external-auth'
import { resolveAppliedTheme, useTheme } from '../../../providers/ThemeProvider'
import type { TeamRecord } from '../../../lib/api-client'

/**
 * The roster of ONE team — reuses `TeamMembersSection` exactly as it already
 * renders on the org-wide Members page, unchanged: UOA owns the roster, and
 * `GET /api/team/members` is scoped to the caller's own currently-active
 * team, not an arbitrary id. That's why this page only renders the roster
 * while the team picker above it is pointed at the viewer's active team —
 * the same "active" gate `TeamProfilePage`'s rename control already uses —
 * and otherwise names the fix (switch to it) rather than silently showing
 * the wrong team's people.
 */
export const TeamMembersPage = ({ tabs, team }: SettingsTabHostProps & { team?: TeamRecord }) => {
  const { me } = useAuthSession()
  const isOwner = useIsOwner()
  const canManage = isOwner || (me?.user.roleIds.includes('admin') ?? false)
  const { theme } = useTheme()
  const active = team && team.id === me?.context.teamId

  return (
    <SettingsPanel eyebrow="Team" title="Members">
      {tabs}
      {active ? (
        <TeamMembersSection
          canManage={canManage}
          onReconnect={async () => {
            const providerId = me?.auth.providerId
            if (!providerId) throw new Error('UnlikeOtherAI sign-in is not configured.')
            await startExternalSignIn(providerId, resolveAppliedTheme(theme), {
              returnPath: window.location.pathname + window.location.search,
            })
          }}
        />
      ) : (
        <Card as="section">
          <p className="text-sm text-[color:var(--tx2)]">
            {team
              ? `Switch to "${team.name}" to see and manage its members.`
              : 'Select a team above to see its members.'}
          </p>
        </Card>
      )}
    </SettingsPanel>
  )
}
