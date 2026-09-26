import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useNews } from '../../../facades/announcements/hooks'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { useToasts } from '../../../providers/ToastProvider'

// A publication is one global record, so each account observes it through its
// own read marker. No per-organisation alert fan-out or duplicate DM is made.
export const NewsNotificationBridge = () => {
  const news = useNews().data
  const { me } = useAuthSession()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { pushToast } = useToasts()
  const latestSeen = useRef<string | null>(null)
  const accountId = useRef<string | null>(null)
  const initialized = useRef(false)
  const newest = news?.articles[0]

  useEffect(() => {
    if (accountId.current !== (me?.user.id ?? null)) {
      accountId.current = me?.user.id ?? null
      initialized.current = false
      latestSeen.current = null
    }
    if (!news) return
    const publication = newest ? `${newest.id}:${newest.publicationVersion}` : ''
    if (initialized.current && publication !== latestSeen.current
      && news.unreadCount > 0 && !news.notificationsMuted && pathname !== '/news') {
      pushToast({
        title: 'New in News',
        body: newest?.title ?? 'Open News from your account menu.',
        onOpen: () => navigate('/news'),
      })
    }
    initialized.current = true
    latestSeen.current = publication
  }, [me?.user.id, navigate, news, newest, pathname, pushToast])

  return null
}
