import { faAndroid, faApple, faLinux, faWindows } from '@fortawesome/free-brands-svg-icons'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { faChevronDown } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useEffect, useRef, useState } from 'react'
import { ScreenshotGallery, type Screenshot } from './ScreenshotGallery'

const loginUrl = 'https://app.nessie.works/login'
const latestReleaseDownload = 'https://github.com/UnlikeOtherAI/Nessie/releases/latest/download'

type Download = {
  asset: string
  icon: IconDefinition
  label: string
  detail: string
}

type MacArchitecture = 'apple-silicon' | 'intel'

type NavigatorWithArchitectureHints = Navigator & {
  userAgentData?: {
    getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>
    platform?: string
  }
}

const macDownloads: Record<MacArchitecture, Download> = {
  'apple-silicon': {
    asset: 'Nessie-macOS-Apple-Silicon.dmg',
    icon: faApple,
    label: 'Mac',
    detail: 'Apple silicon',
  },
  intel: {
    asset: 'Nessie-macOS-Intel.dmg',
    icon: faApple,
    label: 'Mac',
    detail: 'Intel',
  },
}

const desktopDownloads: Download[] = [
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
  return <DownloadLink download={download} />
}

function DownloadLink({ download, tone = 'dark' }: { download: Download; tone?: 'dark' | 'light' }) {
  return (
    <a
      className={`download-button${tone === 'light' ? ' download-button-secondary' : ''}`}
      href={`${latestReleaseDownload}/${download.asset}`}
    >
      <FontAwesomeIcon aria-hidden className="download-icon" icon={download.icon} />
      <span>
        <span className="download-label">{download.label}</span>
        <span className="download-detail">{download.detail}</span>
      </span>
    </a>
  )
}

async function detectMacArchitecture(): Promise<MacArchitecture | null> {
  const browser = navigator as NavigatorWithArchitectureHints
  const platform = browser.userAgentData?.platform ?? navigator.platform

  if (!/mac/i.test(platform) && !navigator.userAgent.includes('Macintosh')) {
    return null
  }

  try {
    const architecture = (await browser.userAgentData?.getHighEntropyValues?.(['architecture']))
      ?.architecture
      ?.toLowerCase()

    if (architecture && /(arm|aarch64)/.test(architecture)) {
      return 'apple-silicon'
    }
    if (architecture && /(x86|intel)/.test(architecture)) {
      return 'intel'
    }
  } catch {
    // Browser privacy settings can decline high-entropy hints; keep both choices visible.
  }

  const canvas = document.createElement('canvas')
  const context = (canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl')) as
    | WebGLRenderingContext
    | WebGL2RenderingContext
    | null
  const debugInfo = context?.getExtension('WEBGL_debug_renderer_info') as
    | { UNMASKED_RENDERER_WEBGL: number }
    | null
  const renderer = debugInfo
    ? String(context?.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)).toLowerCase()
    : ''

  if (/(apple (m[0-9]|silicon|gpu))/.test(renderer)) {
    return 'apple-silicon'
  }
  if (/intel/.test(renderer)) {
    return 'intel'
  }

  return null
}

function MacDownloadControl() {
  const [architecture, setArchitecture] = useState<MacArchitecture | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  const control = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let isCurrent = true

    void detectMacArchitecture().then((detectedArchitecture) => {
      if (isCurrent) {
        setArchitecture(detectedArchitecture)
      }
    })

    return () => {
      isCurrent = false
    }
  }, [])

  useEffect(() => {
    if (!isOpen) {
      return
    }

    const closeWhenClickingAway = (event: PointerEvent) => {
      if (!control.current?.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    document.addEventListener('pointerdown', closeWhenClickingAway)
    return () => document.removeEventListener('pointerdown', closeWhenClickingAway)
  }, [isOpen])

  if (!architecture) {
    return (
      <>
        <DownloadButton download={macDownloads['apple-silicon']} />
        <DownloadButton download={macDownloads.intel} />
      </>
    )
  }

  const selectedDownload = macDownloads[architecture]
  const otherArchitecture = architecture === 'apple-silicon' ? 'intel' : 'apple-silicon'

  return (
    <div className="mac-download-control" ref={control}>
      <button
        aria-controls="mac-download-options"
        aria-expanded={isOpen}
        aria-haspopup="true"
        className="download-button download-menu-trigger"
        onClick={() => setIsOpen((open) => !open)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setIsOpen(false)
          }
        }}
        type="button"
      >
        <FontAwesomeIcon aria-hidden className="download-icon" icon={selectedDownload.icon} />
        <span>
          <span className="download-label">{selectedDownload.label}</span>
          <span className="download-detail">{selectedDownload.detail}</span>
        </span>
        <FontAwesomeIcon aria-hidden className="download-chevron" icon={faChevronDown} />
      </button>
      {isOpen ? (
        <div className="download-menu" id="mac-download-options">
          <DownloadLink download={selectedDownload} tone="light" />
          <DownloadLink download={macDownloads[otherArchitecture]} tone="light" />
        </div>
      ) : null}
    </div>
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

      <section aria-label="Downloads" className="downloads">
        <div className="download-lines">
          <div aria-label="Mobile downloads" className="download-line" role="group">
            {mobileDownloads.map((download) => (
              <DownloadLink download={download} key={download.asset} tone="light" />
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
            <MacDownloadControl />
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
