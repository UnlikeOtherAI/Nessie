import { Navigate } from 'react-router-dom'
import { usePushStatus } from '../../facades/platform-push/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { ApnsCard } from './push/ApnsCard'
import { FcmCard } from './push/FcmCard'
import { SettingsPanel } from './settings-shared'

export const PushCredentialsPage = () => {
  const { me } = useAuthSession()
  const isSuperAdmin = me?.user.superAdmin ?? false
  const { data: status } = usePushStatus(isSuperAdmin)

  if (!me) {
    return null
  }

  // Platform push credentials are super-admin only; others go back to profile.
  if (!isSuperAdmin) {
    return <Navigate to="/settings/profile" replace />
  }

  return (
    <SettingsPanel eyebrow="Platform" title="Push credentials">
      <div className="grid gap-4 xl:grid-cols-2">
        <ApnsCard status={status?.apns} />
        <FcmCard status={status?.fcm} />
      </div>
    </SettingsPanel>
  )
}
