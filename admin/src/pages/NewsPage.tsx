import { useNavigationLayout } from '../navigation/mobile-shell'
import { useLocation, useNavigate } from 'react-router-dom'
import { usePhoneNavigation } from '../layouts/admin-shell/PhoneNavigationProvider'
import { Dialog } from '../components/shared/Dialog'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { NewsContent } from '../components/features/announcements/NewsContent'

// The account menu opens the same NewsContent in a Dialog on wide screens.
// This route owns the phone's full screen and direct links on every layout.
export const NewsPage = () => {
  const layout = useNavigationLayout()
  const navigation = usePhoneNavigation()
  const location = useLocation()
  const navigate = useNavigate()
  const state = location.state
  const returnTo = state && typeof state === 'object' && 'returnTo' in state
    && typeof state.returnTo === 'string' ? state.returnTo : null

  const close = () => {
    if (navigation) navigation.back({ returnTo, fallback: '/settings' })
    else void navigate(returnTo ?? '/settings', { replace: true })
  }

  if (layout === 'split') {
    return (
      <Dialog
        onClose={close}
        open
        size="lg"
        title="News"
      >
        <NewsContent />
      </Dialog>
    )
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <ScreenHeader title="News" />
      <div className="min-h-0 flex-1 overflow-y-auto"><NewsContent /></div>
    </section>
  )
}
