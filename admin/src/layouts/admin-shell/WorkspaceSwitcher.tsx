import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useNavigate } from 'react-router-dom'
import { faCheck, faPlus, faSpinner } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useAuthProviders } from '../../facades/auth/hooks'
import {
  groupWorkspacesByOrganization,
  workspacesFromMe,
  type Workspace,
} from '../../lib/workspaces'
import { useWorkspaceAvatarRevision } from '../../facades/workspace/hooks'
import { WorkspaceAvatar } from '../../components/primitives/WorkspaceAvatar'
import { startExternalSignIn, startWorkspaceSwitchReauthorization } from '../../lib/external-auth'
import { isReactNativeWebView } from '../../lib/mobile-shell'
import { IMPORTED_SESSION_SCOPE_MESSAGE } from '../../lib/imported-session-policy'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { resolveAppliedTheme, useTheme } from '../../providers/ThemeProvider'
import {
  resolveWorkspaceMenuPosition,
  type WorkspaceMenuPosition,
} from './workspace-menu-position'
import { recoverWorkspaceSwitchFailure } from './workspace-switch-recovery'
import { workspaceSwitchFailureMessage } from './workspace-switch-message'
import { useTransientMenu } from './TransientMenuContext'

type NativeWorkspaceWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void }
  __nessieToggleWorkspaceMenu?: (left?: unknown) => void
}

type WorkspaceMenuProps = {
  anchorRef: RefObject<HTMLElement | null>
  workspaces: Workspace[]
  activeTeamId: string | null
  ssoProviderId: string | null
  busyTeamId: string | null
  error: string | null
  token: string | null
  avatarRevision: number
  onSelect: (workspace: Workspace) => void
  onAddWorkspace: (providerId: string) => void
  onClose: () => void
}

const WorkspaceMenu = ({
  anchorRef,
  workspaces,
  activeTeamId,
  ssoProviderId,
  busyTeamId,
  error,
  token,
  avatarRevision,
  onSelect,
  onAddWorkspace,
  onClose,
}: WorkspaceMenuProps) => {
  const [position, setPosition] = useState<WorkspaceMenuPosition | null>(null)
  const organizations = useMemo(
    () => groupWorkspacesByOrganization(workspaces),
    [workspaces],
  )

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) {
      return
    }
    const updatePosition = () => {
      const rect = anchor.getBoundingClientRect()
      setPosition(
        resolveWorkspaceMenuPosition(rect, {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
      )
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    return () => window.removeEventListener('resize', updatePosition)
  }, [anchorRef])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  if (!position) {
    return null
  }

  return (
    <>
      <div className="fixed inset-0 z-[60]" onClick={onClose} />
      <div
        className={[
          'fixed z-[61] overflow-y-auto rounded-xl border',
          'border-[color:var(--sep)] bg-[color:var(--panel)] p-1.5',
          'shadow-[0_16px_48px_var(--scrim-strong)]',
        ].join(' ')}
        style={{
          left: position.left,
          top: position.top,
          maxHeight: position.maxHeight,
          width: position.width,
        }}
      >
        <div className="px-2 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--tx3)]">
          Workspaces
        </div>
        {organizations.map((organization, organizationIndex) => (
          <section
            className={organizationIndex > 0 ? 'mt-1 border-t border-[color:var(--sep)] pt-1' : undefined}
            key={organization.organizationId}
          >
            <div className="truncate px-2 pb-1 pt-1.5 text-[11px] font-semibold text-[color:var(--tx3)]">
              {organization.label}
            </div>
            {organization.workspaces.map((workspace) => {
              const isActive = workspace.active || workspace.teamId === activeTeamId
              const isBusy = workspace.teamId === busyTeamId
              return (
                <button
                  aria-busy={isBusy}
                  aria-label={`${workspace.label}, ${organization.label}`}
                  className={[
                    'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors',
                    'hover:bg-[color:var(--overlay-weak)] disabled:opacity-60',
                  ].join(' ')}
                  disabled={busyTeamId !== null}
                  key={workspace.teamId}
                  onClick={() => onSelect(workspace)}
                  type="button"
                >
                  <WorkspaceAvatar
                    imageUrl={workspace.avatarImageUrl}
                    label={workspace.label}
                    revision={isActive ? avatarRevision : 0}
                    size={32}
                    teamId={workspace.uoaWorkspace ? workspace.avatarTeamId ?? null : workspace.teamId}
                    token={token}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-[color:var(--tx)]">
                    {workspace.label}
                  </span>
                  {isBusy ? (
                    <FontAwesomeIcon
                      className="h-3.5 w-3.5 text-[color:var(--accent)]"
                      icon={faSpinner}
                      spin
                    />
                  ) : isActive ? (
                    <FontAwesomeIcon className="h-3.5 w-3.5 text-[color:var(--accent)]" icon={faCheck} />
                  ) : null}
                </button>
              )
            })}
          </section>
        ))}

        {error ? (
          <div
            className="mx-2 my-2 rounded-lg bg-[color:var(--danger-soft)] px-2.5 py-2 text-xs text-[color:var(--danger-text)]"
            role="alert"
          >
            {error}
          </div>
        ) : null}

        {ssoProviderId ? (
          <>
            <div className="my-1 h-px bg-[color:var(--sep)]" />
            <button
              className={[
                'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors',
                'hover:bg-[color:var(--overlay-weak)] disabled:opacity-60',
              ].join(' ')}
              disabled={busyTeamId !== null}
              onClick={() => onAddWorkspace(ssoProviderId)}
              type="button"
            >
              <span
                aria-hidden
                className={[
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                  'border border-dashed border-[color:var(--sep)] text-[color:var(--tx3)]',
                ].join(' ')}
              >
                <FontAwesomeIcon className="h-3.5 w-3.5" icon={faPlus} />
              </span>
              <span className="text-sm text-[color:var(--tx)]">Add a workspace</span>
            </button>
          </>
        ) : null}
      </div>
    </>
  )
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
  const buttonRef = useRef<HTMLButtonElement>(null)
  const nativeAnchorRef = useRef<HTMLDivElement>(null)
  const { close, isOpen: open, toggle } = useTransientMenu()
  const [busyTeamId, setBusyTeamId] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [nativeAnchorLeft, setNativeAnchorLeft] = useState(8)

  const workspaces = useMemo(() => workspacesFromMe(me), [me])
  const activeTeamId = me?.context.teamId ?? null
  const active = workspaces.find(
    (workspace) => workspace.active || workspace.teamId === activeTeamId,
  )
  const anchorRef = variant === 'native-bridge' ? nativeAnchorRef : buttonRef
  const ssoProviderId =
    providers.find((provider) => provider.enabled && provider.type !== 'local-bootstrap')?.providerId ??
    null

  const toggleMenu = (): void => {
    if (busyTeamId !== null) return
    setSwitchError(null)
    toggle()
  }

  const closeMenu = (): void => {
    if (busyTeamId === null) close()
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
  if (workspaces.length === 0 && !ssoProviderId) {
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
          <WorkspaceAvatar
            imageUrl={active?.avatarImageUrl}
            label={active?.label ?? 'Workspace'}
            revision={avatarRevision}
            size={36}
            teamId={active?.uoaWorkspace ? active.avatarTeamId ?? null : active?.teamId}
            token={token}
          />
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
      {open ? (
        <WorkspaceMenu
          activeTeamId={activeTeamId}
          anchorRef={anchorRef}
          avatarRevision={avatarRevision}
          busyTeamId={busyTeamId}
          error={switchError}
          onAddWorkspace={handleAddWorkspace}
          onClose={closeMenu}
          onSelect={handleSelect}
          ssoProviderId={ssoProviderId}
          token={token}
          workspaces={workspaces}
        />
      ) : null}
    </>
  )
}
