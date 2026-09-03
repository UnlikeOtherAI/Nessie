import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { faChevronDown } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { isAdminRole, type UoaPendingTeamInvite } from '@nessie/schemas'
import { useAuthProviders } from '../../facades/auth/hooks'
import { useCurrentOrganization } from '../../facades/organization/hooks'
import { teamsFromMe, type Team } from '../../lib/teams'
import { useTeamAvatarRevision } from '../../facades/team/hooks'
import { useAcceptTeamInvitation } from '../../facades/team/invitations'
import { TeamAvatar } from '../../components/primitives/TeamAvatar'
import { startExternalSignIn, startTeamSwitchReauthorization } from '../../lib/external-auth'
import { isReactNativeWebView } from '../../lib/mobile-shell'
import { IMPORTED_SESSION_SCOPE_MESSAGE } from '../../lib/imported-session-policy'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { resolveAppliedTheme, useTheme } from '../../providers/ThemeProvider'
import { CreateTeamDialog } from './CreateTeamDialog'
import { recoverTeamSwitchFailure } from './team-switch-recovery'
import { teamSwitchFailureMessage } from './team-switch-message'
import { TeamMenu } from './TeamMenu'
import { useTransientMenu } from './TransientMenuContext'

type NativeTeamWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void }
  __nessieToggleTeamMenu?: (left?: unknown) => void
}

/**
 * Shared team switcher. Local sessions re-scope through
 * `switch-context`; renewable UOA sessions use a server-authorized in-app
 * team switch, so local and signed UOA team scopes cannot drift.
 * The desktop rail and mobile web header render triggers; native iPad and
 * iPhone controls open this same menu. "Add a team" opens the in-app
 * creation dialog: founding an organisation used to redirect through UOA's
 * chooser and cost a second interactive login, and now runs against UOA's org
 * API with the same silent switch a rail selection uses.
 */
type TeamSwitcherProps = {
  variant?: 'mobile-header' | 'native-bridge' | 'rail'
}

export const TeamSwitcher = ({ variant = 'rail' }: TeamSwitcherProps) => {
  const {
    me,
    reconcileSession,
    sessionMode,
    switchContext,
    switchUoaTeam,
    token,
  } = useAuthSession()
  const { data: providers = [] } = useAuthProviders()
  const { data: organization } = useCurrentOrganization()
  const avatarRevision = useTeamAvatarRevision()
  const { theme } = useTheme()
  const navigate = useNavigate()
  const acceptInvitation = useAcceptTeamInvitation()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const nativeAnchorRef = useRef<HTMLDivElement>(null)
  const { close, isOpen: open, toggle } = useTransientMenu()
  const [busyTeamId, setBusyTeamId] = useState<string | null>(null)
  const [busyInviteId, setBusyInviteId] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [nativeAnchorLeft, setNativeAnchorLeft] = useState(8)
  const [createOpen, setCreateOpen] = useState(false)

  const teams = useMemo(() => teamsFromMe(me), [me])
  const invitations = me?.uoaPendingInvites ?? []
  const activeTeamId = me?.context.teamId ?? null
  const active = teams.find(
    (team) => team.active || team.teamId === activeTeamId,
  )
  const anchorRef = variant === 'native-bridge' ? nativeAnchorRef : buttonRef
  const ssoProviderId =
    providers.find((provider) => provider.enabled && provider.type !== 'local-bootstrap')?.providerId ??
    null
  // Creating in place needs the bound UOA refresh credential the switch grant
  // spends. Any other session still takes the provider redirect, which is the
  // only way it can end up holding one.
  const isUoaSession = me?.auth.providerType === 'uoa'
  // Adding a team writes into the current organisation, so UOA gates it on
  // owner/admin and the route mirrors that. Offering the tab to a member would
  // be offering a form that can only 403. Founding an organisation carries no
  // such condition — it creates a separate tenancy — so the dialog itself is
  // never withheld.
  const canCreateTeam = isAdminRole(organization?.role)

  const toggleMenu = (): void => {
    if (busyTeamId !== null || busyInviteId !== null) return
    setSwitchError(null)
    toggle()
  }

  const closeMenu = (): void => {
    if (busyTeamId === null && busyInviteId === null) close()
  }

  const handleAcceptInvitation = async (
    invite: UoaPendingTeamInvite,
  ): Promise<void> => {
    if (sessionMode === 'imported') {
      setSwitchError(IMPORTED_SESSION_SCOPE_MESSAGE)
      return
    }
    setSwitchError(null)
    setBusyInviteId(invite.inviteId)
    try {
      await acceptInvitation.mutateAsync(invite)
      close()
    } catch (error) {
      setSwitchError(
        error instanceof Error
          ? error.message
          : 'This team invitation could not be accepted.',
      )
    } finally {
      setBusyInviteId(null)
    }
  }

  const handleSelect = async (team: Team): Promise<void> => {
    if (team.active || team.teamId === activeTeamId) {
      close()
      return
    }
    if (sessionMode === 'imported') {
      setSwitchError(IMPORTED_SESSION_SCOPE_MESSAGE)
      return
    }
    setSwitchError(null)
    setBusyTeamId(team.teamId)
    try {
      if (team.uoaTeam) {
        await switchUoaTeam({
          organizationId: team.organizationId,
          teamId: team.teamId,
        })
      } else {
        await switchContext({
          organizationId: team.organizationId,
          projectId: team.projectId,
          teamId: team.teamId,
        })
      }
      close()
      void navigate('/channels', { replace: true })
    } catch (error) {
      const recovery = await recoverTeamSwitchFailure({
        currentTeam: active ?? null,
        error,
        reconcileSession,
        targetTeam: team,
      })
      if (recovery.outcome === 'switched') {
        close()
        void navigate('/channels', { replace: true })
      } else if (recovery.outcome === 'reauthorize') {
        // Target proof is missing/non-renewable: re-enter SSO hinted at the
        // exact target. The current session is untouched; the always-mounted
        // external-auth bridge completes the callback in place.
        const providerId = me?.auth.providerId
        if (providerId) {
          try {
            await startTeamSwitchReauthorization({
              providerId,
              targetTeam: {
                organizationId: team.organizationId,
                teamId: team.teamId,
              },
              theme: resolveAppliedTheme(theme),
            })
            close()
          } catch {
            setSwitchError(teamSwitchFailureMessage({
              state: 'reauthenticate',
              targetTeam: team.label,
            }))
          }
        } else {
          setSwitchError(teamSwitchFailureMessage({
            state: 'reauthenticate',
            targetTeam: team.label,
          }))
        }
      } else {
        setSwitchError(recovery.message)
      }
    } finally {
      setBusyTeamId(null)
    }
  }

  /**
   * A UOA-backed session creates in place; anything else still has to go
   * through the provider, because the in-app path needs a bound UOA refresh
   * credential to switch onto whatever it just created.
   */
  const handleAddTeam = (providerId: string): void => {
    close()
    if (isUoaSession) {
      setCreateOpen(true)
      return
    }
    void startExternalSignIn(providerId, resolveAppliedTheme(theme))
  }

  useEffect(() => {
    if (variant !== 'native-bridge' || !isReactNativeWebView()) return undefined
    const target = window as NativeTeamWindow
    target.__nessieToggleTeamMenu = (left?: unknown) => {
      if (typeof left === 'number' && Number.isFinite(left)) {
        setNativeAnchorLeft(Math.max(8, left))
      }
      toggleMenu()
    }
    return () => {
      delete target.__nessieToggleTeamMenu
    }
  }, [busyTeamId, variant])

  useEffect(() => {
    if (variant !== 'native-bridge' || !isReactNativeWebView()) return
    ;(window as NativeTeamWindow).ReactNativeWebView?.postMessage(
      JSON.stringify({
        name: active?.label ?? null,
        type: 'nessie:team',
        teamAvatarUrl: active?.avatarImageUrl ?? null,
      }),
    )
  }, [active?.avatarImageUrl, active?.label, variant])

  // The switcher is the rail's single team identity control, including
  // when there is currently only one team.
  if (teams.length === 0 && invitations.length === 0 && !ssoProviderId) {
    return null
  }

  return (
    <>
      {variant === 'rail' ? (
        <button
          aria-haspopup="menu"
          aria-label="Switch team"
          className={[
            'mb-4 flex h-9 w-9 items-center justify-center rounded-xl transition-shadow',
            open ? 'ring-2 ring-[color:var(--accent)]' : 'hover:ring-2 hover:ring-[color:var(--overlay)]',
          ].join(' ')}
          onClick={toggleMenu}
          ref={buttonRef}
          title={active ? `Team: ${active.label}` : 'Switch team'}
          type="button"
        >
          <span className="relative">
            <TeamAvatar
              imageUrl={active?.avatarImageUrl}
              label={active?.label ?? 'Team'}
              revision={avatarRevision}
              size={36}
              teamId={active?.uoaTeam ? active.avatarTeamId ?? null : active?.teamId}
              token={token}
            />
            <span
              aria-hidden="true"
              className={[
                'absolute bottom-0.5 right-0.5 flex h-[10px] w-[10px] items-center justify-center',
                'rounded-[3px] border border-[color:var(--sep)] bg-[color:var(--panel)]',
                'text-[5px] text-[color:var(--tx)]',
              ].join(' ')}
            >
              <FontAwesomeIcon
                className={[
                  'transition-transform duration-150 motion-reduce:transition-none',
                  open ? 'rotate-180' : 'rotate-0',
                ].join(' ')}
                icon={faChevronDown}
              />
            </span>
          </span>
        </button>
      ) : variant === 'mobile-header' ? (
        <button
          aria-haspopup="menu"
          aria-label="Switch team"
          className="mobile-web-home-team"
          onClick={toggleMenu}
          ref={buttonRef}
          title={active ? `Team: ${active.label}` : 'Switch team'}
          type="button"
        >
          <TeamAvatar
            imageUrl={active?.avatarImageUrl}
            label={active?.label ?? 'Team'}
            revision={avatarRevision}
            size={36}
            teamId={active?.uoaTeam ? active.avatarTeamId ?? null : active?.teamId}
            token={token}
          />
          <span className="min-w-0 flex-1 truncate">{active?.label ?? 'Team'}</span>
          <svg aria-hidden="true" fill="none" height="22" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24" width="22">
            <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : (
        <div
          aria-hidden
          className="pointer-events-none fixed top-0 z-[69] h-px w-px"
          ref={nativeAnchorRef}
          style={{ left: nativeAnchorLeft }}
        />
      )}
      <TeamMenu
        activeTeamId={activeTeamId}
        anchorRef={anchorRef}
        avatarRevision={avatarRevision}
        busyInviteId={busyInviteId}
        busyTeamId={busyTeamId}
        error={switchError}
        invitations={invitations}
        onAcceptInvitation={(invite) => void handleAcceptInvitation(invite)}
        onAddTeam={handleAddTeam}
        onClose={closeMenu}
        onSelect={handleSelect}
        open={open}
        ssoProviderId={ssoProviderId}
        token={token}
        teams={teams}
      />
      <CreateTeamDialog
        canCreateTeam={canCreateTeam && Boolean(active?.uoaTeam)}
        onClose={() => setCreateOpen(false)}
        open={createOpen}
        organizationName={active?.orgName ?? null}
      />
    </>
  )
}
