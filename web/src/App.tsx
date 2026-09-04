import { faAndroid, faApple, faLinux, faWindows } from '@fortawesome/free-brands-svg-icons'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { ScreenshotGallery, type Screenshot } from './ScreenshotGallery'

const loginUrl = 'https://app.nessie.works/login'
const latestReleaseDownload = 'https://github.com/UnlikeOtherAI/Nessie/releases/latest/download'

type Download = {
  asset: string
  icon: IconDefinition
  label: string
  detail: string
}

const desktopDownloads: Download[] = [
  {
    asset: 'Nessie-macOS-Apple-Silicon.dmg',
    icon: faApple,
    label: 'Mac',
    detail: 'Apple silicon',
  },
  {
    asset: 'Nessie-macOS-Intel.dmg',
    icon: faApple,
    label: 'Mac',
    detail: 'Intel',
  },
  {
    asset: 'Nessie-Windows-Setup.exe',
    icon: faWindows,
    label: 'Windows',
    detail: '64-bit',
  },
  {
    asset: 'Nessie-Linux.AppImage',
    icon: faLinux,
    label: 'Linux',
    detail: 'AppImage',
  },
]

const mobileDownloads: Download[] = [
  {
    asset: 'Nessie-Android.apk',
    icon: faAndroid,
    label: 'Android',
    detail: 'APK',
  },
]

const shots: Screenshot[] = [
  {
    src: '/screenshots/nessie-assistant.png',
    alt: 'A Nessie thread where the assistant drafts an all-team note about a new expense policy.',
    caption: 'Ask in a thread. Get the draft back in one.',
  },
  {
    src: '/screenshots/nessie-actions.png',
    alt: 'The assistant confirming it posted the note to #General and scheduled a follow-up check.',
    caption: 'It posts, schedules and follows up — not just answers.',
  },
  {
    src: '/screenshots/nessie-channel.png',
    alt: 'The #General channel in Nessie showing the published expense policy note.',
    caption: 'Channels, threads and DMs your team already knows.',
  },
]

function DownloadButton({ download }: { download: Download }) {
  return (
    <a className="download-button" href={`${latestReleaseDownload}/${download.asset}`}>
      <FontAwesomeIcon aria-hidden className="download-icon" icon={download.icon} />
      <span>
        <span className="download-label">{download.label}</span>
        <span className="download-detail">{download.detail}</span>
      </span>
    </a>
  )
}

export function App() {
  return (
    <main className="page">
      <header className="hero">
        <img className="hero-logo" src="/nessie-logo.png" alt="Nessie" />
        <p className="hero-eyebrow">Private beta</p>
        <h1 className="hero-title">The Slack alternative for an AI world</h1>
        <p className="hero-lede">
          Your team and its agents in one team. Same channels, threads and DMs you already
          know — except the assistants in them can draft the note, post it to the right channel and
          set the follow-up themselves.
        </p>
        <a className="login-button" href={loginUrl}>
          Login
        </a>
        <p className="hero-note">Desktop and Android downloads are available now</p>
      </header>

      <section className="downloads" aria-labelledby="downloads-title">
        <div className="downloads-heading">
          <h2 id="downloads-title">Download Nessie</h2>
          <p>Choose the installer for your device. iPhone and iPad are coming soon.</p>
        </div>
        <div className="download-lines">
          <div aria-label="Mobile downloads" className="download-line" role="group">
            {mobileDownloads.map((download) => (
              <DownloadButton download={download} key={download.asset} />
            ))}
            <div aria-disabled="true" className="download-button download-button-disabled">
              <FontAwesomeIcon aria-hidden className="download-icon" icon={faApple} />
              <span>
                <span className="download-label">iPhone &amp; iPad</span>
                <span className="download-detail">Coming soon</span>
              </span>
            </div>
          </div>
          <div aria-label="Desktop downloads" className="download-line" role="group">
            {desktopDownloads.map((download) => (
              <DownloadButton download={download} key={download.asset} />
            ))}
          </div>
        </div>
      </section>

      <section className="shots" aria-label="Screenshots of Nessie">
        <ScreenshotGallery shots={shots} />
      </section>

      <footer className="page-footer">
        <p>© {new Date().getFullYear()} Nessie</p>
      </footer>
    </main>
  )
}
