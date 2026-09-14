import { faBars, faChevronDown, faMagnifyingGlass, faXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useEffect, useState } from 'react'
import { cookieCopy, navItems, signInUrl } from './content'
import { Button, openCookieEvent } from './ui'
import { HangingWave } from './wave'

export function Header() {
  const [open, setOpen] = useState(false)
  return (
    <header className="n-header">
      <div className="n-header-inner">
        <a className="n-brand" href="#top">
          <img alt="" src="/nessie-mark.svg" />
          nessie
        </a>
        <nav aria-label="Main" className={open ? 'n-nav n-nav-open' : 'n-nav'}>
          {navItems.map((item) => (
            <a href={item.href} key={item.label} onClick={() => setOpen(false)}>
              {item.label}
              {item.menu && <FontAwesomeIcon className="n-nav-chevron" icon={faChevronDown} />}
            </a>
          ))}
        </nav>
        <div className="n-header-actions">
          <button aria-label="Search" className="n-icon-btn" type="button">
            <FontAwesomeIcon icon={faMagnifyingGlass} />
          </button>
          <a className="n-signin" href={signInUrl}>Sign in</a>
          <Button href={signInUrl}>Get started</Button>
          <button aria-label="Menu" className="n-icon-btn n-menu" onClick={() => setOpen(!open)} type="button">
            <FontAwesomeIcon icon={open ? faXmark : faBars} />
          </button>
        </div>
      </div>
      <HangingWave color="var(--n-ink)" />
    </header>
  )
}

const storageKey = 'nessie-cookie-consent'

type Consent = { analytics: boolean }

function readConsent(): Consent | null {
  try {
    const raw = window.localStorage.getItem(storageKey)
    return raw ? (JSON.parse(raw) as Consent) : null
  } catch {
    return null
  }
}

function writeConsent(consent: Consent) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(consent))
  } catch {
    // Storage is blocked; the choice lasts for this page view only.
  }
}

export function CookieBar() {
  const [open, setOpen] = useState(() => readConsent() === null)
  const [prefs, setPrefs] = useState(false)
  const [analytics, setAnalytics] = useState(() => readConsent()?.analytics ?? false)

  useEffect(() => {
    const reopen = () => {
      setOpen(true)
      setPrefs(true)
    }
    window.addEventListener(openCookieEvent, reopen)
    return () => window.removeEventListener(openCookieEvent, reopen)
  }, [])

  if (!open) return null

  const save = (consent: Consent) => {
    writeConsent(consent)
    setAnalytics(consent.analytics)
    setOpen(false)
    setPrefs(false)
  }

  return (
    <div aria-label="Cookie consent" className="n-cookie" role="dialog">
      <div className="n-cookie-body">
        <p>
          {cookieCopy.text} <a href="#cookies">{cookieCopy.policy}</a>
        </p>
        {prefs && (
          <div className="n-cookie-prefs">
            <label>
              <input checked disabled type="checkbox" />
              <span>
                <strong>Essential</strong> Needed for sign-in and security. Always on.
              </span>
            </label>
            <label>
              <input checked={analytics} onChange={(e) => setAnalytics(e.target.checked)} type="checkbox" />
              <span>
                <strong>Analytics</strong> Helps us understand which pages are useful.
              </span>
            </label>
          </div>
        )}
      </div>
      <div className="n-cookie-actions">
        {prefs ? (
          <button className="n-btn n-btn-ghost" onClick={() => save({ analytics })} type="button">
            Save choices
          </button>
        ) : (
          <button className="n-btn n-btn-ghost" onClick={() => setPrefs(true)} type="button">
            Preferences
          </button>
        )}
        <button className="n-btn n-btn-ghost" onClick={() => save({ analytics: false })} type="button">
          Reject non-essential
        </button>
        <button className="n-btn" onClick={() => save({ analytics: true })} type="button">
          Accept all
        </button>
      </div>
    </div>
  )
}
