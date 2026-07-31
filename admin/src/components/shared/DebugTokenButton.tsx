import { useMemo, useState } from 'react'
import { getBaseUrl } from '../../lib/api-client'
import { loadStoredToken } from '../../lib/storage'
import { useAuthSession } from '../../providers/AuthSessionProvider'

// Decode the payload segment of a JWT without verifying it — purely so the
// claims (org / project / team / exp) are visible in the dump alongside the
// raw token. Never throws; returns a diagnostic object on malformed input.
const decodeJwtPayload = (token: string | null): unknown => {
  if (!token) return null
  const segment = token.split('.')[1]
  if (!segment) return { error: 'not a JWT (no payload segment)' }
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
    const json = decodeURIComponent(
      atob(base64)
        .split('')
        .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    )
    return JSON.parse(json)
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'decode failed' }
  }
}

const readLocalStorage = (): Record<string, string> => {
  const entries: Record<string, string> = {}
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key) entries[key] = localStorage.getItem(key) ?? ''
  }
  return entries
}

const readCookies = (): Record<string, string> => {
  const entries: Record<string, string> = {}
  if (!document.cookie) return entries
  for (const pair of document.cookie.split('; ')) {
    const separator = pair.indexOf('=')
    if (separator === -1) continue
    const key = pair.slice(0, separator)
    entries[key] = decodeURIComponent(pair.slice(separator + 1))
  }
  return entries
}

const BugIcon = () => (
  <svg
    aria-hidden="true"
    fill="none"
    height="20"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="2"
    viewBox="0 0 24 24"
    width="20"
  >
    <path d="m8 2 1.88 1.88" />
    <path d="M14.12 3.88 16 2" />
    <path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" />
    <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" />
    <path d="M12 20v-9" />
    <path d="M6.53 9C4.6 8.8 3 7.1 3 5" />
    <path d="M6 13H2" />
    <path d="M3 21c0-2.1 1.7-3.9 3.8-4" />
    <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4" />
    <path d="M22 13h-4" />
    <path d="M17.2 17c2.1.1 3.8 1.9 3.8 4" />
  </svg>
)

// A rail debug affordance: dumps the signed-in session (token + decoded claims,
// plus every localStorage and cookie value) as pretty JSON so it can be copied
// and handed to an assistant for debugging "what I see".
export const DebugTokenButton = () => {
  const { me } = useAuthSession()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const dump = useMemo(() => {
    if (!open) return ''
    const token = loadStoredToken()
    const payload = {
      apiBaseUrl: getBaseUrl() || window.location.origin,
      tokens: {
        accessToken: token,
        accessTokenDecoded: decodeJwtPayload(token),
        refreshToken:
          '(httpOnly cookie "nessie_refresh" — not readable by JavaScript by design)',
      },
      session: me?.session ?? null,
      context: me?.context ?? null,
      auth: me?.auth ?? null,
      user: me?.user ?? null,
      localStorage: readLocalStorage(),
      cookies: readCookies(),
    }
    return JSON.stringify(payload, null, 2)
  }, [open, me])

  const handleOpen = () => {
    setCopied(false)
    setOpen(true)
  }

  const handleClose = () => setOpen(false)

  const handleOverlayClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) handleClose()
  }

  const handleCopy = () => {
    void navigator.clipboard
      .writeText(dump)
      .then(() => setCopied(true))
      .catch(() => setCopied(false))
  }

  return (
    <>
      <button
        aria-label="Open session debug"
        className={[
          'admin-rail-btn mb-[22px] border-0 bg-transparent',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]',
        ].join(' ')}
        onClick={handleOpen}
        title="Session debug"
        type="button"
      >
        <span className="admin-rail-btn-icon">
          <BugIcon />
        </span>
        <span className="admin-rail-btn-label">Debug</span>
      </button>

      {open && (
        <div
          onClick={handleOverlayClick}
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--scrim-strong)',
            backdropFilter: 'blur(4px)',
          }}
        >
          <div className="create-channel-panel" style={{ maxWidth: 640 }}>
            <div className="create-channel-header">
              <div>
                <h2 className="text-lg font-bold text-[color:var(--tx)]">
                  Session debug
                </h2>
                <div className="text-xs text-[color:var(--tx3)]">
                  Token, decoded claims, localStorage and cookies. Sensitive —
                  only share with people you trust.
                </div>
              </div>
              <button
                className={[
                  'flex h-7 w-7 items-center justify-center',
                  'rounded text-[color:var(--tx3)]',
                  'hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
                ].join(' ')}
                onClick={handleClose}
                type="button"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path
                    d="M6 18L18 6M6 6l12 12"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>

            <textarea
              className="admin-input admin-input-mono"
              onFocus={(event) => event.currentTarget.select()}
              readOnly
              rows={16}
              style={{ resize: 'vertical', whiteSpace: 'pre', overflowWrap: 'normal' }}
              value={dump}
            />

            <div className="flex justify-end gap-2 pt-4">
              <button
                className="admin-button admin-button-secondary"
                onClick={handleClose}
                type="button"
              >
                Cancel
              </button>
              <button
                className="admin-button admin-button-primary"
                onClick={handleCopy}
                type="button"
              >
                {copied ? 'Copied' : 'Copy to clipboard'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
