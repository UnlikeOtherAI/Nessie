import { useState, type FormEvent } from 'react'
import {
  useChangePassword,
  useSessions,
} from '../../facades/auth/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { FeedbackBanner, type SettingsFeedback } from './FeedbackBanner'
import { SettingsPanel } from '../../components/shared/SettingsPanel'
import { KeyValueList } from '../../components/shared/KeyValueList'
import { Section } from '../../components/shared/PageBody'
import { ActiveSessionsTable } from '../../components/features/settings/ActiveSessionsTable'
import { ProgramsSignedInAsYou } from '../../components/features/paired-agents/ProgramsSignedInAsYou'

const ChangePasswordForm = () => {
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
    <form className="grid max-w-sm gap-3" onSubmit={submit}>
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
  )
}

/**
 * Everything that holds your login, on one page: the devices signed in as
 * you, the programs signed in as you, your password where Nessie keeps one,
 * and the session this device is using. Sessions and paired programs used to
 * be two pages in two places; they answer the same question.
 */
export const SecurityPage = () => {
  const { me } = useAuthSession()
  const { data: sessions = [], isLoading } = useSessions()

  if (!me) {
    return null
  }

  const isLocalAccount = me.auth.providerType === 'local-bootstrap'

  return (
    <SettingsPanel eyebrow="Your settings" title="Security">
      <div className="grid w-full gap-8">
        <Section
          description="Devices currently signed in to your account. Revoking a session signs that device out."
          title="Active sessions"
        >
          <ActiveSessionsTable isLoading={isLoading} sessions={sessions} />
        </Section>

        <ProgramsSignedInAsYou />

        <Section
          description={isLocalAccount
            ? undefined
            : 'Your account signs in through an identity provider. Manage your password with that '
              + 'provider.'}
          title="Password"
        >
          {isLocalAccount ? <ChangePasswordForm /> : null}
        </Section>

        <Section title="This device">
          <KeyValueList
            items={[
              { label: 'Session ID', mono: true, value: me.session.sessionId },
              { label: 'Issued', value: new Date(me.session.issuedAt).toLocaleString() },
              { label: 'Auto redirect', value: me.auth.autoRedirectToSso ? 'Enabled' : 'Disabled' },
            ]}
          />
        </Section>
      </div>
    </SettingsPanel>
  )
}
