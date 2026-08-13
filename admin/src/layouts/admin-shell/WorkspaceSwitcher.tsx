import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useNavigate } from 'react-router-dom'
import { faCheck, faPlus } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useAuthProviders } from '../../facades/auth/hooks'
import {
  groupWorkspacesByOrganization,
  workspacesFromMe,
  type Workspace,
} from '../../lib/workspaces'
import { useWorkspaceAvatarRevision } from '../../facades/workspace/hooks'
import { WorkspaceAvatar } from '../../components/primitives/WorkspaceAvatar'
import { startExternalSignIn } from '../../lib/external-auth'
import { isReactNativeWebView } from '../../lib/mobile-shell'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { resolveAppliedTheme, useTheme } from '../../providers/ThemeProvider'
import {
  resolveWorkspaceMenuPosition,
  type WorkspaceMenuPosition,
} from './workspace-menu-position'

type NativeWorkspaceWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void }
  __nessieToggleWorkspaceMenu?: (left?: unknown) => void
}

type WorkspaceMenuProps = {
  anchorRef: RefObject<HTMLElement | null>
  workspaces: Workspace[]
  activeTeamId: string | null
  ssoProviderId: string | null
  busy: boolean
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
  busy,
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
          'fixed z-[61] w-[260px] overflow-y-auto rounded-xl border',
          'border-[color:var(--sep)] bg-[color:var(--panel)] p-1.5',
          'shadow-[0_16px_48px_var(--scrim-strong)]',
        ].join(' ')}
        style={{
          left: position.left,
          top: position.top,
          maxHeight: position.maxHeight,
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
              return (
                <button
                  aria-label={`${workspace.label}, ${organization.label}`}
                  className={[
                    'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors',
                    'hover:bg-[color:var(--overlay-weak)] disabled:opacity-60',
                  ].join(' ')}
                  disabled={busy}
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
                  {isActive ? (
                    <FontAwesomeIcon className="h-3.5 w-3.5 text-[color:var(--accent)]" icon={faCheck} />
                  ) : null}
                </button>
              )
            })}
          </section>
        ))}

        {ssoProviderId ? (
          <>
            <div className="my-1 h-px bg-[color:var(--sep)]" />
            <button
              className={[
                'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors',
                'hover:bg-[color:var(--overlay-weak)] disabled:opacity-60',
              ].join(' ')}
              disabled={busy}
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
 * Shared desktop/iPad/iPhone workspace switcher. Local sessions re-scope through
 * `switch-context`; UOA sessions use their saved directory and re-enter UOA
 * with `team_hint`, so local and signed UOA workspace scopes cannot drift.
 * The desktop rail renders the trigger; native iPad and iPhone controls open
 * this same menu. "Add a workspace" opens UOA's full chooser.
 */
type WorkspaceSwitcherProps = {
  variant?: 'native-bridge' | 'rail'
}

export const WorkspaceSwitcher = ({ variant = 'rail' }: WorkspaceSwitcherProps) => {
  const { me, switchContext, token } = useAuthSession()
  const { data: providers = [] } = useAuthProviders()
  const avatarRevision = useWorkspaceAvatarRevision()
  const { theme } = useTheme()
  const navigate = useNavigate()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const nativeAnchorRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [nativeAnchorLeft, setNativeAnchorLeft] = useState(8)

  const workspaces = useMemo(() => workspacesFromMe(me), [me])
  const activeTeamId = me?.context.teamId ?? null
  const active = workspaces.find(
    (workspace) => workspace.active || workspace.teamId === activeTeamId,
  )
  const anchorRef = variant === 'rail' ? buttonRef : nativeAnchorRef
  const ssoProviderId =
    providers.find((provider) => provider.enabled && provider.type !== 'local-bootstrap')?.providerId ??
    null

  const handleSelect = async (workspace: Workspace): Promise<void> => {
    if (workspace.active || workspace.teamId === activeTeamId) {
      setOpen(false)
      return
    }
    if (workspace.uoaWorkspace && ssoProviderId) {
      setOpen(false)
      void startExternalSignIn(
        ssoProviderId,
        resolveAppliedTheme(theme),
        workspace.teamId,
      )
      return
    }
    setBusy(true)
    try {
      await switchContext({
        organizationId: workspace.organizationId,
        projectId: workspace.projectId,
        teamId: workspace.teamId,
      })
      setOpen(false)
      void navigate('/channels', { replace: true })
    } finally {
      setBusy(false)
    }
  }

  const handleAddWorkspace = (providerId: string): void => {
    setOpen(false)
    void startExternalSignIn(providerId, resolveAppliedTheme(theme))
  }

  useEffect(() => {
    if (variant !== 'native-bridge' || !isReactNativeWebView()) return undefined
    const target = window as NativeWorkspaceWindow
    target.__nessieToggleWorkspaceMenu = (left?: unknown) => {
      if (typeof left === 'number' && Number.isFinite(left)) {
        setNativeAnchorLeft(Math.max(8, left))
      }
      setOpen((value) => !value)
    }
    return () => {
      delete target.__nessieToggleWorkspaceMenu
    }
  }, [variant])

  useEffect(() => {
    if (variant !== 'native-bridge' || !isReactNativeWebView()) return
    ;(window as NativeWorkspaceWindow).ReactNativeWebView?.postMessage(
      JSON.stringify({
        name: active?.label ?? null,
        type: 'nessie:workspace',
      }),
    )
  }, [active?.label, variant])

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
          onClick={() => setOpen((value) => !value)}
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
          busy={busy}
          onAddWorkspace={handleAddWorkspace}
          onClose={() => setOpen(false)}
          onSelect={handleSelect}
          ssoProviderId={ssoProviderId}
          token={token}
          workspaces={workspaces}
        />
      ) : null}
    </>
  )
}
