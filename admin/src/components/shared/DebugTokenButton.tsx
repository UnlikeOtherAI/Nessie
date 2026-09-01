import { useCallback, useMemo, useState } from 'react'
import { getBaseUrl } from '../../lib/api-client'
import { loadStoredToken } from '../../lib/storage'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { SessionDebugDialog, SessionDebugIcon } from './SessionDebugDialog'

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

// Dumps the signed-in session (token + decoded claims, plus every localStorage
// and cookie value) as pretty JSON so it can be copied and handed to an
// assistant for debugging "what I see".
type DebugTokenButtonProps = {
  variant?: 'rail' | 'menu'
}

export const DebugTokenButton = ({ variant = 'rail' }: DebugTokenButtonProps) => {
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

  const handleClose = useCallback(() => setOpen(false), [])

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
          variant === 'menu'
            ? [
                'flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left',
                'text-sm text-[color:var(--tx)] transition-colors hover:bg-[color:var(--overlay-weak)]',
              ].join(' ')
            : 'admin-rail-btn mb-[22px] border-0 bg-transparent',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]',
        ].join(' ')}
        onClick={handleOpen}
        title="Session debug"
        type="button"
      >
        {variant === 'menu' ? (
          <>
            <span>Debug</span>
            <span className="flex h-3.5 w-3.5 items-center justify-center text-[color:var(--tx3)]">
              <SessionDebugIcon />
            </span>
          </>
        ) : (
          <>
            <span className="admin-rail-btn-icon">
              <SessionDebugIcon />
            </span>
            <span className="admin-rail-btn-label">Debug</span>
          </>
        )}
      </button>

      <SessionDebugDialog
        actionLabel={copied ? 'Copied' : 'Copy to clipboard'}
        description="Token, decoded claims, localStorage and cookies. Sensitive — only share with people you trust."
        onAction={handleCopy}
        onClose={handleClose}
        open={open}
        readOnly
        selectOnFocus
        textareaLabel="Session debug JSON"
        title="Session debug"
        value={dump}
      />
    </>
  )
}
