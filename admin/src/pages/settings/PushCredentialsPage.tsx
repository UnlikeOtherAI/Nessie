import { usePushStatus } from '../../facades/platform-push/hooks'
import { SuperAdminGate, useIsSuperAdmin } from '../../components/shared/SuperAdminGate'
import { ApnsCard } from './push/ApnsCard'
import { FcmCard } from './push/FcmCard'
import { SettingsPanel } from '../../components/shared/SettingsPanel'

/**
 * Advanced › Mobile push setup: the deployment's own APNs and FCM credentials.
 * Instance-wide, so it is the super-admin's; anyone else who follows a link
 * here is told so under the page's own header rather than sent elsewhere.
 */
export const PushCredentialsPage = () => {
  const isSuperAdmin = useIsSuperAdmin()
  const { data: status } = usePushStatus(isSuperAdmin)

  return (
    <SettingsPanel eyebrow="Advanced" title="Mobile push setup">
      <SuperAdminGate>
        <div className="grid gap-4 xl:grid-cols-2">
          <ApnsCard status={status?.apns} />
          <FcmCard status={status?.fcm} />
        </div>
      </SuperAdminGate>
    </SettingsPanel>
  )
}
