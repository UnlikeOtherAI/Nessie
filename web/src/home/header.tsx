import { faBars, faChevronDown, faMagnifyingGlass, faXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { pagesInGroup } from '../pages/registry'
import { cookieCopy, navItems, signInUrl } from './content'
import { Button, openCookieEvent } from './ui'
import { HangingWave } from './wave'

/**
 * A homepage anchor has to work from a documentation page too, where there is
 * no `#teammates` to scroll to — so an in-page link becomes a link home to
 * that section. A router `Link` handles the rest.
 */
const NavTarget = ({ children, className, href, onClick }: {
  children: React.ReactNode
  className?: string
  href: string
  onClick?: () => void
}) => {
  if (href.startsWith('http') || href.startsWith('mailto:')) {
    return <a className={className} href={href} onClick={onClick}>{children}</a>
  }
  const to = href.startsWith('#') ? `/${href}` : href
  return <Link className={className} onClick={onClick} to={to}>{children}</Link>
}

/**
 * A top-level item that really does open something.
 *
 * The chevron used to be painted on three items that had no menu behind them
 * and simply scrolled the page — a control that says "there is more here" and
 * then does nothing when you press it. Now the chevron exists only where this
 * component does, and the panel it promises opens on click, on hover, and on
 * keyboard focus, and closes on Escape or a click outside.
 */
const NavMenu = ({ item, onNavigate }: {
  item: { href: string; label: string; menu: 'resources' | 'why' }
  onNavigate: () => void
}) => {
  const [open, setOpen] = useState(false)
  const holder = useRef<HTMLDivElement>(null)
  const entries = pagesInGroup(item.menu)

  useEffect(() => {
    if (!open) return undefined
    const away = (event: MouseEvent) => {
      if (!holder.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  return (
    <div
      className="n-nav-menu"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      ref={holder}
    >
      <button
        aria-expanded={open}
        aria-haspopup="true"
        className="n-nav-menu-trigger"
        onClick={() => setOpen(!open)}
        type="button"
      >
        {item.label}
        <FontAwesomeIcon className={open ? 'n-nav-chevron n-nav-chevron-up' : 'n-nav-chevron'} icon={faChevronDown} />
      </button>
      <div className={open ? 'n-nav-panel n-nav-panel-open' : 'n-nav-panel'}>
        {entries.map((page) => (
          <NavTarget
            className="n-nav-panel-item"
            href={page.path}
            key={page.path}
            onClick={() => { setOpen(false); onNavigate() }}
          >
            <strong>{page.navLabel ?? page.title}</strong>
            <span>{page.summary}</span>
          </NavTarget>
        ))}
      </div>
    </div>
  )
}

export function Header() {
  const [open, setOpen] = useState(false)
  return (
    <header className="n-header">
      <div className="n-header-inner">
        <Link className="n-brand" to="/">
          <img alt="" src="/nessie-mark.svg" />
          nessie
        </Link>
        <nav aria-label="Main" className={open ? 'n-nav n-nav-open' : 'n-nav'}>
          {navItems.map((item) => (
            item.menu === 'none'
              ? (
                <NavTarget href={item.href} key={item.label} onClick={() => setOpen(false)}>
                  {item.label}
                </NavTarget>
              )
              : <NavMenu item={item} key={item.label} onNavigate={() => setOpen(false)} />
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
          {cookieCopy.text} <Link to="/privacy">{cookieCopy.policy}</Link>
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
