import { useState, type FormEvent } from 'react'
import {
  useChangePassword,
  useRevokeSession,
  useSessions,
  type SessionSummary,
} from '../../facades/auth/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import {
  FeedbackBanner,
  sectionTitleClass,
  SettingsPanel,
  type SettingsFeedback,
} from './settings-shared'

const formatWhen = (iso: string): string => new Date(iso).toLocaleString()

const SessionRow = ({ session }: { session: SessionSummary }) => {
  const revokeSession = useRevokeSession()
  const [error, setError] = useState<string | null>(null)

  const revoke = async () => {
    setError(null)
    try {
      await revokeSession.mutateAsync(session.sessionId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to revoke session')
    }
  }

  return (
    <div className="admin-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium text-[color:var(--tx)]">
            {session.userAgent ?? 'Unknown device'}
          </div>
          <div className="mt-1 text-xs text-[color:var(--tx3)]">
            Last used {formatWhen(session.lastUsedAt)}
          </div>
        </div>
        {session.current ? (
          <span
            className={[
              'shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.16em]',
              'bg-[color:var(--accent-soft)] text-[color:var(--accent)]',
            ].join(' ')}
          >
            This device
          </span>
        ) : (
          <button
            className="admin-button admin-button-secondary h-8 shrink-0 py-0 text-sm"
            disabled={revokeSession.isPending}
            onClick={() => void revoke()}
            type="button"
          >
            Revoke
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
      <div className={sectionTitleClass}>Password</div>
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

export const SecuritySettingsPage = () => {
  const { me } = useAuthSession()
  const { data: sessions = [], isLoading } = useSessions()

  if (!me) {
    return null
  }

  const isLocalAccount = me.auth.providerType === 'local-bootstrap'

  return (
    <SettingsPanel eyebrow="Account" title="Security">
      <div className="grid max-w-3xl gap-4">
        <section className="admin-card p-4">
          <div className={sectionTitleClass}>Active sessions</div>
          <div className="mt-2 text-sm text-[color:var(--tx2)]">
            Devices currently signed in to your account. Revoking a session signs
            that device out.
          </div>
          <div className="mt-4 grid gap-2">
            {isLoading ? (
              <div className="text-sm text-[color:var(--tx3)]">Loading…</div>
            ) : sessions.length === 0 ? (
              <div className="admin-card p-3 text-sm text-[color:var(--tx3)]">
                No active sessions.
              </div>
            ) : (
              sessions.map((session) => (
                <SessionRow key={session.sessionId} session={session} />
              ))
            )}
          </div>
        </section>

        {isLocalAccount ? (
          <ChangePasswordCard />
        ) : (
          <section className="admin-card p-4">
            <div className={sectionTitleClass}>Password</div>
            <div className="mt-2 text-sm text-[color:var(--tx2)]">
              Your account signs in through an identity provider. Manage your
              password with that provider.
            </div>
          </section>
        )}
      </div>
    </SettingsPanel>
  )
}
