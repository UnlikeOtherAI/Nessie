import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useChangePassword,
  useSessions,
} from '../../facades/auth/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { FeedbackBanner, type SettingsFeedback } from './FeedbackBanner'
import { SettingsPanel, type SettingsTabHostProps } from '../../components/shared/SettingsPanel'
import { SectionLabel } from '../../components/primitives/SectionLabel'
import { ActiveSessionsTable } from '../../components/features/settings/ActiveSessionsTable'

const ChangePasswordCard = () => {
  const { t } = useTranslation('settings')
  const changePassword = useChangePassword()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [feedback, setFeedback] = useState<SettingsFeedback | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFeedback(null)
    if (newPassword !== confirmPassword) {
      setFeedback({ kind: 'error', message: t('security.passwordMismatch') })
      return
    }
    try {
      await changePassword.mutateAsync({ currentPassword, newPassword })
      setFeedback({ kind: 'success', message: t('security.passwordChanged') })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (error) {
      setFeedback({
        kind: 'error',
        message: error instanceof Error ? error.message : t('security.passwordChangeFailed'),
      })
    }
  }

  return (
    <section className="admin-card p-4">
      <SectionLabel>{t('security.password')}</SectionLabel>
      <form className="mt-4 grid max-w-sm gap-3" onSubmit={submit}>
        <label className="grid gap-1 text-sm text-[color:var(--tx2)]">
          {t('security.currentPassword')}
          <input
            autoComplete="current-password"
            className="admin-input"
            onChange={(event) => setCurrentPassword(event.target.value)}
            placeholder={t('security.currentPassword')}
            type="password"
            value={currentPassword}
          />
        </label>
        <label className="grid gap-1 text-sm text-[color:var(--tx2)]">
          {t('security.newPassword')}
          <input
            autoComplete="new-password"
            className="admin-input"
            onChange={(event) => setNewPassword(event.target.value)}
            placeholder={t('security.passwordMinimum')}
            type="password"
            value={newPassword}
          />
        </label>
        <label className="grid gap-1 text-sm text-[color:var(--tx2)]">
          {t('security.confirmNewPassword')}
          <input
            autoComplete="new-password"
            className="admin-input"
            onChange={(event) => setConfirmPassword(event.target.value)}
            placeholder={t('security.confirmNewPassword')}
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
          {changePassword.isPending ? t('common.saving') : t('security.changePassword')}
        </button>
        <FeedbackBanner feedback={feedback} />
      </form>
    </section>
  )
}

export const SecuritySettingsPage = ({ tabs }: SettingsTabHostProps) => {
  const { t } = useTranslation('settings')
  const { me } = useAuthSession()
  const { data: sessions = [], isLoading } = useSessions()

  if (!me) {
    return null
  }

  const isLocalAccount = me.auth.providerType === 'local-bootstrap'

  return (
    <SettingsPanel eyebrow={t('common.user')} title={t('security.title')}>
      {tabs}
      <div className="grid w-full gap-4">
        <section className="admin-card p-4">
          <SectionLabel>{t('security.activeSessions')}</SectionLabel>
          <div className="mt-2 text-sm text-[color:var(--tx2)]">
            {t('security.sessionsDescription')}
          </div>
          <div className="mt-4">
            <ActiveSessionsTable isLoading={isLoading} sessions={sessions} />
          </div>
        </section>

        <div>
          {isLocalAccount ? (
            <ChangePasswordCard />
          ) : (
            <section className="admin-card p-4">
              <SectionLabel>{t('security.password')}</SectionLabel>
              <div className="mt-2 text-sm text-[color:var(--tx2)]">
                {t('security.identityProviderPassword')}
              </div>
            </section>
          )}
        </div>
      </div>
    </SettingsPanel>
  )
}
