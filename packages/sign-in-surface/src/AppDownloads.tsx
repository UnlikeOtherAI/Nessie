import { faAndroid, faApple, faLinux, faWindows } from '@fortawesome/free-brands-svg-icons'
import { faChevronDown } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useId, useState } from 'react'
import { APP_DOWNLOADS, downloadUrl } from './downloads'

const Description = ({ detail, label }: { detail: string; label: string }) => (
  <span className="signin-app-text">
    <span className="signin-app-label">{label}</span>
    <span className="signin-app-detail">{detail}</span>
  </span>
)

/**
 * The "Get the apps" block: the mobile builds on one row, the desktop builds
 * on the next. The Mac tile discloses its two architectures inline rather
 * than in a floating menu, so it works the same in the admin (which owns an
 * overlay framework) and on the landing (which has none).
 */
export const AppDownloads = () => {
  const [macOpen, setMacOpen] = useState(false)
  const macChoicesId = useId()

  return (
    <div className="signin-downloads">
      <div className="signin-divider">Get the apps</div>
      <div className="signin-apps signin-apps-mobile">
        <a className="signin-app" href={downloadUrl(APP_DOWNLOADS.android)}>
          <FontAwesomeIcon aria-hidden="true" className="signin-app-icon" icon={faAndroid} />
          <Description detail={APP_DOWNLOADS.android.detail} label={APP_DOWNLOADS.android.label} />
        </a>
        <div aria-disabled="true" className="signin-app signin-app-muted">
          <FontAwesomeIcon aria-hidden="true" className="signin-app-icon" icon={faApple} />
          <Description detail="Coming soon" label="iPhone & iPad" />
        </div>
      </div>
      <div className="signin-apps signin-apps-desktop">
        <button
          aria-controls={macChoicesId}
          aria-expanded={macOpen}
          className="signin-app signin-app-dark"
          onClick={() => setMacOpen((open) => !open)}
          type="button"
        >
          <FontAwesomeIcon aria-hidden="true" className="signin-app-icon" icon={faApple} />
          <Description detail={APP_DOWNLOADS.macAppleSilicon.detail} label="Mac" />
          <FontAwesomeIcon aria-hidden="true" className="signin-app-chevron" icon={faChevronDown} />
        </button>
        <a className="signin-app signin-app-dark" href={downloadUrl(APP_DOWNLOADS.windows)}>
          <FontAwesomeIcon aria-hidden="true" className="signin-app-icon" icon={faWindows} />
          <Description detail={APP_DOWNLOADS.windows.detail} label={APP_DOWNLOADS.windows.label} />
        </a>
        <a className="signin-app signin-app-dark" href={downloadUrl(APP_DOWNLOADS.linux)}>
          <FontAwesomeIcon aria-hidden="true" className="signin-app-icon" icon={faLinux} />
          <Description detail={APP_DOWNLOADS.linux.detail} label={APP_DOWNLOADS.linux.label} />
        </a>
      </div>
      <div
        className="signin-apps signin-apps-mobile signin-app-choices"
        hidden={!macOpen}
        id={macChoicesId}
      >
        <a className="signin-app" href={downloadUrl(APP_DOWNLOADS.macAppleSilicon)}>
          <FontAwesomeIcon aria-hidden="true" className="signin-app-icon" icon={faApple} />
          <Description detail="M1 and later" label={APP_DOWNLOADS.macAppleSilicon.detail} />
        </a>
        <a className="signin-app" href={downloadUrl(APP_DOWNLOADS.macIntel)}>
          <FontAwesomeIcon aria-hidden="true" className="signin-app-icon" icon={faApple} />
          <Description detail="Intel processors" label={APP_DOWNLOADS.macIntel.detail} />
        </a>
      </div>
    </div>
  )
}
