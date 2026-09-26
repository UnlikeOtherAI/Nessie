import { useNavigationLayout } from '../navigation/mobile-shell'
import { usePhoneNavigation } from '../layouts/admin-shell/PhoneNavigationProvider'
import { Dialog } from '../components/shared/Dialog'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { NewsContent } from '../components/features/announcements/NewsContent'

// The account menu opens the same NewsContent in a Dialog on wide screens.
// This route owns the phone's full screen and direct links on every layout.
export const NewsPage = () => {
  const layout = useNavigationLayout()
  const navigation = usePhoneNavigation()

  if (layout === 'split') {
    return (
      <Dialog
        onClose={() => navigation?.back({ fallback: '/settings' })}
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
