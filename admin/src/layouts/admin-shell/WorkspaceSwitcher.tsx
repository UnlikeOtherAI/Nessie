import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useNavigate } from 'react-router-dom'
import { faCheck, faPlus } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useAuthProviders } from '../../facades/auth/hooks'
import { getInitials } from '../../lib/avatar'
import { workspacesFromMe, type Workspace } from '../../lib/workspaces'
import { useWorkspaceAvatarRevision } from '../../facades/workspace/hooks'
import { WorkspaceAvatar } from '../../components/primitives/WorkspaceAvatar'
import { startExternalSignIn } from '../../lib/external-auth'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { resolveAppliedTheme, useTheme } from '../../providers/ThemeProvider'

type MenuPosition = { left: number; bottom: number }

type WorkspaceMenuProps = {
  anchorRef: RefObject<HTMLElement | null>
  workspaces: Workspace[]
  activeTeamId: string | null
  ssoProviderId: string | null
  busy: boolean
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
  onSelect,
  onAddWorkspace,
  onClose,
}: WorkspaceMenuProps) => {
  const [position, setPosition] = useState<MenuPosition | null>(null)

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) {
      return
    }
    const rect = anchor.getBoundingClientRect()
    setPosition({ left: rect.right + 8, bottom: window.innerHeight - rect.bottom })
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
          'fixed z-[61] max-h-[70vh] w-[260px] overflow-y-auto rounded-xl border',
          'border-[color:var(--sep)] bg-[color:var(--panel)] p-1.5',
          'shadow-[0_16px_48px_var(--scrim-strong)]',
        ].join(' ')}
        style={{ left: position.left, bottom: position.bottom }}
      >
        <div className="px-2 py-1 text-xs uppercase tracking-[0.18em] text-[color:var(--tx3)]">
          Workspaces
        </div>
        {workspaces.map((workspace) => {
          const isActive = workspace.teamId === activeTeamId
          return (
            <button
              className={[
                'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors',
                'hover:bg-[color:var(--overlay-weak)] disabled:opacity-60',
              ].join(' ')}
              disabled={busy}
              key={workspace.teamId}
              onClick={() => onSelect(workspace)}
              type="button"
            >
              <span
                aria-hidden
                className={[
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold',
                  'bg-[color:var(--overlay)] text-[color:var(--tx)]',
                ].join(' ')}
              >
                {getInitials(workspace.label, 'W')}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-[color:var(--tx)]">
                  {workspace.label}
                </span>
                {workspace.orgName ? (
                  <span className="block truncate text-xs text-[color:var(--tx3)]">
                    {workspace.orgName}
                  </span>
                ) : null}
              </span>
              {isActive ? (
                <FontAwesomeIcon className="h-3.5 w-3.5 text-[color:var(--accent)]" icon={faCheck} />
              ) : null}
            </button>
          )
        })}

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
 * Slack-style workspace switcher for the sidebar rail: lists the workspaces
 * (teams) the user belongs to and re-scopes the session to the chosen one via
 * `switch-context`. "Add a workspace" re-runs SSO so UOA's chooser appears.
 * Hidden when there is nothing to switch to and no SSO provider to add one.
 */
export const WorkspaceSwitcher = () => {
  const { me, switchContext, token } = useAuthSession()
  const { data: providers = [] } = useAuthProviders()
  const avatarRevision = useWorkspaceAvatarRevision()
  const { theme } = useTheme()
  const navigate = useNavigate()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const workspaces = useMemo(() => workspacesFromMe(me), [me])
  const activeTeamId = me?.context.teamId ?? null
  const active = workspaces.find((workspace) => workspace.teamId === activeTeamId)
  const ssoProviderId =
    providers.find((provider) => provider.enabled && provider.type !== 'local-bootstrap')?.providerId ??
    null

  // Nothing to switch to and no way to add one → don't take up rail space.
  if (workspaces.length <= 1 && !ssoProviderId) {
    return null
  }

  const handleSelect = async (workspace: Workspace): Promise<void> => {
    if (workspace.teamId === activeTeamId) {
      setOpen(false)
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

  return (
    <>
      <button
        aria-haspopup="menu"
        aria-label="Switch workspace"
        className={[
          'mb-2 flex h-9 w-9 items-center justify-center rounded-xl transition-shadow',
          open ? 'ring-2 ring-[color:var(--accent)]' : 'hover:ring-2 hover:ring-[color:var(--overlay)]',
        ].join(' ')}
        onClick={() => setOpen((value) => !value)}
        ref={buttonRef}
        title={active ? `Workspace: ${active.label}` : 'Switch workspace'}
        type="button"
      >
        {/* Only the active workspace has a company avatar to show: the relay
            serves the session's own team, so the menu rows below stay on
            initials. */}
        <WorkspaceAvatar
          label={active?.label ?? 'Workspace'}
          revision={avatarRevision}
          size={36}
          token={token}
        />
      </button>
      {open ? (
        <WorkspaceMenu
          activeTeamId={activeTeamId}
          anchorRef={buttonRef}
          busy={busy}
          onAddWorkspace={handleAddWorkspace}
          onClose={() => setOpen(false)}
          onSelect={handleSelect}
          ssoProviderId={ssoProviderId}
          workspaces={workspaces}
        />
      ) : null}
    </>
  )
}
