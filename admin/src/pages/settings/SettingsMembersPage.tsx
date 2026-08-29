import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import type { UserRecord } from '../../lib/api-client'
import { UserAvatar } from '../../components/primitives/UserAvatar'
import {
  useCreateUser,
  useSetUserDeactivated,
  useUpdateUserRole,
  useUsers,
} from '../../facades/users/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import {
  PersonAgents,
  UnassignedAgents,
} from '../../components/features/members/PersonAgents'
import { buildPeopleAgentsTree } from '../../components/features/members/people-agents-tree'
import { useAgents } from '../../facades/agents/queries'
import type { AgentRecord } from '../../lib/api-client'
import {
  FeedbackBanner,
  sectionTitleClass,
  SettingsPanel,
  type SettingsFeedback,
} from './settings-shared'
import { WorkspaceMembersSection } from './WorkspaceMembersSection'

const ROLE_OPTIONS = [
  { value: 'owner', label: 'Owner' },
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
] as const

const MemberRow = ({
  isSelf,
  ownedAgents,
  user,
}: {
  isSelf: boolean
  ownedAgents: AgentRecord[]
  user: UserRecord
}) => {
  const { token } = useAuthSession()
  const updateRole = useUpdateUserRole()
  const setDeactivated = useSetUserDeactivated()
  const [error, setError] = useState<string | null>(null)
  const deactivated = Boolean(user.deactivatedAt)
  const busy = updateRole.isPending || setDeactivated.isPending

  const changeRole = async (role: string) => {
    setError(null)
    try {
      await updateRole.mutateAsync({ userId: user.id, role })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to update role')
    }
  }

  const toggleDeactivated = async () => {
    setError(null)
    try {
      await setDeactivated.mutateAsync({ userId: user.id, deactivated: !deactivated })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to update member')
    }
  }

  return (
    <div className="admin-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <UserAvatar
            avatarAttachmentId={user.avatarAttachmentId ?? undefined}
            avatarUrl={user.avatarUrl ?? undefined}
            className={deactivated ? 'opacity-60' : undefined}
            displayName={user.displayName}
            size={40}
            token={token}
            userId={user.id}
          />
          <div className="min-w-0">
            <div className="truncate font-semibold text-[color:var(--tx)]">
              {user.displayName}
              {isSelf ? <span className="ml-1 text-[color:var(--tx3)]">(You)</span> : null}
            </div>
            <div className="mt-1 truncate text-sm text-[color:var(--tx2)]">{user.email}</div>
          </div>
        </div>
        {deactivated ? (
          <span
            className={[
              'shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.16em]',
              'bg-[color:var(--warning-soft)] text-[color:var(--warning-text)]',
            ].join(' ')}
          >
            Deactivated
          </span>
        ) : null}
      </div>

      {/* This person's agents — the same nesting the UOA roster row uses. */}
      <PersonAgents agents={ownedAgents} token={token} />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          aria-label={`Role for ${user.displayName}`}
          className="admin-input admin-input-compact"
          disabled={busy}
          onChange={(event) => void changeRole(event.target.value)}
          value={user.role}
        >
          {ROLE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {isSelf ? null : (
          <button
            className="admin-button admin-button-secondary admin-button-compact"
            disabled={busy}
            onClick={() => void toggleDeactivated()}
            type="button"
          >
            {deactivated ? 'Reactivate' : 'Deactivate'}
          </button>
        )}
      </div>

      {error ? (
        <div className="mt-2 text-xs text-[color:var(--danger-text)]" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  )
}

export const SettingsMembersPage = () => {
  const { me, token } = useAuthSession()
  const roleIds = me?.user.roleIds ?? []
  const isOwner = roleIds.includes('owner')
  // On an UnlikeOtherAI session the roster and its invitations are UOA API
  // features: UOA owns membership, and Nessie holds no list to show.
  const isUoaSession = me?.auth.providerType === 'uoa'
  const canManageWorkspace = isOwner || roleIds.includes('admin')
  const { data: users = [] } = useUsers(isOwner && !isUoaSession)
  const createUser = useCreateUser()

  /*
   * A no-IdP install is the authority for its own people, so the same
   * people-and-their-agents tree renders here with local `User` rows as the
   * source instead of the UOA roster. One join, one renderer, two authoritative
   * sources — never a second implementation of the view.
   */
  const agentsQuery = useAgents({ scope: 'all' })
  const localTree = (() => {
    const agents = Array.isArray(agentsQuery.data) ? agentsQuery.data : []
    const tree = buildPeopleAgentsTree(
      users.map((user) => ({ displayName: user.displayName, uoaSub: user.id, userId: user.id })),
      agents,
    )
    return {
      agentsByUserId: new Map(
        tree.people.map((person) => [person.member.userId ?? '', person.agents]),
      ),
      tree,
    }
  })()

  const [userDisplayName, setUserDisplayName] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [userPassword, setUserPassword] = useState('')
  const [userRole, setUserRole] = useState('member')
  const [addFeedback, setAddFeedback] = useState<SettingsFeedback | null>(null)

  if (!me) {
    return null
  }

  if (isUoaSession) {
    // The roster is entitlement-scoped the way `GET /api/workspace/members` is:
    // any active member reads it, and only owners and admins get the controls
    // that mutate it (role, activation, removal, invitations) — the API refuses
    // those for anyone else, so rendering them would only produce 403s.
    return (
      <SettingsPanel eyebrow="Organization" title="Members">
        <WorkspaceMembersSection canManage={canManageWorkspace} />
      </SettingsPanel>
    )
  }

  // Members management is owner-only; non-owners are routed back to their profile.
  if (!isOwner) {
    return <Navigate to="/settings/profile" replace />
  }

  const createUserSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setAddFeedback(null)
    try {
      await createUser.mutateAsync({
        displayName: userDisplayName,
        email: userEmail,
        password: userPassword,
        role: userRole,
      })
      setUserDisplayName('')
      setUserEmail('')
      setUserPassword('')
      setUserRole('member')
      setAddFeedback({ kind: 'success', message: 'Member added.' })
    } catch (error) {
      setAddFeedback({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Failed to add member.',
      })
    }
  }

  const canAddMember =
    !createUser.isPending && userEmail.trim().length > 0 && userPassword.length >= 8

  return (
    <SettingsPanel eyebrow="Organization" title="Members">
      <div className="grid gap-4 xl:grid-cols-2">
        <section className="admin-card p-4">
          <div className={sectionTitleClass}>People</div>
          <div className="mt-4 grid gap-2">
            {users.map((user) => (
              <MemberRow
                isSelf={user.id === me.user.id}
                key={user.id}
                ownedAgents={localTree.agentsByUserId.get(user.id) ?? []}
                user={user}
              />
            ))}
          </div>
          {localTree.tree.unowned.length > 0 ? (
            <div
              className="mt-5 border-t border-[color:var(--sep)] pt-4"
              data-testid="local-unassigned-agents"
            >
              <UnassignedAgents
                agents={localTree.tree.unowned}
                emptyLabel="None"
                title="Unowned agents"
                token={token}
              />
            </div>
          ) : null}
        </section>

        <section className="admin-card p-4">
          <div className={sectionTitleClass}>Add member</div>
          <form className="mt-4 grid gap-3" onSubmit={createUserSubmit}>
            <label className="grid gap-1 text-sm text-[color:var(--tx2)]">
              Display name
              <input
                className="admin-input"
                onChange={(event) => setUserDisplayName(event.target.value)}
                placeholder="Display name"
                value={userDisplayName}
              />
            </label>
            <label className="grid gap-1 text-sm text-[color:var(--tx2)]">
              Email
              <input
                className="admin-input"
                onChange={(event) => setUserEmail(event.target.value)}
                placeholder="name@example.com"
                type="email"
                value={userEmail}
              />
            </label>
            <label className="grid gap-1 text-sm text-[color:var(--tx2)]">
              Password
              <input
                autoComplete="new-password"
                className="admin-input"
                onChange={(event) => setUserPassword(event.target.value)}
                placeholder="At least 8 characters"
                type="password"
                value={userPassword}
              />
            </label>
            <label className="grid gap-1 text-sm text-[color:var(--tx2)]">
              Role
              <select
                className="admin-input"
                onChange={(event) => setUserRole(event.target.value)}
                value={userRole}
              >
                {ROLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="admin-button admin-button-primary justify-self-start disabled:cursor-not-allowed disabled:opacity-60"
              disabled={!canAddMember}
              type="submit"
            >
              {createUser.isPending ? 'Adding…' : 'Add member'}
            </button>
            <FeedbackBanner feedback={addFeedback} />
          </form>
        </section>
      </div>
    </SettingsPanel>
  )
}
