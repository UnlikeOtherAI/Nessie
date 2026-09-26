import { useLocation } from 'react-router-dom'
import { resolveRootLandingPath } from './facades/billing/checkout-return'
import { consumeDesktopPendingPath } from './lib/desktop'
import { readNativePendingPushPath } from './lib/native-shell'
import { usePhoneLayout } from './navigation/mobile-shell'
import { RedirectRoute } from './navigation/RedirectRoute'

export const RootRouteRedirect = () => {
  const { search } = useLocation()
  // The native shell can inject a notification path before the SPA starts.
  return <RedirectRoute to={resolveRootLandingPath(
    search,
    readNativePendingPushPath() ?? consumeDesktopPendingPath(),
  )} />
}

export const AgentAccessRedirect = () => {
  const { search } = useLocation()
  return <RedirectRoute to={{ pathname: '/settings/paired-agents', search }} />
}

export const SettingsRootRoute = () => {
  const phoneLayout = usePhoneLayout()
  return phoneLayout ? null : <RedirectRoute to="/settings/profile" />
}
