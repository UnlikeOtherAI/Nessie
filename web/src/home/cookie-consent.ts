// Where the cookie choice is kept, and why it is a cookie.
//
// It used to live only in `localStorage`, which is scoped to one origin.
// `nessie.works` and `www.nessie.works` both serve this site, so a choice made
// on one was invisible to the other and the bar came back — on a page whose
// whole subject is respecting that choice.
//
// A cookie on the registrable domain is shared by every host under it, which
// is the behaviour a person expects from a consent bar and the reason the
// banner was already calling it a cookie. `localStorage` stays as a mirror:
// cookies can be blocked outright, and a choice that survives in one of the
// two is better than a bar that reappears.
//
// Nothing here is read by a server. The cookie is set from the page, carries
// no identifier, and holds one boolean.

export const CONSENT_KEY = 'nessie-cookie-consent'

/** A year. Long enough not to nag; short enough to be a real expiry. */
const MAX_AGE_SECONDS = 365 * 24 * 60 * 60

export type Consent = { analytics: boolean }

/**
 * The domain the cookie is pinned to, so apex and `www` share one answer.
 *
 * Only the leading `www.` is stripped — deriving a registrable domain properly
 * needs the public suffix list, and guessing wrong on a multi-label suffix
 * would set a cookie the browser silently refuses. Anything without a dot
 * (`localhost`) gets no `Domain` at all, which is the only form browsers
 * accept there.
 */
const cookieDomain = (hostname: string): string | null => {
  if (!hostname.includes('.')) return null
  // An IP literal cannot carry a Domain attribute — browsers reject the whole
  // cookie rather than ignoring the one field — and a dev server on
  // 127.0.0.1 would then ask again on every reload.
  if (/^[\d.]+$/u.test(hostname)) return null
  const bare = hostname.startsWith('www.') ? hostname.slice(4) : hostname
  return bare.includes('.') ? `.${bare}` : null
}

const readCookie = (): string | null => {
  for (const part of document.cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === CONSENT_KEY) return decodeURIComponent(rest.join('='))
  }
  return null
}

const parse = (raw: string | null): Consent | null => {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object') return null
    return { analytics: (value as Consent).analytics === true }
  } catch {
    return null
  }
}

/**
 * The stored choice, or null when none has been made.
 *
 * The cookie wins: it is the one both hosts can see. A value left in
 * `localStorage` by an earlier visit still counts, so upgrading does not ask
 * anybody twice.
 */
export const readConsent = (): Consent | null => {
  try {
    const fromCookie = parse(readCookie())
    if (fromCookie) return fromCookie
  } catch {
    // document.cookie can throw in a sandboxed frame.
  }
  try {
    return parse(window.localStorage.getItem(CONSENT_KEY))
  } catch {
    return null
  }
}

export const writeConsent = (consent: Consent): void => {
  const value = encodeURIComponent(JSON.stringify(consent))
  try {
    const domain = cookieDomain(window.location.hostname)
    // `Secure` only where the page is already secure: set on http://localhost
    // the browser drops the cookie and the bar would come back every reload.
    const attributes = [
      `${CONSENT_KEY}=${value}`,
      `Max-Age=${MAX_AGE_SECONDS}`,
      'Path=/',
      'SameSite=Lax',
      ...(domain ? [`Domain=${domain}`] : []),
      ...(window.location.protocol === 'https:' ? ['Secure'] : []),
    ]
    document.cookie = attributes.join('; ')
  } catch {
    // Cookies blocked; the mirror below may still hold it.
  }
  try {
    window.localStorage.setItem(CONSENT_KEY, JSON.stringify(consent))
  } catch {
    // Both stores refused: the choice lasts for this page view only.
  }
}
