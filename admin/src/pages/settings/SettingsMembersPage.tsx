import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { useCreateUser, useUsers } from '../../facades/users/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { sectionTitleClass, SettingsPanel } from './settings-shared'

export const SettingsMembersPage = () => {
  const { me } = useAuthSession()
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const { data: users = [] } = useUsers(isOwner)
  const createUser = useCreateUser()

  const [userDisplayName, setUserDisplayName] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [userPassword, setUserPassword] = useState('')
  const [userRole, setUserRole] = useState('member')

  if (!me) {
    return null
  }

  // Members management is owner-only; non-owners are routed back to their profile.
  if (!isOwner) {
    return <Navigate to="/settings/profile" replace />
  }

  const createUserSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
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
  }

  return (
    <SettingsPanel eyebrow="General" title="Members">
      <div className="grid gap-4 xl:grid-cols-2">
        <section className="admin-card p-4">
          <div className={sectionTitleClass}>People</div>
          <div className="mt-4 grid gap-2">
            {users.map((user) => (
              <div key={user.id} className="admin-card p-3">
                <div className="font-semibold text-white">{user.displayName}</div>
                <div className="mt-1 text-sm text-[color:var(--tx2)]">{user.email}</div>
                <div className="mt-2 text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                  {user.role}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="admin-card p-4">
          <div className={sectionTitleClass}>Add member</div>
          <form className="mt-4 grid gap-3" onSubmit={createUserSubmit}>
            <input
              className="admin-input"
              onChange={(event) => setUserDisplayName(event.target.value)}
              placeholder="Display name"
              value={userDisplayName}
            />
            <input
              className="admin-input"
              onChange={(event) => setUserEmail(event.target.value)}
              placeholder="Email"
              type="email"
              value={userEmail}
            />
            <input
              className="admin-input"
              onChange={(event) => setUserPassword(event.target.value)}
              placeholder="Password"
              type="password"
              value={userPassword}
            />
            <select
              className="admin-input"
              onChange={(event) => setUserRole(event.target.value)}
              value={userRole}
            >
              <option value="member">Member</option>
              <option value="owner">Owner</option>
            </select>
            <button
              className="admin-button admin-button-primary justify-self-start"
              type="submit"
            >
              Add user
            </button>
          </form>
        </section>
      </div>
    </SettingsPanel>
  )
}
