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
  FeedbackBanner,
  sectionTitleClass,
  SettingsPanel,
  type SettingsFeedback,
} from './settings-shared'

const ROLE_OPTIONS = [
  { value: 'owner', label: 'Owner' },
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
] as const

const MemberRow = ({ user, isSelf }: { user: UserRecord; isSelf: boolean }) => {
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
            gravatarUrl={user.gravatarUrl ?? undefined}
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
  const { me } = useAuthSession()
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const { data: users = [] } = useUsers(isOwner)
  const createUser = useCreateUser()

  const [userDisplayName, setUserDisplayName] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [userPassword, setUserPassword] = useState('')
  const [userRole, setUserRole] = useState('member')
  const [addFeedback, setAddFeedback] = useState<SettingsFeedback | null>(null)

  if (!me) {
    return null
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
              <MemberRow isSelf={user.id === me.user.id} key={user.id} user={user} />
            ))}
          </div>
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
