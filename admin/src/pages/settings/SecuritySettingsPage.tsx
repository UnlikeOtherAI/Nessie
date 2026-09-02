import { useState, type FormEvent } from 'react'
import {
  useChangePassword,
  useSessions,
} from '../../facades/auth/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { FeedbackBanner, type SettingsFeedback, SettingsPanel, type SettingsTabHostProps } from './settings-shared'
import { SectionLabel } from '../../components/primitives/SectionLabel'
import { ActiveSessionsTable } from '../../components/features/settings/ActiveSessionsTable'

const ChangePasswordCard = () => {
  const changePassword = useChangePassword()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [feedback, setFeedback] = useState<SettingsFeedback | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFeedback(null)
    if (newPassword !== confirmPassword) {
      setFeedback({ kind: 'error', message: 'New passwords do not match.' })
      return
    }
    try {
      await changePassword.mutateAsync({ currentPassword, newPassword })
      setFeedback({ kind: 'success', message: 'Password changed.' })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (error) {
      setFeedback({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Failed to change password.',
      })
    }
  }

  return (
    <section className="admin-card p-4">
      <SectionLabel>Password</SectionLabel>
      <form className="mt-4 grid max-w-sm gap-3" onSubmit={submit}>
        <label className="grid gap-1 text-sm text-[color:var(--tx2)]">
          Current password
          <input
            autoComplete="current-password"
            className="admin-input"
            onChange={(event) => setCurrentPassword(event.target.value)}
            placeholder="Current password"
            type="password"
            value={currentPassword}
          />
        </label>
        <label className="grid gap-1 text-sm text-[color:var(--tx2)]">
          New password
          <input
            autoComplete="new-password"
            className="admin-input"
            onChange={(event) => setNewPassword(event.target.value)}
            placeholder="At least 8 characters"
            type="password"
            value={newPassword}
          />
        </label>
        <label className="grid gap-1 text-sm text-[color:var(--tx2)]">
          Confirm new password
          <input
            autoComplete="new-password"
            className="admin-input"
            onChange={(event) => setConfirmPassword(event.target.value)}
            placeholder="Re-enter new password"
            type="password"
            value={confirmPassword}
          />
        </label>
        <button
          className="admin-button admin-button-primary justify-self-start disabled:cursor-not-allowed disabled:opacity-60"
          disabled={
            changePassword.isPending ||
            currentPassword.length === 0 ||
            newPassword.length < 8
          }
          type="submit"
        >
          {changePassword.isPending ? 'Saving…' : 'Change password'}
        </button>
        <FeedbackBanner feedback={feedback} />
      </form>
    </section>
  )
}

export const SecuritySettingsPage = ({ tabs }: SettingsTabHostProps) => {
  const { me } = useAuthSession()
  const { data: sessions = [], isLoading } = useSessions()

  if (!me) {
    return null
  }

  const isLocalAccount = me.auth.providerType === 'local-bootstrap'

  return (
    <SettingsPanel eyebrow="Account" title="Security">
      {tabs}
      <div className="grid w-full gap-4">
        <section className="admin-card p-4">
          <SectionLabel>Active sessions</SectionLabel>
          <div className="mt-2 text-sm text-[color:var(--tx2)]">
            Devices currently signed in to your account. Revoking a session signs
            that device out.
          </div>
          <div className="mt-4">
            <ActiveSessionsTable isLoading={isLoading} sessions={sessions} />
          </div>
        </section>

        <div className="max-w-3xl">
          {isLocalAccount ? (
            <ChangePasswordCard />
          ) : (
            <section className="admin-card p-4">
              <SectionLabel>Password</SectionLabel>
              <div className="mt-2 text-sm text-[color:var(--tx2)]">
                Your account signs in through an identity provider. Manage your
                password with that provider.
              </div>
            </section>
          )}
        </div>
      </div>
    </SettingsPanel>
  )
}
