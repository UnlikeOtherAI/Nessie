import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useBanner } from '../../../facades/announcements/hooks'

const DISMISSED_BANNER_KEY = 'nessie.announcement.dismissedRevision'

export const AnnouncementStrip = () => {
  const banner = useBanner().data
  const [dismissedRevision, setDismissedRevision] = useState<string | null>(() => {
    try { return typeof window === 'undefined' ? null : window.localStorage.getItem(DISMISSED_BANNER_KEY) }
    catch { return null }
  })
  const revision = banner?.revision

  useEffect(() => {
    if (!revision) return
    try { setDismissedRevision(window.localStorage.getItem(DISMISSED_BANNER_KEY)) }
    catch { setDismissedRevision(null) }
  }, [revision])

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === DISMISSED_BANNER_KEY) setDismissedRevision(event.newValue)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  if (!banner || dismissedRevision === banner.revision) return null

  const dismiss = () => {
    try { window.localStorage.setItem(DISMISSED_BANNER_KEY, banner.revision) } catch { /* in-memory for this tab */ }
    setDismissedRevision(banner.revision)
  }

  const label = <span className="min-w-0 flex-1 text-center">{banner.text}</span>
  const linkClass = 'announcement-strip-link min-w-0 flex-1 px-3 py-2'
  return (
    <div aria-label="Announcement" className="announcement-strip" role="region">
      {banner.linkUrl ? (
        banner.linkUrl.startsWith('/') ? (
          <Link className={linkClass} to={banner.linkUrl}>{label}</Link>
        ) : (
          <a className={linkClass} href={banner.linkUrl}>{label}</a>
        )
      ) : <div className={linkClass}>{label}</div>}
      <button
        aria-label="Dismiss announcement"
        className="announcement-strip-dismiss"
        onClick={dismiss}
        type="button"
      >×</button>
    </div>
  )
}
