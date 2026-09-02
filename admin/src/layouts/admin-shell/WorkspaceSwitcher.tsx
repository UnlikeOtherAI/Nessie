import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { faChevronDown } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { UoaPendingWorkspaceInvite } from '@nessie/schemas'
import { useAuthProviders } from '../../facades/auth/hooks'
import { workspacesFromMe, type Workspace } from '../../lib/workspaces'
import { useWorkspaceAvatarRevision } from '../../facades/workspace/hooks'
import { useAcceptWorkspaceInvitation } from '../../facades/workspace/invitations'
import { WorkspaceAvatar } from '../../components/primitives/WorkspaceAvatar'
import { startExternalSignIn, startWorkspaceSwitchReauthorization } from '../../lib/external-auth'
import { isReactNativeWebView } from '../../lib/mobile-shell'
import { IMPORTED_SESSION_SCOPE_MESSAGE } from '../../lib/imported-session-policy'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { resolveAppliedTheme, useTheme } from '../../providers/ThemeProvider'
import { recoverWorkspaceSwitchFailure } from './workspace-switch-recovery'
import { workspaceSwitchFailureMessage } from './workspace-switch-message'
import { WorkspaceMenu } from './WorkspaceMenu'
import { useTransientMenu } from './TransientMenuContext'

type NativeWorkspaceWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void }
  __nessieToggleWorkspaceMenu?: (left?: unknown) => void
}

/**
 * Shared workspace switcher. Local sessions re-scope through
 * `switch-context`; renewable UOA sessions use a server-authorized in-app
 * workspace switch, so local and signed UOA workspace scopes cannot drift.
 * The desktop rail and mobile web header render triggers; native iPad and
 * iPhone controls open this same menu. "Add a workspace" opens UOA's full
 * chooser.
 */
type WorkspaceSwitcherProps = {
  variant?: 'mobile-header' | 'native-bridge' | 'rail'
}

export const WorkspaceSwitcher = ({ variant = 'rail' }: WorkspaceSwitcherProps) => {
  const {
    me,
    reconcileSession,
    sessionMode,
    switchContext,
    switchUoaWorkspace,
    token,
  } = useAuthSession()
  const { data: providers = [] } = useAuthProviders()
  const avatarRevision = useWorkspaceAvatarRevision()
  const { theme } = useTheme()
  const navigate = useNavigate()
  const acceptInvitation = useAcceptWorkspaceInvitation()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const nativeAnchorRef = useRef<HTMLDivElement>(null)
  const { close, isOpen: open, toggle } = useTransientMenu()
  const [busyTeamId, setBusyTeamId] = useState<string | null>(null)
  const [busyInviteId, setBusyInviteId] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [nativeAnchorLeft, setNativeAnchorLeft] = useState(8)

  const workspaces = useMemo(() => workspacesFromMe(me), [me])
  const invitations = me?.uoaPendingInvites ?? []
  const activeTeamId = me?.context.teamId ?? null
  const active = workspaces.find(
    (workspace) => workspace.active || workspace.teamId === activeTeamId,
  )
  const anchorRef = variant === 'native-bridge' ? nativeAnchorRef : buttonRef
  const ssoProviderId =
    providers.find((provider) => provider.enabled && provider.type !== 'local-bootstrap')?.providerId ??
    null

  const toggleMenu = (): void => {
    if (busyTeamId !== null || busyInviteId !== null) return
    setSwitchError(null)
    toggle()
  }

  const closeMenu = (): void => {
    if (busyTeamId === null && busyInviteId === null) close()
  }

  const handleAcceptInvitation = async (
    invite: UoaPendingWorkspaceInvite,
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
          : 'This workspace invitation could not be accepted.',
      )
    } finally {
      setBusyInviteId(null)
    }
  }

  const handleSelect = async (workspace: Workspace): Promise<void> => {
    if (workspace.active || workspace.teamId === activeTeamId) {
      close()
      return
    }
    if (sessionMode === 'imported') {
      setSwitchError(IMPORTED_SESSION_SCOPE_MESSAGE)
      return
    }
    setSwitchError(null)
    setBusyTeamId(workspace.teamId)
    try {
      if (workspace.uoaWorkspace) {
        await switchUoaWorkspace({
          organizationId: workspace.organizationId,
          teamId: workspace.teamId,
        })
      } else {
        await switchContext({
          organizationId: workspace.organizationId,
          projectId: workspace.projectId,
          teamId: workspace.teamId,
        })
      }
      close()
      void navigate('/channels', { replace: true })
    } catch (error) {
      const recovery = await recoverWorkspaceSwitchFailure({
        currentWorkspace: active ?? null,
        error,
        reconcileSession,
        targetWorkspace: workspace,
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
            await startWorkspaceSwitchReauthorization({
              providerId,
              targetWorkspace: {
                organizationId: workspace.organizationId,
                teamId: workspace.teamId,
              },
              theme: resolveAppliedTheme(theme),
            })
            close()
          } catch {
            setSwitchError(workspaceSwitchFailureMessage({
              state: 'reauthenticate',
              targetWorkspace: workspace.label,
            }))
          }
        } else {
          setSwitchError(workspaceSwitchFailureMessage({
            state: 'reauthenticate',
            targetWorkspace: workspace.label,
          }))
        }
      } else {
        setSwitchError(recovery.message)
      }
    } finally {
      setBusyTeamId(null)
    }
  }

  const handleAddWorkspace = (providerId: string): void => {
    close()
    void startExternalSignIn(providerId, resolveAppliedTheme(theme))
  }

  useEffect(() => {
    if (variant !== 'native-bridge' || !isReactNativeWebView()) return undefined
    const target = window as NativeWorkspaceWindow
    target.__nessieToggleWorkspaceMenu = (left?: unknown) => {
      if (typeof left === 'number' && Number.isFinite(left)) {
        setNativeAnchorLeft(Math.max(8, left))
      }
      toggleMenu()
    }
    return () => {
      delete target.__nessieToggleWorkspaceMenu
    }
  }, [busyTeamId, variant])

  useEffect(() => {
    if (variant !== 'native-bridge' || !isReactNativeWebView()) return
    ;(window as NativeWorkspaceWindow).ReactNativeWebView?.postMessage(
      JSON.stringify({
        name: active?.label ?? null,
        type: 'nessie:workspace',
        workspaceAvatarUrl: active?.avatarImageUrl ?? null,
      }),
    )
  }, [active?.avatarImageUrl, active?.label, variant])

  // The switcher is the rail's single workspace identity control, including
  // when there is currently only one workspace.
  if (workspaces.length === 0 && invitations.length === 0 && !ssoProviderId) {
    return null
  }

  return (
    <>
      {variant === 'rail' ? (
        <button
          aria-haspopup="menu"
          aria-label="Switch workspace"
          className={[
            'mb-4 flex h-9 w-9 items-center justify-center rounded-xl transition-shadow',
            open ? 'ring-2 ring-[color:var(--accent)]' : 'hover:ring-2 hover:ring-[color:var(--overlay)]',
          ].join(' ')}
          onClick={toggleMenu}
          ref={buttonRef}
          title={active ? `Workspace: ${active.label}` : 'Switch workspace'}
          type="button"
        >
          <span className="relative">
            <WorkspaceAvatar
              imageUrl={active?.avatarImageUrl}
              label={active?.label ?? 'Workspace'}
              revision={avatarRevision}
              size={36}
              teamId={active?.uoaWorkspace ? active.avatarTeamId ?? null : active?.teamId}
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
          aria-label="Switch workspace"
          className="mobile-web-home-workspace"
          onClick={toggleMenu}
          ref={buttonRef}
          title={active ? `Workspace: ${active.label}` : 'Switch workspace'}
          type="button"
        >
          <WorkspaceAvatar
            imageUrl={active?.avatarImageUrl}
            label={active?.label ?? 'Workspace'}
            revision={avatarRevision}
            size={36}
            teamId={active?.uoaWorkspace ? active.avatarTeamId ?? null : active?.teamId}
            token={token}
          />
          <span className="min-w-0 flex-1 truncate">{active?.label ?? 'Workspace'}</span>
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
      <WorkspaceMenu
        activeTeamId={activeTeamId}
        anchorRef={anchorRef}
        avatarRevision={avatarRevision}
        busyInviteId={busyInviteId}
        busyTeamId={busyTeamId}
        error={switchError}
        invitations={invitations}
        onAcceptInvitation={(invite) => void handleAcceptInvitation(invite)}
        onAddWorkspace={handleAddWorkspace}
        onClose={closeMenu}
        onSelect={handleSelect}
        open={open}
        ssoProviderId={ssoProviderId}
        token={token}
        workspaces={workspaces}
      />
    </>
  )
}
