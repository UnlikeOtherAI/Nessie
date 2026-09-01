const TOKEN_KEY = 'nessie.admin.token'
const TOKEN_MODE_KEY = 'nessie.admin.token-mode'
const COOKIE_PREFIX = 'nessie.admin.'

export type StoredTokenMode = 'imported' | 'renewable'

export const loadStoredToken = (): string | null => localStorage.getItem(TOKEN_KEY)

export const loadStoredTokenMode = (): StoredTokenMode => {
  const token = loadStoredToken()
  const storedMode = localStorage.getItem(TOKEN_MODE_KEY)
  if (!storedMode) return 'renewable'

  try {
    const parsed = JSON.parse(storedMode) as { mode?: unknown; token?: unknown }
    if (
      parsed.token === token
      && (parsed.mode === 'imported' || parsed.mode === 'renewable')
    ) {
      return parsed.mode
    }
  } catch {
    // A partial or unknown marker must never upgrade a bearer to renewable.
  }
  return 'imported'
}

export const storeToken = (token: string, mode: StoredTokenMode = 'renewable'): void => {
  // Write a token-bound marker first. If the second write is interrupted, the
  // old bearer no longer matches and therefore reloads in fail-closed imported
  // mode; a legacy token with no marker remains renewable for upgrades.
  localStorage.setItem(TOKEN_MODE_KEY, JSON.stringify({ mode, token }))
  localStorage.setItem(TOKEN_KEY, token)
}

export const clearStoredToken = (): void => {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(TOKEN_MODE_KEY)
}

export const getCookie = (name: string): string | null => {
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${COOKIE_PREFIX}${name}=([^;]*)`)
  )
  const value = match?.[1]
  return value ? decodeURIComponent(value) : null
}

export const setCookie = (name: string, value: string, days = 365): void => {
  const expires = new Date(Date.now() + days * 864e5).toUTCString()
  document.cookie = `${COOKIE_PREFIX}${name}=${encodeURIComponent(value)}; expires=${expires}; path=/`
}
